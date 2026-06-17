// 抓最新科技新聞 → AI 改寫成 3 種 Threads 草稿 → 回傳候選（不寫表，留前端）
import { getGroqClient, GROQ_MODEL } from '@/lib/groq'
import { getPostedLog, twTime } from '@/lib/news'

type Feed = { name: string; track: string; url: string }

// 候選（只活在前端，發出去才寫進發文紀錄）
export type Candidate = {
  時間: string // 新聞發布時間，台灣時間精確到小時
  類型: string
  分數: number
  標題: string
  來源: string
  原文連結: string
  圖片連結: string
  配圖: string
  摘要: string
  感性: string
  技術: string
  討論: string
}

const MAX_AGE_MS = 2 * 24 * 3600 * 1000 // 超過兩天的新聞不收

// 三類來源：AI/LLM、台灣科技、科技綜合。要加減來源改這裡。
// 順序＝優先度（前面的先填進每次抓取的上限）。官方第一手放最前面。
const FEEDS: Feed[] = [
  // 官方第一手（英文，Groq 會翻成中文草稿）
  { name: 'OpenAI 官方', track: 'AI/LLM', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google Gemini 官方', track: 'AI/LLM', url: 'https://blog.google/products/gemini/rss/' },
  // Anthropic 沒有官方 RSS，用 Google News 鎖定 Anthropic/Claude 當替代（連結會被還原成原文）
  { name: 'Anthropic 動態', track: 'AI/LLM', url: 'https://news.google.com/rss/search?q=Anthropic%20OR%20Claude%20when:2d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { name: 'Google News・AI', track: 'AI/LLM', url: 'https://news.google.com/rss/search?q=(AI%20OR%20LLM%20OR%20OpenAI%20OR%20Anthropic%20OR%20Gemini)%20when:1d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { name: 'iThome', track: '台灣科技', url: 'https://www.ithome.com.tw/rss' },
  { name: 'INSIDE', track: '台灣科技', url: 'https://www.inside.com.tw/feed' },
  { name: 'Google News・科技', track: '科技綜合', url: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { name: 'TechNews 科技新報', track: '科技綜合', url: 'https://technews.tw/feed/' },
  { name: '科技報橘', track: '科技綜合', url: 'https://buzzorange.com/techorange/feed/' },
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// Google News RSS 的連結是 news.google.com 轉址，用 batchexecute 還原成原文乾淨網址；失敗就回原值
async function resolveGoogleNews(url: string): Promise<string> {
  if (!url.includes('news.google.com')) return url
  try {
    const m = url.match(/\/articles\/([^?]+)/)
    if (!m) return url
    const id = m[1]
    const art = await fetch(`https://news.google.com/rss/articles/${id}`, {
      headers: { 'User-Agent': UA },
      cache: 'no-store',
    })
    const ah = await art.text()
    const sig = ah.match(/data-n-a-sg="([^"]+)"/)
    const ts = ah.match(/data-n-a-ts="([^"]+)"/)
    if (!sig || !ts) return url
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts[1]},"${sig[1]}"]`
    const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner]]]))
    const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body,
    })
    const txt = await r.text()
    const real = txt.match(/(https?:\/\/(?!news\.google)[^"\\]+)/)
    return real ? real[1] : url
  } catch {
    return url
  }
}

const PER_FEED = 4
const HN_LIMIT = 4
const GLOBAL_CAP = 14 // 每則要叫 Groq 生摘要+3草稿，太多會撞免費版每日 token 上限
const MIN_SCORE = 6

const SYSTEM_PROMPT = `你是 Q kangber（n8n 自動化接案 + AI 應用實踐者）的新聞小編。我會給你一則科技新聞，請判斷它對「對自動化、AI、工程有興趣的台灣讀者」有沒有分享價值，並針對它寫三種不同風格的 Threads 貼文。回傳一個 JSON 物件，鍵必須剛好是 分數、摘要、感性、技術、討論。

分數是 0 到 10 的整數，代表這則新聞的分享價值：重要、跟 AI 或自動化或工程相關、讀者會想知道的給高分；公關稿、業配、重複、無關的給低分。

摘要：用繁體中文 200 到 300 字說明這則新聞，先講發生了什麼事、再補重點細節與背景、最後帶為什麼值得關注，分 2 到 3 段寫清楚來龍去脈，讓人不點原文也能完整看懂（英文新聞也要翻成中文摘要）。

【貼文要寫得像一個有想法的真人在發 Threads，不是新聞小編在交差。三個鐵則】
1. 一定要有具體的錨點：一個明確的角度、一個真實的數字或細節、一段自己的經驗。不要空泛地講「這很重要」「值得關注」。
2. 一定要有自己的立場：敢講真話、敢吐槽、敢承認自己也不確定，不要中立到像維基百科。
3. 白話到底：像在跟朋友講話，術語一律翻成人話。

下面是「語氣」（不是主題）的示範，請學這種真實、有觀點、不做作的口吻，但內容必須扣住我給你的這則新聞：
範例一（條列知識的口吻——直、白話、敢講不討喜的真話）：「29歲的初級大人給社會新鮮人的建議：1. 防曬一定要擦 2. 一定要用牙線 …… 8. 不要神化任何人，之後你會發現大部分的成功人士其實都蠻混蛋的」
範例二（感性的口吻——從一個具體的私人錨點切入，帶出真實的時間轉折與體悟）：「幾年前拜讀張西的書，那時候特別喜歡一句話……以前覺得這行字只適用於無疾而終的人際關係。沒想到多年後，自己在做 AI 的時候，這句話會重新在腦海裡放大……」

三種貼文共同規則：繁體中文、150 到 400 字、提到 AI 時用「它」、貼文內文不要放任何網址或連結。排版符合 Threads 閱讀習慣：分成 2 到 4 個短段落、段落間空一行；emoji 整篇 0 到 2 個就好，別硬塞。
- 感性：第一人稱，從一個具體的私人錨點切入（自己的一段經驗、當下的一個感受、曾經的一個想法），再連到這則新聞，最後收一個誠實、不喊口號的體悟，像範例二那種真實的轉折感。
- 技術：挑這則新聞背後的一個技術點或名詞，用白話講給不懂的人聽，講清楚「它在解決什麼問題」而不是堆規格；帶一句自己的判斷（這招高明在哪／哪裡其實沒那麼神）。短而有料，看完真的學到一個概念。
- 討論：拋出一個有立場的看法或一個真實的兩難，引導讀者留言，結尾用一個具體的開放式問句（不要「你怎麼看？」這種空問句，要問得具體）。

嚴禁：業配腔、AI 腔、做作的比喻、硬湊的排比、為了正能量而正能量的結尾、把新聞重講一遍卻沒有自己的觀點，以及「在這個＿＿的時代」「不禁讓人深思」「值得我們關注」這類空話。

若分數低於 6，感性、技術、討論三個欄位都給空字串。只回 JSON。`

function strip(s: string): string {
  return (s || '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

type Parsed = { 標題: string; 原文連結: string; 來源: string; 類型: string; 摘要: string; 圖片連結: string; 發布時間: string }

// Hacker News：抓首頁（已被票選過、品質高、又快），給的是原文乾淨連結
async function fetchHackerNews(): Promise<Parsed[]> {
  try {
    const res = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30', {
      cache: 'no-store',
      headers: { 'User-Agent': UA },
    })
    if (!res.ok) return []
    const data = (await res.json()) as {
      hits?: Array<{ title?: string; url?: string; points?: number; created_at?: string }>
    }
    return (data.hits || [])
      .filter((h) => h.url && h.title)
      .sort((a, b) => (b.points || 0) - (a.points || 0))
      .slice(0, HN_LIMIT)
      .map((h) => ({
        標題: h.title!,
        原文連結: h.url!,
        來源: 'Hacker News',
        類型: '國際科技',
        摘要: '',
        圖片連結: '',
        發布時間: h.created_at || '',
      }))
  } catch {
    return []
  }
}

function parseFeed(xml: string, feed: Feed): Parsed[] {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || []
  const out: Parsed[] = []
  for (const b of blocks) {
    if (out.length >= PER_FEED) break
    const tM = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    let link = ''
    const lAtom = b.match(/<link[^>]*href="([^"]+)"/i)
    if (lAtom) link = lAtom[1]
    else {
      const lRss = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)
      if (lRss) link = strip(lRss[1])
    }
    const descM = b.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)
    const dM =
      b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ||
      b.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) ||
      b.match(/<published[^>]*>([\s\S]*?)<\/published>/i) ||
      b.match(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i)
    let img = ''
    const mc =
      b.match(/<media:content[^>]*url="([^"]+)"/i) ||
      b.match(/<media:thumbnail[^>]*url="([^"]+)"/i) ||
      b.match(/<enclosure[^>]*url="([^"]+\.(?:jpg|jpeg|png|webp|gif)[^"]*)"/i)
    if (mc) img = mc[1]
    if (!img) {
      const im = b.match(/<img[^>]*src="([^"]+)"/i)
      if (im) img = im[1]
    }
    img = (img || '').replace(/&amp;/g, '&').trim()
    const 標題 = strip(tM ? tM[1] : '')
    link = (link || '').trim()
    if (!標題 || !link) continue
    out.push({
      標題,
      原文連結: link,
      來源: feed.name,
      類型: feed.track,
      摘要: strip(descM ? descM[1] : '').slice(0, 600),
      圖片連結: img,
      發布時間: dM ? strip(dM[1]) : '',
    })
  }
  return out
}

// 標題相似度去重：同一則事件被不同媒體報導時只留一則
function titleGrams(t: string): Set<string> {
  const clean = t.split(' - ')[0].replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
  const grams = new Set<string>()
  for (let i = 0; i < clean.length - 1; i++) grams.add(clean.slice(i, i + 2))
  return grams
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return inter / (a.size + b.size - inter)
}
// 抓標題裡的英文專有名詞（Anthropic、Meta、Homebrew…），用來判斷同一主角
const NOUN_STOP = new Set(['news', 'http', 'https', 'www', 'com', 'html', 'yahoo', 'google'])
function properNouns(t: string): Set<string> {
  const head = t.split(' - ')[0]
  const out = new Set<string>()
  for (const m of head.matchAll(/[A-Za-z][A-Za-z0-9]{3,}/g)) {
    const w = m[0].toLowerCase()
    if (!NOUN_STOP.has(w)) out.add(w)
  }
  return out
}
function shareNoun(a: Set<string>, b: Set<string>): boolean {
  for (const w of a) if (b.has(w)) return true
  return false
}
function dedupeByTitle(items: Parsed[]): Parsed[] {
  const kept: Parsed[] = []
  const grams: Set<string>[] = []
  const nouns: Set<string>[] = []
  for (const it of items) {
    const g = titleGrams(it.標題)
    const n = properNouns(it.標題)
    const dup = grams.some((k, idx) => jaccard(g, k) > 0.45 || (n.size > 0 && shareNoun(n, nouns[idx])))
    if (dup) continue
    grams.push(g)
    nouns.push(n)
    kept.push(it)
  }
  return kept
}

type Drafts = { 分數: number; 摘要: string; 感性: string; 技術: string; 討論: string }

async function rewrite(n: Parsed): Promise<Drafts | null> {
  const client = getGroqClient()
  const completion = await client.chat.completions.create({
    model: GROQ_MODEL,
    temperature: 0.6,
    max_tokens: 1800,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `標題:${n.標題}\n來源:${n.來源}\n分類:${n.類型}\n摘要:${n.摘要}\n原文連結:${n.原文連結}`,
      },
    ],
  })
  const raw = completion.choices[0]?.message?.content ?? ''
  try {
    const r = JSON.parse(raw) as { 分數?: number; 摘要?: string; 感性?: string; 技術?: string; 討論?: string }
    return {
      分數: Number(r.分數 ?? 0),
      摘要: String(r.摘要 ?? ''),
      感性: String(r.感性 ?? ''),
      技術: String(r.技術 ?? ''),
      討論: String(r.討論 ?? ''),
    }
  } catch {
    return null
  }
}

// 兩天內才收（沒日期的當作新的留著）
function isFresh(發布時間: string): boolean {
  if (!發布時間) return true
  const t = Date.parse(發布時間)
  if (isNaN(t)) return true
  return Date.now() - t <= MAX_AGE_MS
}

// 回傳：候選（不寫表，前端拿去顯示）＋掃描數
export async function fetchNewsCandidates(): Promise<{ items: Candidate[]; scanned: number }> {
  // 去重：已經發過的原文連結不要再建議
  const posted = await getPostedLog().catch(() => [])
  const seen = new Set(posted.map((e) => e.原文連結).filter(Boolean))

  const parsed: Parsed[] = []

  // Hacker News 先抓（快、品質高、原文乾淨連結）
  for (const h of await fetchHackerNews()) {
    if (seen.has(h.原文連結) || !isFresh(h.發布時間)) continue
    seen.add(h.原文連結)
    parsed.push(h)
  }

  // 再抓 RSS
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed.url, {
        cache: 'no-store',
        headers: { 'User-Agent': 'Mozilla/5.0 (qkangber-toolbox news fetcher)' },
      })
      if (!res.ok) continue
      const xml = await res.text()
      for (const p of parseFeed(xml, feed)) {
        if (seen.has(p.原文連結) || !isFresh(p.發布時間)) continue
        seen.add(p.原文連結)
        parsed.push(p)
      }
    } catch {
      // 單一 feed 失敗就略過
    }
  }

  const picked = dedupeByTitle(parsed).slice(0, GLOBAL_CAP)
  // 把 Google News 轉址還原成原文乾淨網址（其餘來源原樣）
  const slice = await Promise.all(
    picked.map(async (p) => ({ ...p, 原文連結: await resolveGoogleNews(p.原文連結) }))
  )
  const items: Candidate[] = []
  for (const n of slice) {
    const r = await rewrite(n)
    if (!r || r.分數 < MIN_SCORE || (!r.感性 && !r.技術 && !r.討論)) continue
    const d = n.發布時間 && !isNaN(Date.parse(n.發布時間)) ? new Date(n.發布時間) : new Date()
    items.push({
      時間: twTime(d),
      類型: n.類型,
      分數: r.分數,
      標題: n.標題,
      來源: n.來源,
      原文連結: n.原文連結,
      圖片連結: n.圖片連結,
      配圖: n.圖片連結 ? '是' : '否',
      摘要: r.摘要,
      感性: r.感性,
      技術: r.技術,
      討論: r.討論,
    })
  }
  return { items, scanned: slice.length }
}
