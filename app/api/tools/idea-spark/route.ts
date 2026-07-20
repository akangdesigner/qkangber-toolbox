import { NextResponse } from 'next/server'
import { getGroqClient, GROQ_MODEL } from '@/lib/groq'

// 創業靈感雷達：抓 Hacker News 的 Show HN（獨立開發者秀自己做的產品），
// 用 AI 意譯成中文＋補一句「可以怎麼延伸」的靈感筆記。

type HNHit = {
  objectID: string
  title: string
  url: string | null
  points: number
  num_comments: number
  created_at: string
  story_text?: string | null // 作者自己在 HN 貼的介紹，官網沒 meta 時靠它
}

type Idea = {
  title: string
  titleZh: string
  note: string
  url: string
  hnUrl: string
  points: number
  comments: number
  createdAt: string
}

type CacheEntry = { data: Idea[]; expires: number }
const cache = new Map<string, CacheEntry>()
const CACHE_TTL = 30 * 60 * 1000 // 30 分鐘，避免每次刷新都重打 HN + Groq

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const META_FETCH_TIMEOUT = 3500
const MAX_HTML_BYTES = 150_000

// 只翻標題常常看不出產品在幹嘛，所以去抓官網的 meta description 當作 AI 寫說明的素材。
// 抓失敗或抓不到就回空字串，AI 會退回只憑標題推測。
async function fetchMetaDescription(url: string): Promise<string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), META_FETCH_TIMEOUT)
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA }, redirect: 'follow' })
    clearTimeout(timer)
    if (!res.ok || !res.body) return ''

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let html = ''
    let bytes = 0
    while (bytes < MAX_HTML_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      html += decoder.decode(value, { stream: true })
      if (/<\/head>/i.test(html)) break
    }
    reader.cancel().catch(() => {})

    const match =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
    if (!match) return ''
    const text = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // GitHub 的罐頭描述，留著只會讓 AI 以為產品在講 GitHub
      .replace(/Contribute to [\w.-]+\/[\w.-]+ development by creating an account on GitHub\.?/gi, '')
      .replace(/\s*-\s*[\w.-]+\/[\w.-]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length < 15 ? '' : text.slice(0, 300)
  } catch {
    return ''
  }
}

