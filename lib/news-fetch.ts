// 抓最新科技新聞 → AI 改寫成 3 種 Threads 草稿 → 回傳候選（不寫表，留前端）
// 走 lib/llm-json 的共用入口：有 OPENROUTER_API_KEY 就用 OpenRouter，沒有才退回 Groq。
// 別直接呼叫 getGroqClient——那會繞過這個切換，把請求全打在 Groq 的免費額度上（實測整輪 429）。
import { chatJSON } from '@/lib/llm-json'
import { getPostedLog, twTime } from '@/lib/news'
import { cleanStoryText } from '@/lib/hn-fetch'

// minScore／maxAgeDays 是「這個來源用不同的尺」：
// 政府補助公告不該用「分享價值」評分，時效也不是兩天（看的是申請截止日，不是發布日）。
type Feed = { name: string; track: string; url: string; minScore?: number; maxAgeDays?: number }

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
  適合改寫: boolean // 值不值得另外寫成部落格長文（原「文章靈感」分頁的判斷，併進來跟分享價值一起評）
  改寫建議: string // 適合改寫為 true 時的切角度建議；false 時是空字串
  // 三種風格的草稿不在這裡生。使用者在前端點了風格才呼叫 /api/news/draft，
  // 避免幫沒人要看的新聞先寫三篇（一篇約 1.6k token）。
}

const MAX_AGE_DAYS = 2 // 預設：超過兩天的新聞不收（單一來源可用 maxAgeDays 覆寫）

