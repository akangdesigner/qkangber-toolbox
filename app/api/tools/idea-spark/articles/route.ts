import { NextResponse } from 'next/server'
import { chatJSON } from '@/lib/llm-json'
import { fetchMetaDescription, cleanStoryText, type HNHit } from '@/lib/hn-fetch'

// 文章靈感：抓 Hacker News 首頁＋Lobsters 熱門的討論文章（不是 Show HN 產品介紹，是有觀點的評論／心得／踩坑文），
// 判斷「值不值得翻譯/改寫成中文部落格文章」＋給切角度建議。
// 動機：動區動趨這類媒體每天巡 HN 首頁，撈爆紅文章翻譯搶流量，這裡搶的是同一個時機。
// Lobsters 機制跟 HN 幾乎一樣（投票排序＋公開 JSON），但社群更小眾、還沒被媒體盯上，翻譯時機更早。

type Source = 'Hacker News' | 'Lobsters'

type SourceHit = HNHit & { source: Source; discussionUrl: string }

type Article = {
  source: Source
  title: string
  titleZh: string
  summary: string
  worth: boolean
  worthNote: string
  url: string
  discussionUrl: string
  points: number
  comments: number
  createdAt: string
}

type CacheEntry = { data: Article[]; expires: number }
let cache: CacheEntry | null = null
const CACHE_TTL = 30 * 60 * 1000 // 首頁半小時內變化不大，避免每次刷新都重打上游 + Groq

const HN_LIMIT = 12
const LOBSTERS_LIMIT = 12
// 上游偶爾會吐出舊資料（實測 lobste.rs/hottest.json 曾整批回傳 2020 年的舊聞，
// 疑似 CDN 快取卡住），這裡直接濾掉太舊的，反正這工具要的就是「還沒被翻過」的新鮮事
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

async function fetchFrontPage(): Promise<SourceHit[]> {
  const params = new URLSearchParams()
  params.set('tags', 'front_page')
  params.set('hitsPerPage', String(HN_LIMIT))
  const res = await fetch(`https://hn.algolia.com/api/v1/search?${params.toString()}`)
  if (!res.ok) throw new Error('Hacker News 抓取失敗')
  const json = await res.json()
  return ((json.hits ?? []) as HNHit[]).map((h) => ({
    ...h,
    source: 'Hacker News' as const,
    discussionUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
  }))
}

type LobstersHit = {
  short_id: string
  title: string
  url: string
  score: number
  comment_count: number
  created_at: string
  description_plain?: string
  short_id_url: string
  comments_url: string
}

async function fetchLobstersHot(): Promise<SourceHit[]> {
  const res = await fetch('https://lobste.rs/hottest.json')
  if (!res.ok) throw new Error('Lobsters 抓取失敗')
  const hits = (await res.json()) as LobstersHit[]
  return hits.slice(0, LOBSTERS_LIMIT).map((h) => ({
    objectID: h.short_id,
    title: h.title,
    url: h.url || h.comments_url,
    points: h.score,
    num_comments: h.comment_count,
    created_at: h.created_at,
    story_text: h.description_plain || null,
    source: 'Lobsters' as const,
    discussionUrl: h.comments_url || h.short_id_url,
  }))
}

// 每則的說明素材。沒素材的判斷只能靠標題猜，AI 會老實說材料不足。
type Material = { siteDesc: string; authorNote: string; hasMaterial: boolean }

async function gatherMaterials(hits: SourceHit[]): Promise<Material[]> {
  const descriptions = await Promise.all(hits.map((h) => (h.url ? fetchMetaDescription(h.url) : Promise.resolve(''))))
  return hits.map((h, i) => {
    const siteDesc = descriptions[i]
    const authorNote = cleanStoryText(h.story_text)
    return { siteDesc, authorNote, hasMaterial: Boolean(siteDesc || authorNote) }
  })
}