// 作者在 HN 貼文裡自己寫的介紹。官網常常沒有 meta description（個人部落格、GitHub Pages），
// 這段是補位來源，而且通常比官網文案更直白講清楚在解決什麼問題。
function cleanStoryText(raw: string | null | undefined): string {
  if (!raw) return ''
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // 開頭的招呼語（Hi HN!／Hello HN,／Hey there!）對理解產品沒幫助
    .replace(/^\s*(hi|hey|hello|greetings)[\s,!]*(hn|there|all|everyone|folks)?[\s,!—-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length < 15 ? '' : text.slice(0, 400)
}

async function fetchShowHN(query: string): Promise<HNHit[]> {
  const params = new URLSearchParams()
  params.set('tags', 'show_hn')
  params.set('hitsPerPage', '24')

  // 有關鍵字：用 search（相關性排序）。沒關鍵字：用 search_by_date + points 篩選
  // 取近期熱門——search 端點的 numericFilters 不支援 points 這個屬性，只有 search_by_date 支援。
  let endpoint = 'search'
  if (query) {
    params.set('query', query)
  } else {
    endpoint = 'search_by_date'
    const sixtyDaysAgo = Math.floor(Date.now() / 1000) - 60 * 24 * 60 * 60
    params.set('numericFilters', `points>15,created_at_i>${sixtyDaysAgo}`)
  }
  const res = await fetch(`https://hn.algolia.com/api/v1/${endpoint}?${params.toString()}`)
  if (!res.ok) throw new Error('Hacker News 抓取失敗')
  const json = await res.json()
  return (json.hits ?? []) as HNHit[]
}

// 每則的說明素材。沒素材的 titleZh 只能靠標題猜，品質較差，所以要排到後面。
type Material = { siteDesc: string; authorNote: string; hasMaterial: boolean }

async function gatherMaterials(hits: HNHit[]): Promise<Material[]> {
  const descriptions = await Promise.all(hits.map((h) => (h.url ? fetchMetaDescription(h.url) : Promise.resolve(''))))
  return hits.map((h, i) => {
    const siteDesc = descriptions[i]
    const authorNote = cleanStoryText(h.story_text)
    return { siteDesc, authorNote, hasMaterial: Boolean(siteDesc || authorNote) }
  })
}

async function translateAndAnnotate(
  hits: HNHit[],
  materials: Material[]
): Promise<{ titleZh: string; note: string }[]> {
  const client = getGroqClient()
  const list = hits
    .map((h, i) => {
      const parts = [`${i}. 標題:${h.title}`]
      if (materials[i].siteDesc) parts.push(`網站簡介:${materials[i].siteDesc}`)
      if (materials[i].authorNote) parts.push(`作者自述:${materials[i].authorNote}`)
      return parts.join('｜')
    })
    .join('\n')
  const completion = await client.chat.completions.create({
    model: GROQ_MODEL,
    max_tokens: 2500,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `你幫台灣的獨立開發者/創業者整理 Hacker News 上的 Show HN 產品清單，激發創業靈感。

對輸入的每一項，輸出：
- titleZh：用繁體中文具體說明「這個產品在做什麼、給誰用」，25–45 字，像跟朋友介紹一個東西，不是把標題直翻成新聞標題。有附「網站簡介」或「作者自述」時一定要根據那些內容寫（兩個都有就一起參考，作者自述通常更清楚講出它在解決什麼問題）；兩者都沒有才憑標題合理推測，但不要瞎掰不存在的功能或數字。
- note：一句完整的話（15–40 字），具體講「這個點子換一個場景/族群/地區會變成什麼」，不要只寫「省時省錢」「方便好用」這種空泛好處標籤

titleZh 範例（照這個具體程度寫，不要只是翻譯標題）：
- 標題 "Show HN: Bunkr – open-source file manager" ｜ 網站簡介 "Self-hosted alternative to Google Drive with end-to-end encryption" → titleZh: "可以自己架的雲端硬碟，檔案端對端加密，取代 Google Drive"

note 範例（照這個具體程度寫，不要只寫形容詞）：
- 原題 "CouponHunt – Product Hunt for Coupons" → note: "换成台灣夜市/團媽優惠券的版本，應該也有人要"
- 原題 "Self-hostable store for loyalty cards" → note: "小店家自己管會員點數不用被平台抽成，餐飲業可能買單"

只回傳 JSON object，順序要跟輸入完全一致：
{"items":[{"titleZh":"...","note":"..."}, ...]}`,
      },
      { role: 'user', content: list },
    ],
  })
  const raw = completion.choices[0]?.message?.content ?? '{}'
  const parsed = JSON.parse(raw) as { items?: { titleZh: string; note: string }[] }
  if (!parsed.items) throw new Error('AI 回傳格式錯誤')
  return parsed.items
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const query = (searchParams.get('q') ?? '').trim().slice(0, 100)
  const cacheKey = query || '__default__'

  const cached = cache.get(cacheKey)
  if (cached && cached.expires > Date.now()) {
    return NextResponse.json({ success: true, ideas: cached.data })
  }

  try {
    const hits = await fetchShowHN(query)
    if (hits.length === 0) {
      return NextResponse.json({ success: true, ideas: [] })
    }

    const materials = await gatherMaterials(hits)
    const annotations = await translateAndAnnotate(hits, materials)
    const ideas: Idea[] = hits
      .map((h, i) => {
        const hnUrl = `https://news.ycombinator.com/item?id=${h.objectID}`
        return {
          title: h.title,
          titleZh: annotations[i]?.titleZh ?? h.title,
          note: annotations[i]?.note ?? '',
          url: h.url ?? hnUrl,
          hnUrl,
          points: h.points,
          comments: h.num_comments,
          createdAt: h.created_at,
          hasMaterial: materials[i].hasMaterial,
        }
      })
      // 抓不到素材的說明是硬猜的，往後擺；同組內維持原本的排序（熱門度／時間）
      .sort((a, b) => Number(b.hasMaterial) - Number(a.hasMaterial))
      .map(({ hasMaterial: _hasMaterial, ...idea }) => idea)

    cache.set(cacheKey, { data: ideas, expires: Date.now() + CACHE_TTL })
    return NextResponse.json({ success: true, ideas })
  } catch (err) {
    const message = err instanceof Error ? err.message : '抓取失敗，請稍後再試'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