// 只收第一手：發布者自己講的，或記者自己採訪的。
// 不收純翻譯層（INSIDE／科技報橘／TechNews／Google News 聚合）——他們的稿子出處欄寫的就是下面這幾家
// （實測 2026-08-03：INSIDE 引 Reuters/The Verge/TechCrunch/Engadget，科技報橘引 The Information/FT/DeepMind），
// 等於多繞一層又慢 6-24 小時、技術細節還被磨掉。
// 順序不影響取用（interleaveBySource 是輪流取），只是分組讓人看得懂。
const FEEDS: Feed[] = [
  // —— AI 官方第一手（英文，Groq 會翻成中文草稿）——
  // 官方 blog 一週才發幾篇，兩天的窗口會讓這幾條長期回 0 則，所以一律放寬到 7 天。
  { name: 'OpenAI 官方', track: 'AI/LLM', url: 'https://openai.com/news/rss.xml', maxAgeDays: 7 },
  { name: 'Google Gemini 官方', track: 'AI/LLM', url: 'https://blog.google/products/gemini/rss/', maxAgeDays: 7 },
  { name: 'Google 官方', track: 'AI/LLM', url: 'https://blog.google/rss/', maxAgeDays: 7 },
  { name: 'Google DeepMind', track: 'AI/LLM', url: 'https://deepmind.google/blog/rss.xml', maxAgeDays: 7 },
  { name: 'Google Research', track: 'AI/LLM', url: 'https://research.google/blog/rss/', maxAgeDays: 7 },
  { name: 'NVIDIA 官方', track: 'AI/LLM', url: 'https://blogs.nvidia.com/feed/', maxAgeDays: 7 },
  { name: 'Hugging Face', track: 'AI/LLM', url: 'https://huggingface.co/blog/feed.xml', maxAgeDays: 7 },
  { name: 'AWS ML', track: 'AI/LLM', url: 'https://aws.amazon.com/blogs/machine-learning/feed/', maxAgeDays: 7 },
  { name: 'Microsoft Research', track: 'AI/LLM', url: 'https://www.microsoft.com/en-us/research/feed/', maxAgeDays: 7 },
  { name: 'Apple ML', track: 'AI/LLM', url: 'https://machinelearning.apple.com/rss.xml', maxAgeDays: 7 },
  // Anthropic 沒有 RSS（/news/rss.xml、/rss.xml、/feed.xml 都 404），改抓 /news 列表頁，見 SCRAPERS。
  // 別再用 Google News 搜「Anthropic OR Claude」代打：實測抓回來全是 TechNews／INSIDE／T客邦，
  // 等於從後門把二手媒體放回來。
  // —— 社群一手：新模型常常先在這裡被人跑過，才輪到媒體寫 ——
  { name: 'r/LocalLLaMA', track: 'AI/LLM', url: 'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=day' },
  { name: 'Simon Willison', track: 'AI/LLM', url: 'https://simonwillison.net/atom/everything/' },
  // —— 國際科技媒體：中文媒體的上游，直接接原文，不要等人翻 ——
  { name: 'TechCrunch', track: '國際科技', url: 'https://techcrunch.com/feed/' },
  { name: 'The Verge', track: '國際科技', url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'Ars Technica', track: '國際科技', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'Apple Newsroom', track: '國際科技', url: 'https://www.apple.com/newsroom/rss-feed.rss', maxAgeDays: 7 },
  // Lobsters 熱門文章改走 fetchLobstersHot（分數排序、14 天視窗，原「文章靈感」分頁的抓法），
  // 不要在這裡疊一條 lobste.rs/rss（時間排序、2 天視窗）——同一個站兩種抓法會重複打、還互搶名額。
  // —— 工程／開發一手：平台自己公告的變更。對接案的人來說「工具變了」比新聞更有用 ——
  { name: 'n8n 官方', track: '工程/開發', url: 'https://blog.n8n.io/rss/', maxAgeDays: 7 },
  { name: 'GitHub Blog', track: '工程/開發', url: 'https://github.blog/feed/', maxAgeDays: 7 },
  { name: 'GitHub 變更日誌', track: '工程/開發', url: 'https://github.blog/changelog/feed/' },
  { name: 'Cloudflare', track: '工程/開發', url: 'https://blog.cloudflare.com/rss/', maxAgeDays: 7 },
  { name: 'Vercel', track: '工程/開發', url: 'https://vercel.com/atom' },
  { name: 'Docker', track: '工程/開發', url: 'https://www.docker.com/blog/feed/', maxAgeDays: 7 },
  { name: 'Supabase', track: '工程/開發', url: 'https://supabase.com/rss.xml', maxAgeDays: 7 },
  // —— 中文一手：通訊社自家採訪、政府自己公告，中間沒有翻譯層 ——
  { name: '中央社科技', track: '台灣科技', url: 'https://feeds.feedburner.com/rsscna/technology', maxAgeDays: 3 },
  { name: 'iThome', track: '台灣科技', url: 'https://www.ithome.com.tw/rss' }, // 自家記者採訪台灣企業 IT／資安，不是編譯外電
  // 政府一手：更新以月計，兩天窗口會全部濾光；評分改用「有沒有可申請的東西」那把尺
  { name: '國科會公告', track: '政府一手', url: 'https://www.nstc.gov.tw/nstc/rss/news', minScore: 5, maxAgeDays: 14 },
  { name: '國科會新聞', track: '政府一手', url: 'https://www.nstc.gov.tw/nstc/rss/newsdata', minScore: 5, maxAgeDays: 14 },
  { name: '產業發展署', track: '政府一手', url: 'https://www.ida.gov.tw/ctlr?PRO=rss.RSSView&t=1', minScore: 5, maxAgeDays: 14 },
  // 沒接美通社（PR Newswire Asia）：確實是「企業自己發稿」的一手，
  // 但 1-1／1-2／1-3 三個頻道實測全是簡體的中國企業公關稿，對台灣讀者是錯的那種一手。
  // 沒接 arXiv：近 7 天 261 則，但那是論文摘要不是可轉發的新聞，接了只會把名額洗掉。
]

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// 任何一個上游卡住都不該賠掉整次抓取（實測正常來源都在 1.5s 內回）
const FETCH_TIMEOUT_MS = 15_000

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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const txt = await r.text()
    const real = txt.match(/(https?:\/\/(?!news\.google)[^"\\]+)/)
    return real ? real[1] : url
  } catch {
    return url
  }
}

const PER_FEED = 4
const HN_LIMIT = 6
// 兩段各有自己的上限：打分用 8B 很便宜，可以多看一點；寫草稿的 70B 才是花錢的地方。
// 以前共用一個 8 的上限，等於「排在前面的來源先填滿就結束」——HN 4 則＋OpenAI 4 則剛好吃光，
// 中文來源永遠輪不到，所以抓回來的全是英文。
// SCAN_CAP 跟來源數綁在一起：33 條來源輪流取，20 個名額等於一半的來源分不到任何一則。
const SCAN_CAP = 64 // 進第一階段打分的則數（33 條來源 × 約 2 則）
// 進第二階段寫摘要的則數。草稿移到前端點了才生之後，這段從 1800 token 縮到 500，
// 同樣的錢可以多看兩倍——所以名額從 8（閃 Groq 免費額度的舊值）開到 20。
const WRITE_CAP = 20
// 第一階段同時打幾批。Groq 的 TPM 是滾動視窗，一次噴 4 批（約 1 萬 token）容易撞上限；
// 開 2 批是把同樣的量攤平在幾秒內送完，整輪只慢幾秒。
const SCORE_CONCURRENCY = 2
const REWRITE_CONCURRENCY = 6 // 第二階段（寫摘要）同時幾則：20 則分四輪打完
const MIN_SCORE = 6

// 兩階段的省錢邏輯不在「換小模型」，而在「量」：
// 第一階段一則只產出編號＋分數（約 30 token），第二階段才寫摘要＋3 草稿（1800 token），
// 而且只有 WRITE_CAP 則走得到第二階段。模型統一交給 lib/llm-json 決定（OPENROUTER_MODEL 可覆寫）。

// 打分要整批送，不能一則一次。來源開到 33 條之後 SCAN_CAP 是 64，
// 一則一次呼叫就是 64 次請求，實測直接撞每分鐘上限（429）。整批送只要 8 次。
// 順帶好處：模型看得到同一批的其他則，有比較基準，分數才拉得開——
// 一則一則問的時候沒有基準，實測會整批都給 8 分，MIN_SCORE 等於沒作用。
const SCORE_BATCH = 8

const SCORE_PROMPT = `你是 Q kangber（n8n 自動化接案 + AI 應用實踐者）的新聞小編。我會給你一批科技新聞，每則有編號。請判斷每則對「對自動化、AI、工程有興趣的台灣讀者」有沒有分享價值。

分數是 0 到 10 的整數：重要、跟 AI 或自動化或工程相關、讀者會想知道的給高分；公關稿、業配、重複、無關的給低分。
同一批裡分數必須拉開，不可以全部給一樣的分數；如果整批都很普通，就照相對高低給 3 到 6。

一個特例，看我給的「分類」欄：分類是「政府一手」時，這是公告不是新聞，不要用話題性評。
有明確申請對象、補助金額或截止日的補助／徵件／計畫徵求給 7 分以上；純徵才職缺、內部行政、得獎名單、活動花絮給 2 分。

回傳 JSON：{"結果":[{"編號":1,"分數":8}]}
每一則都要回，編號要跟我給的一致，不可省略或合併。不要寫任何理由。只回 JSON。`

// 第二階段寫摘要＋判斷適不適合改寫成文章（原「文章靈感」分頁的 worth 判斷併過來，同一則新聞不用問兩次 AI）。
// 草稿改成前端點了才呼叫 /api/news/draft，這裡的預算才擠得出「改寫建議」這個新欄位。
const SUMMARY_PROMPT = `你是 Q kangber（n8n 自動化接案 + AI 應用實踐者）的新聞小編，同時也幫他過濾哪些新聞值得另外寫成中文部落格長文。我會給你一則科技新聞，請做兩件事：判斷它對「對自動化、AI、工程有興趣的台灣讀者」有沒有分享價值並寫摘要；再判斷它適不適合改寫成長文。回傳一個 JSON 物件，鍵必須剛好是 分數、摘要、適合改寫、改寫建議。

分數是 0 到 10 的整數，代表這則新聞的分享價值：重要、跟 AI 或自動化或工程相關、讀者會想知道的給高分；公關稿、業配、重複、無關的給低分。
特例：分類是「政府一手」時這是公告不是新聞，有明確申請對象、補助金額或截止日的給 7 分以上；純徵才、內部行政、得獎名單給 2 分。

摘要：用繁體中文 200 到 300 字說明這則新聞，先講發生了什麼事、再補重點細節與背景、最後帶為什麼值得關注，分 2 到 3 段寫清楚來龍去脈，讓人不點原文也能完整看懂（英文新聞也要翻成中文摘要）。
分類是「政府一手」時，摘要要寫清楚「誰可以申請、什麼時候截止、給多少」，這比背景重要。
不可以只把標題換句話說；我給的原始摘要很短甚至空白時，就用你對這個領域的常識補背景，但不可以編造數字、日期或引述。

適合改寫：布林值。純技術新聞（新版本發布、公司併購、募資新聞、公告）沒有觀點好切，給 false；有明確論點、方法論、或作者踩坑心得，能延伸出台灣場景對比、反方論點、實戰案例這類討論空間的，才給 true。分類是「政府一手」時一律 false。

改寫建議：一句完整的話（25 到 45 字）。適合改寫是 true 時，具體指名可以切的角度（哪個台灣場景對比、延伸哪個反方論點、補一個原文沒講的案例），不能寫「可以結合在地案例探討」這種誰套都成立的空話；適合改寫是 false 時給空字串。

只回 JSON。`

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

// 門檻＝這則要拿幾分才過稿（來源自己的尺，沒指定就用全域 MIN_SCORE）
type Parsed = {
  標題: string
  原文連結: string
  來源: string
  類型: string
  摘要: string
  圖片連結: string
  發布時間: string
  門檻?: number
}

// Hacker News：抓首頁（已被票選過、品質高、又快），給的是原文乾淨連結
async function fetchHackerNews(): Promise<Parsed[]> {
  try {
    const res = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30', {
      cache: 'no-store',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

// 原「文章靈感」分頁的兩個來源併過來：首頁排序看熱度不看主題，AI 趨勢文常常擠不進 fetchHackerNews 的前 6 則，
// 這裡直接用關鍵字搜尋、分開查每個關鍵字再合併去重（混著查會被熱門詞「AI」稀釋掉冷門但精準的詞「vibe coding」）。
const AI_KEYWORDS = ['vibe coding', 'AI agent', 'LLM', 'AI coding', 'coding agent']
const AI_LIMIT_PER_KEYWORD = 5
const AI_TOTAL_LIMIT = 16
const AI_MAX_AGE_DAYS = 14 // 這是討論熱度不是發布時間，用一般新聞的 2 天窗口會直接濾光

async function fetchAITrending(): Promise<Parsed[]> {
  const minCreatedAt = Math.floor((Date.now() - AI_MAX_AGE_DAYS * 24 * 3600 * 1000) / 1000)
  const results = await Promise.all(
    AI_KEYWORDS.map(async (keyword) => {
      const params = new URLSearchParams()
      params.set('query', keyword)
      params.set('tags', 'story')
      params.set('hitsPerPage', String(AI_LIMIT_PER_KEYWORD))
      params.set('numericFilters', `created_at_i>${minCreatedAt},points>=10`)
      try {
        const res = await fetch(`https://hn.algolia.com/api/v1/search?${params.toString()}`, {
          cache: 'no-store',
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!res.ok) return [] as Array<{ objectID: string; title?: string; url?: string | null; created_at?: string; story_text?: string | null }>
        const json = await res.json()
        return (json.hits ?? []) as Array<{ objectID: string; title?: string; url?: string | null; created_at?: string; story_text?: string | null }>
      } catch {
        return []
      }
    })
  )
  const seen = new Set<string>()
  const out: Parsed[] = []
  for (const hits of results) {
    for (const h of hits) {
      if (!h.title || seen.has(h.objectID)) continue
      seen.add(h.objectID)
      out.push({
        標題: h.title,
        原文連結: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        來源: 'HN AI關鍵字',
        類型: 'AI/LLM',
        摘要: cleanStoryText(h.story_text),
        圖片連結: '',
        發布時間: h.created_at || '',
      })
    }
  }
  return out.slice(0, AI_TOTAL_LIMIT)
}

const LOBSTERS_AI_LIMIT = 10
const LOBSTERS_HOT_LIMIT = 12

// 原「文章靈感」分頁的第三個來源：hottest 榜是分數排序，跟 lobste.rs/rss 的時間排序不同，
// 撈的是「還在被討論」的文章，不是「剛發的」；視窗跟著 AI tag 一樣放寬到 14 天。
async function fetchLobstersHot(): Promise<Parsed[]> {
  try {
    const res = await fetch('https://lobste.rs/hottest.json', {
      cache: 'no-store',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const hits = (await res.json()) as Array<{
      short_id: string
      title: string
      url?: string
      score: number
      created_at: string
      description_plain?: string
      comments_url: string
    }>
    return hits
      .filter((h) => Date.now() - new Date(h.created_at).getTime() < AI_MAX_AGE_DAYS * 24 * 3600 * 1000)
      .sort((a, b) => b.score - a.score)
      .slice(0, LOBSTERS_HOT_LIMIT)
      .map((h) => ({
        標題: h.title,
        原文連結: h.url || h.comments_url,
        來源: 'Lobsters',
        類型: '國際科技',
        摘要: strip(h.description_plain || '').slice(0, 600),
        圖片連結: '',
        發布時間: h.created_at,
      }))
  } catch {
    return []
  }
}

// Lobsters hottest 榜跟 HN 首頁一樣看熱度不看主題，AI 文章常常上不了榜，直接吃 ai/ml tag 的 feed。
async function fetchLobstersAI(): Promise<Parsed[]> {
  try {
    const res = await fetch('https://lobste.rs/t/ai,ml.json', {
      cache: 'no-store',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const hits = (await res.json()) as Array<{
      short_id: string
      title: string
      url?: string
      score: number
      created_at: string
      description_plain?: string
      comments_url: string
    }>
    return hits
      .filter((h) => Date.now() - new Date(h.created_at).getTime() < AI_MAX_AGE_DAYS * 24 * 3600 * 1000)
      .sort((a, b) => b.score - a.score)
      .slice(0, LOBSTERS_AI_LIMIT)
      .map((h) => ({
        標題: h.title,
        原文連結: h.url || h.comments_url,
        來源: 'Lobsters AI tag',
        類型: 'AI/LLM',
        摘要: strip(h.description_plain || '').slice(0, 600),
        圖片連結: '',
        發布時間: h.created_at,
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
      門檻: feed.minScore,
    })
  }
  return out
}

// 沒有 RSS 的網站：直接讀列表頁 HTML。
// 版型好幾年不動，但仍然是會壞的東西——任何一支 parse 掛掉都只讓那條回 0 則，
// 並在抓取報告的「狀態」欄現形，不會拖垮整輪。
type Scraper = Feed & { parse: (html: string, s: Scraper) => Parsed[] }

// Anthropic /news：每張卡是 <a href="/news/slug">，裡面有 <time>Jul 9, 2026</time>、
// 標題在 <h2>~<h4>（首篇跟側欄的順序不同，所以在整塊裡各找各的，不靠先後）、摘要在 <p class="body-3 serif">。
// 首篇會同時出現在 featured 與下方列表，靠 fetchNewsCandidates 的 seen（比原文連結）去重。
function parseAnthropic(html: string, s: Scraper): Parsed[] {
  const out: Parsed[] = []
  for (const raw of html.split('<a href="/news/').slice(1)) {
    if (out.length >= PER_FEED) break
    const slug = raw.match(/^([a-z0-9-]+)"/)
    if (!slug) continue
    const end = raw.indexOf('</a>')
    const b = end === -1 ? raw.slice(0, 4000) : raw.slice(0, end)
    const t = b.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/)
    if (!t) continue
    const d = b.match(/<time[^>]*>([^<]+)<\/time>/)
    const p = b.match(/<p[^>]*class="body-3[^"]*"[^>]*>([\s\S]*?)<\/p>/)
    out.push({
      標題: strip(t[1]),
      原文連結: `https://www.anthropic.com/news/${slug[1]}`,
      來源: s.name,
      類型: s.track,
      摘要: strip(p ? p[1] : ''),
      圖片連結: '',
      發布時間: d ? strip(d[1]) : '',
      門檻: s.minScore,
    })
  }
  return out
}

// 數位發展部新聞稿：每則一個 <li class="list-group-item">，
// 標題在 <a title="移至…">、日期在 <div class="listDate">YYYY-MM-DD</div>
function parseModa(html: string, s: Scraper): Parsed[] {
  const out: Parsed[] = []
  for (const b of html.split('<li class="list-group-item').slice(1)) {
    if (out.length >= PER_FEED) break
    const a = b.match(/href="(\/press\/press-releases\/\d+\.html)"[^>]*title="(?:移至)?([^"]*)"/)
    if (!a) continue
    const d = b.match(/class="listDate[^"]*"[^>]*>\s*([\d-]+)/)
    out.push({
      標題: strip(a[2]),
      原文連結: 'https://moda.gov.tw' + a[1],
      來源: s.name,
      類型: s.track,
      摘要: '',
      圖片連結: '',
      發布時間: d ? d[1].trim() : '',
      門檻: s.minScore,
    })
  }
  return out
}

const SCRAPERS: Scraper[] = [
  { name: 'Anthropic 官方', track: 'AI/LLM', url: 'https://www.anthropic.com/news', maxAgeDays: 7, parse: parseAnthropic },
  {
    name: '數位發展部',
    track: '政府一手',
    url: 'https://moda.gov.tw/press/press-releases/372.html',
    minScore: 5,
    maxAgeDays: 14,
    parse: parseModa,
  },
  // 沒接教育部青年發展署：實測兩輪都是收下 4 則、過稿 0 則。
  // 它的公告是壯遊點、志工行動、職涯競賽，不是 AI 或科技，評分每次都正確地刷掉，純粹在吃名額。
  // 青年相關的 AI 補助實際上在國科會與數發部，這兩條已經在跑。
]

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
// 要共用兩個以上專有名詞才算同一則。只共用一個詞就殺太狠：
// 「Gemini 延後、Pichai 捍衛 Google AI」跟「Alphabet 公布 Q2 財報」只因為都有 Gemini 就被當重複，
// 中文標題英文詞本來就少，這條誤殺的幾乎都是中文則。單一共用詞的情況交給 jaccard 把關。
function shareNoun(a: Set<string>, b: Set<string>): boolean {
  let n = 0
  for (const w of a) if (b.has(w) && ++n >= 2) return true
  return false
}

// 依來源輪流取，別讓排在前面的來源把名額吃光（HN 和 OpenAI 各 4 則就填滿舊的 8 格上限）
function interleaveBySource(items: Parsed[]): Parsed[] {
  const groups = new Map<string, Parsed[]>()
  for (const it of items) {
    const g = groups.get(it.來源)
    if (g) g.push(it)
    else groups.set(it.來源, [it])
  }
  const lists = [...groups.values()]
  const out: Parsed[] = []
  for (let round = 0; out.length < items.length; round++) {
    let moved = false
    for (const l of lists) {
      if (round < l.length) {
        out.push(l[round])
        moved = true
      }
    }
    if (!moved) break
  }
  return out
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

type Summary = { 分數: number; 摘要: string; 適合改寫: boolean; 改寫建議: string }

// 撞到 token 上限要讓前端講清楚，不能跟「今天沒新聞」長得一樣。
// 訊息不要寫死是哪一家：實際打的是 OpenRouter 還是 Groq，要看 OPENROUTER_API_KEY 有沒有設。
export class RateLimitError extends Error {
  constructor(public retryAfter: string) {
    super(`AI 額度暫時用完${retryAfter ? `，約 ${retryAfter} 後恢復` : '，等一下再試'}`)
    this.name = 'RateLimitError'
  }
}

function asRateLimit(e: unknown): RateLimitError | null {
  const s = String(e)
  if (!s.includes('429') && !s.includes('rate_limit')) return null
  // Groq 給的是 "30m22.176s."，去掉句點和毫秒，講成「30m22s」就好；OpenRouter 不一定會給
  const t = (s.match(/try again in ([\dhms.]+)/)?.[1] ?? '').replace(/\.$/, '').replace(/\.\d+s$/, 's')
  return new RateLimitError(t)
}

// 第一階段：整批只問分數，用小模型、max_tokens 抓很小。
// 回傳 Map(picked 的索引 → 分數)，模型漏回的那幾則就不在 Map 裡（當作 0 分）。
async function scoreBatch(batch: Parsed[], offset: number): Promise<Map<number, number>> {
  const list = batch
    // 摘要只給 100 字：打分只需要判斷「是什麼題材」，給太多會把 64 則的總 token 推去撞每分鐘上限
    .map((n, i) => `[${offset + i + 1}] 標題:${n.標題}\n來源:${n.來源}｜分類:${n.類型}\n摘要:${n.摘要.slice(0, 100)}`)
    .join('\n\n')
  // 一則只有編號＋分數，30 token 綽綽有餘
  const raw = await chatJSON(SCORE_PROMPT, list, 30 * batch.length, 0)
  const out = new Map<number, number>()
  try {
    const r = JSON.parse(raw) as {
      結果?: { 編號?: number; 分數?: number }[]
    }
    for (const row of r.結果 ?? []) {
      const idx = Number(row.編號) - 1
      // 編號要落在這一批的範圍內，否則是模型自己編的
      if (!Number.isInteger(idx) || idx < offset || idx >= offset + batch.length) continue
      out.set(idx, Number(row.分數 ?? 0))
    }
  } catch {
    // 壞 JSON：整批當作沒評到
  }
  return out
}

// 第二階段：只有過門檻的才走到這裡，寫 200-300 字摘要（貼文草稿留給前端點了才生）
async function summarize(n: Parsed): Promise<Summary | null> {
  const raw = await chatJSON(
    SUMMARY_PROMPT,
    `標題:${n.標題}\n來源:${n.來源}\n分類:${n.類型}\n摘要:${n.摘要}\n原文連結:${n.原文連結}`,
    650,
    0.5
  )
  try {
    const r = JSON.parse(raw) as { 分數?: number; 摘要?: string; 適合改寫?: boolean; 改寫建議?: string }
    return {
      分數: Number(r.分數 ?? 0),
      摘要: String(r.摘要 ?? ''),
      適合改寫: Boolean(r.適合改寫),
      改寫建議: String(r.改寫建議 ?? ''),
    }
  } catch {
    return null
  }
}

// 預設兩天內才收；政府公告那類用來源自己的窗口（沒日期的當作新的留著）
function isFresh(發布時間: string, maxAgeDays?: number): boolean {
  if (!發布時間) return true
  const t = Date.parse(發布時間)
  if (isNaN(t)) return true
  return Date.now() - t <= (maxAgeDays ?? MAX_AGE_DAYS) * 24 * 3600 * 1000
}

// 每個階段剩幾則，讓前端能講清楚「為什麼只有這幾則」。
// 來源從 9 條變 32 條之後，沒有這張表就查不出「某條是抓不到還是被時效濾光」。
export type FetchReport = {
  抓到: number
  去重後: number
  送打分: number
  低分: number // 打分低於門檻
  名額外: number // 過了門檻但沒擠進 WRITE_CAP
  來源: { 名稱: string; 收下: number; 狀態: string }[]
}

// 回傳：候選（不寫表，前端拿去顯示）＋掃描數＋各階段報告
export async function fetchNewsCandidates(): Promise<{
  items: Candidate[]
  scanned: number
  report: FetchReport
}> {
  // 兩個集合要分開，不能共用：
  //   postedUrls＝以前發過的（判斷「這則建議過了」）
  //   seen      ＝這一輪已經收進 parsed 的（避免同一輪重複收）
  // 共用同一個 Set 會出事：收進 parsed 時就把網址塞進 seen，等到下面「還原轉址後再比一次」，
  // 每一則都已經在 seen 裡了，於是整批被自己刷掉。只有 Google News 那種「還原後網址會變」的
  // 僥倖活下來——所以來源全換成一手、不再有轉址之後，這一關就會把候選清成 0 則。
  const posted = await getPostedLog().catch(() => [])
  const postedUrls = new Set(posted.map((e) => e.原文連結).filter(Boolean))
  const seen = new Set(postedUrls)
  const 來源: FetchReport['來源'] = []

  // 33 條來源一定要並行抓。原本是 for 迴圈一條一條 await，單條 timeout 15 秒，
  // 最壞情況會累積到八分鐘——前端會等到像當掉（這裡沒有 maxDuration 幫忙砍，見 route 的註解）。
  const [hn, aiHN, lobstersAI, lobstersHot, feeds, scraped] = await Promise.all([
    fetchHackerNews(),
    fetchAITrending(),
    fetchLobstersAI(),
    fetchLobstersHot(),
    Promise.all(
      FEEDS.map(async (feed) => {
        try {
          const res = await fetch(feed.url, {
            cache: 'no-store',
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })
          if (!res.ok) return { feed, items: [] as Parsed[], 狀態: `HTTP ${res.status}` }
          return { feed, items: parseFeed(await res.text(), feed), 狀態: 'ok' }
        } catch (e) {
          return { feed, items: [] as Parsed[], 狀態: `連不上（${String(e).slice(0, 40)}）` }
        }
      })
    ),
    Promise.all(
      SCRAPERS.map(async (s) => {
        try {
          const res = await fetch(s.url, {
            cache: 'no-store',
            headers: { 'User-Agent': UA },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })
          if (!res.ok) return { feed: s, items: [] as Parsed[], 狀態: `HTTP ${res.status}` }
          const items = s.parse(await res.text(), s)
          // 抓得到頁面但一則都沒解出來＝版型換了，要講出來，不要當成「今天沒新聞」
          return { feed: s, items, 狀態: items.length ? 'ok' : '版型可能已改（解不到項目）' }
        } catch (e) {
          return { feed: s, items: [] as Parsed[], 狀態: `連不上（${String(e).slice(0, 40)}）` }
        }
      })
    ),
  ])

  const parsed: Parsed[] = []
  const take = (list: Parsed[], maxAgeDays?: number) => {
    let n = 0
    for (const p of list) {
      if (seen.has(p.原文連結) || !isFresh(p.發布時間, maxAgeDays)) continue
      seen.add(p.原文連結)
      parsed.push(p)
      n++
    }
    return n
  }
  來源.push({ 名稱: 'Hacker News', 收下: take(hn), 狀態: hn.length ? 'ok' : '抓不到' })
  來源.push({ 名稱: 'HN AI關鍵字', 收下: take(aiHN, AI_MAX_AGE_DAYS), 狀態: aiHN.length ? 'ok' : '抓不到' })
  來源.push({ 名稱: 'Lobsters AI tag', 收下: take(lobstersAI, AI_MAX_AGE_DAYS), 狀態: lobstersAI.length ? 'ok' : '抓不到' })
  來源.push({ 名稱: 'Lobsters', 收下: take(lobstersHot, AI_MAX_AGE_DAYS), 狀態: lobstersHot.length ? 'ok' : '抓不到' })
  for (const f of [...feeds, ...scraped])
    來源.push({ 名稱: f.feed.name, 收下: take(f.items, f.feed.maxAgeDays), 狀態: f.狀態 })

  const deduped = dedupeByTitle(parsed)
  const picked = interleaveBySource(deduped).slice(0, SCAN_CAP)
  // 分批並行叫 Groq：一則一則排隊的話整趟要好幾分鐘，前端會等到像當掉。
  // 不一次全開是為了不撞 Groq 的每分鐘 rate limit。
  // 額度用完（429）要往外丟讓前端說清楚；其他單則失敗只丟掉那則，不賠掉整趟。
  async function inBatches<T>(
    xs: Parsed[],
    fn: (n: Parsed) => Promise<T>,
    concurrency: number
  ): Promise<(T | null)[]> {
    const out: (T | null)[] = []
    for (let i = 0; i < xs.length; i += concurrency) {
      out.push(
        ...(await Promise.all(
          xs.slice(i, i + concurrency).map((n) =>
            fn(n).catch((e) => {
              const rl = asRateLimit(e)
              if (rl) throw rl
              return null
            })
          )
        ))
      )
    }
    return out
  }

  // 第一階段：小模型整批打分，把大部分新聞在這裡就刷掉，不必付 70B 的錢。
  // 一批失敗（額度用完／壞 JSON）只丟那一批，不要整輪炸掉；429 仍然往外丟給前端說明。
  const scores = new Map<number, number>()
  const offsets: number[] = []
  for (let i = 0; i < picked.length; i += SCORE_BATCH) offsets.push(i)
  for (let i = 0; i < offsets.length; i += SCORE_CONCURRENCY) {
    const got = await Promise.all(
      offsets.slice(i, i + SCORE_CONCURRENCY).map((off) =>
        scoreBatch(picked.slice(off, off + SCORE_BATCH), off).catch((e) => {
          const rl = asRateLimit(e)
          if (rl) throw rl
          return new Map<number, number>()
        })
      )
    )
    for (const m of got) for (const [k, v] of m) scores.set(k, v)
  }
  // 過門檻的照分數排，名額憑分數搶，不是憑來源排在前面
  const passed = picked
    .map((n, i) => ({ n, s: scores.get(i) ?? 0 }))
    .filter((x) => x.s >= (x.n.門檻 ?? MIN_SCORE))
    .sort((a, b) => b.s - a.s)

  // 但純憑分數會犧牲多樣性：AI/LLM 那類天生分數高，實測 8 個名額全被它跟工程/開發吃光，
  // 政府一手（補助徵件，7 分）明明過了門檻卻一則都上不了——那正是這個工具要看的東西。
  // 所以先讓每個分類各拿一則最高分的，剩下的名額再純憑分數搶。
  const worthy: Parsed[] = []
  const taken = new Set<Parsed>()
  const seenTracks = new Set<string>()
  for (const x of passed) {
    if (worthy.length >= WRITE_CAP) break
    if (seenTracks.has(x.n.類型)) continue
    seenTracks.add(x.n.類型)
    taken.add(x.n)
    worthy.push(x.n)
  }
  for (const x of passed) {
    if (worthy.length >= WRITE_CAP) break
    if (taken.has(x.n)) continue
    taken.add(x.n)
    worthy.push(x.n)
  }

  // 把 Google News 轉址還原成原文乾淨網址（其餘來源原樣）。
  // 放在打分之後：只有真的要寫草稿的那幾則才值得多送兩個請求去還原。
  const resolved = (
    await Promise.all(worthy.map(async (n) => ({ ...n, 原文連結: await resolveGoogleNews(n.原文連結) })))
  ).filter((n) => {
    if (postedUrls.has(n.原文連結)) return false // 還原成原文網址後才認得出是「以前發過的」
    postedUrls.add(n.原文連結)
    return true
  })

  // 第二階段：只有過門檻的才寫摘要
  const written = await inBatches(resolved, summarize, REWRITE_CONCURRENCY)

  const items: Candidate[] = []
  resolved.forEach((n, i) => {
    const r = written[i]
    if (!r || r.分數 < (n.門檻 ?? MIN_SCORE) || !r.摘要) return
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
      適合改寫: r.適合改寫,
      改寫建議: r.改寫建議,
    })
  })
  return {
    items,
    scanned: picked.length,
    report: {
      抓到: parsed.length,
      去重後: deduped.length,
      送打分: picked.length,
      低分: picked.length - passed.length,
      名額外: Math.max(0, passed.length - WRITE_CAP),
      來源,
    },
  }
}