async function translateAndJudge(
  hits: SourceHit[],
  materials: Material[]
): Promise<{ titleZh: string; summary: string; worth: boolean; worthNote: string }[]> {
  const list = hits
    .map((h, i) => {
      const parts = [`${i}. 來源:${h.source}｜標題:${h.title}｜分數:${h.points}｜留言數:${h.num_comments}`]
      if (materials[i].siteDesc) parts.push(`網站簡介:${materials[i].siteDesc}`)
      if (materials[i].authorNote) parts.push(`內文摘錄:${materials[i].authorNote}`)
      return parts.join('｜')
    })
    .join('\n')
  const system = `你幫台灣寫技術部落格（中文讀者、偏開發者/創業者調性）的作者過濾 Hacker News 首頁＋Lobsters 熱門的討論文章。抓的是「國外討論串爆紅 → 翻譯/改寫成中文文章搶流量」這條曝光鏈的時機，所以重點不是產品介紹，是有觀點、有討論度的評論／心得／踩坑文。

對輸入的每一項，輸出：
- titleZh：15–25 字中文標題，照原文語氣翻，不要下標題黨
- summary：60–100 字摘要，講這篇文章的核心論點是什麼、作者站在什麼立場。沒有「網站簡介」或「內文摘錄」時一律留空字串，不要憑標題編造內容。
- worth：布林值，值不值得翻/寫成中文文章
- worthNote：一句完整的話（25–45 字），先給值不值得翻/寫的判斷（呼應 worth），再給具體切角度建議。

worth 判斷標準：
- 純技術新聞（新版本發布、公司併購、募資新聞）沒有觀點好切，worth: false
- 純英文圈的內部梗／時事（美國政治、特定社群八卦）台灣讀者沒共鳴，worth: false
- 有明確論點、方法論、或作者踩坑心得的文章，才 worth: true
- 沒有材料（summary 留空）判斷不了，一律 worth: false，不要用標題硬猜

切角度要具體指名，不能是空話：講清楚可以用什麼台灣場景對比、延伸哪個反方論點、或補一個原文沒講的案例；不能寫成「可以結合在地案例探討」這種誰套都成立的句子。

沒有材料（summary 留空）的項目，worthNote 就老實寫「材料不足，先點進去看內文再判斷」，不要硬掰角度。

只回傳 JSON，順序跟輸入完全一致：
{"items":[{"titleZh":"...","summary":"...","worth":true,"worthNote":"..."}, ...]}`
  // 24 則（HN 12＋Lobsters 12）中文輸出遠超單一來源的額度，不夠會被截斷成殘缺 JSON
  const raw = await chatJSON(system, list, 8000)
  try {
    const parsed = JSON.parse(raw) as {
      items?: { titleZh: string; summary: string; worth: boolean; worthNote: string }[]
    }
    return parsed.items ?? []
  } catch {
    console.error('[idea-spark/articles] AI 回傳無法解析，長度', raw.length, '結尾', raw.slice(-80))
    return []
  }
}

export async function GET() {
  if (cache && cache.expires > Date.now()) {
    return NextResponse.json({ success: true, articles: cache.data })
  }

  try {
    // 兩個來源互不依賴：一個掛了不該賠掉另一個
    const [hnHits, lobstersHits] = await Promise.all([
      fetchFrontPage().catch((err) => {
        console.error('[idea-spark/articles] Hacker News 抓取失敗', err)
        return [] as SourceHit[]
      }),
      fetchLobstersHot().catch((err) => {
        console.error('[idea-spark/articles] Lobsters 抓取失敗', err)
        return [] as SourceHit[]
      }),
    ])
    const hits = [...hnHits, ...lobstersHits].filter((h) => Date.now() - new Date(h.created_at).getTime() < MAX_AGE_MS)
    if (hits.length === 0) {
      return NextResponse.json({ success: true, articles: [] })
    }

    const materials = await gatherMaterials(hits)
    const annotations = await translateAndJudge(hits, materials)
    const articles: Article[] = hits
      .map((h, i) => ({
        source: h.source,
        title: h.title,
        titleZh: annotations[i]?.titleZh ?? h.title,
        summary: annotations[i]?.summary ?? '',
        worth: annotations[i]?.worth ?? false,
        worthNote: annotations[i]?.worthNote ?? '',
        url: h.url ?? h.discussionUrl,
        discussionUrl: h.discussionUrl,
        points: h.points,
        comments: h.num_comments,
        createdAt: h.created_at,
        hasMaterial: materials[i].hasMaterial,
      }))
      // 值得寫的排最前面；同組內抓不到素材的往後擺；再用熱度排序
      .sort((a, b) => Number(b.worth) - Number(a.worth) || Number(b.hasMaterial) - Number(a.hasMaterial) || b.points - a.points)
      .map(({ hasMaterial: _hasMaterial, ...article }) => article)

    cache = { data: articles, expires: Date.now() + CACHE_TTL }
    return NextResponse.json({ success: true, articles })
  } catch (err) {
    const message = err instanceof Error ? err.message : '抓取失敗，請稍後再試'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
