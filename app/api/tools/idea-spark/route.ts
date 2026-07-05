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

async function translateAndAnnotate(hits: HNHit[]): Promise<{ titleZh: string; note: string }[]> {
  const client = getGroqClient()
  const list = hits.map((h, i) => `${i}. ${h.title}`).join('\n')
  const completion = await client.chat.completions.create({
    model: GROQ_MODEL,
    max_tokens: 2500,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `你幫台灣的獨立開發者/創業者整理 Hacker News 上的 Show HN 產品清單，激發創業靈感。

對輸入的每一項，輸出：
- titleZh：把標題意譯成自然的繁體中文，抓住這個產品在做什麼，不要逐字直翻
- note：一句完整的話（15–40 字），具體講「這個點子換一個場景/族群/地區會變成什麼」，不要只寫「省時省錢」「方便好用」這種空泛好處標籤

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

    const annotations = await translateAndAnnotate(hits)
    const ideas: Idea[] = hits.map((h, i) => {
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
      }
    })

    cache.set(cacheKey, { data: ideas, expires: Date.now() + CACHE_TTL })
    return NextResponse.json({ success: true, ideas })
  } catch (err) {
    const message = err instanceof Error ? err.message : '抓取失敗，請稍後再試'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
