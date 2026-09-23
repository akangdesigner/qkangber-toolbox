// 抓最近一週的 AI 新聞 → 併成話題 → 用外部熱度排序 → 最熱的幾個寫摘要 → 回傳候選（不寫表，留前端）
// 走 lib/llm-json 的共用入口：有 OPENROUTER_API_KEY 就用 OpenRouter，沒有才退回 Groq。
// 別直接呼叫 getGroqClient——那會繞過這個切換，把請求全打在 Groq 的免費額度上（實測整輪 429）。
//
// 2026-09-23 改版：以前是「每則文章讓 LLM 評分享價值 → 各來源輪流分名額 → 各分類保底」，
// 對照當週真正紅的 9 個話題只上板 2 個（最熱的 Jev 被打 5-6 分、Enigma／五角大廈被來源輪流取砍掉）。
// 現在 LLM 只負責「哪些文章在講同一件事」和寫摘要，「重不重要」交給外部熱度（見 lib/news-trending）。
// 改這支之前後都要跑 scripts/news-eval.ts，看熱門話題的召回率，不要只看「抓到幾則」。
import { chatJSON, llmErrorMessage } from '@/lib/llm-json'
import { getPostedLog, twTime } from '@/lib/news'
import { cleanStoryText } from '@/lib/hn-fetch'
import { clusterTopics, rankTopics, zhCoverage, type Article, type Heat, type Topic } from '@/lib/news-trending'

type Feed = { name: string; track: string; url: string; max?: number } // max：這條收幾則，預設 PER_FEED

// 候選（只活在前端，發出去才寫進發文紀錄）。一則候選＝一個話題，連結是話題裡最像第一手的那篇。
export type Candidate = {
  時間: string // 代表文章的發布時間，台灣時間精確到小時
  類型: string
  分數: number // 熱度 0-100（欄位名沿用舊的，發文紀錄與前端都認這個）
  話題: string
  熱度明細: Heat | null // 政府公告沒有熱度（見 GOV_FEEDS），是 null
  相關文章: number // 抓到幾篇在講這件事
  截止日: string // 政府公告的申請截止日 YYYY-MM-DD；熱門話題或公告沒寫是空字串
  標題: string
  中文標題: string
  來源: string
  原文連結: string
  中文報導: { 標題: string; 連結: string } | null
  圖片連結: string
  配圖: string
  摘要: string
  適合改寫: boolean
  改寫建議: string
}

// 所有來源一律看 7 天：話題會紅一整週（Jev 9/15 發表、9/23 還是最熱），
// 兩天的窗口只看得到話題的尾巴或開頭。熱度另外由 lib/news-trending 量，這裡只負責「找到有哪些事」。
const MAX_AGE_DAYS = 7

// 來源只負責「發現話題」，排序不看來源。所以這裡要的是覆蓋面，不是純度：
// 以前為了「只收第一手」拿掉聚合來源，連帶丟掉最重要的訊號——很多地方同時在講。
const FEEDS: Feed[] = [
  // —— 熱門聚合：別人已經幫忙挑過「今天在紅什麼」——
  // The Rundown AI 是每日 AI 日報，實測 2026-09-23 標題就有 Jev、Muse、AI 放緩爭論，舊來源清單全漏
  { name: 'The Rundown AI', track: 'AI/LLM', url: 'https://rss.beehiiv.com/feeds/2R3C6Bt5wj.xml' },
  // Google News 的 AI 主流報導：只當「發現話題」用（連結是轉址，代表連結排最後，見 representative）。
  // 沒有這條的話，「AI 大廠呼籲放緩」「Gemini 測試中連上外部系統」這種主流媒體大篇幅報、工程圈來源沒寫的事整個看不到。
  { name: 'Google News AI', track: '國際科技', url: 'https://news.google.com/rss/search?q=%22artificial+intelligence%22+OR+AI+when:3d&hl=en-US&gl=US&ceid=US:en', max: 60 },
  // —— AI 官方第一手：話題的「原文連結」優先用這些 ——
  { name: 'OpenAI 官方', track: 'AI/LLM', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google Gemini 官方', track: 'AI/LLM', url: 'https://blog.google/products/gemini/rss/' },
  { name: 'Google 官方', track: 'AI/LLM', url: 'https://blog.google/rss/' },
  { name: 'Google DeepMind', track: 'AI/LLM', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'NVIDIA 官方', track: 'AI/LLM', url: 'https://blogs.nvidia.com/feed/' },
  { name: 'Hugging Face', track: 'AI/LLM', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'Microsoft Research', track: 'AI/LLM', url: 'https://www.microsoft.com/en-us/research/feed/' },
  // Anthropic 沒有 RSS，改抓 /news 列表頁，見 SCRAPERS
  // —— 社群一手 ——
  { name: 'r/LocalLLaMA', track: 'AI/LLM', url: 'https://www.reddit.com/r/LocalLLaMA/top/.rss?t=week' },
  { name: 'Simon Willison', track: 'AI/LLM', url: 'https://simonwillison.net/atom/everything/' },
  // —— 觀點：只留幾個大的。它們很少自己帶出新話題，但會跟著熱門話題寫，算進「多少地方在講」——
  // 2026-09-17 加的 18 條觀點 newsletter 砍掉大半：保底 6 個名額讓畫面塞滿冷門長文（SemiAnalysis 的 DRAM offloading），
  // 被使用者嫌「全部都不是我要的」。
  { name: 'Stratechery', track: 'AI 趨勢觀點', url: 'https://stratechery.com/feed/' },
  { name: 'Latent Space', track: 'AI 趨勢觀點', url: 'https://www.latent.space/feed' },
  { name: 'Interconnects', track: 'AI 趨勢觀點', url: 'https://www.interconnects.ai/feed' },
  { name: 'One Useful Thing', track: 'AI 趨勢觀點', url: 'https://www.oneusefulthing.org/feed' },
  { name: 'Gary Marcus', track: 'AI 趨勢觀點', url: 'https://garymarcus.substack.com/feed' },
  { name: 'MIT Tech Review AI', track: 'AI 趨勢觀點', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' },
  // —— 國際科技媒體 ——
  { name: 'TechCrunch', track: '國際科技', url: 'https://techcrunch.com/feed/' },
  { name: 'The Verge', track: '國際科技', url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'Ars Technica', track: '國際科技', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  // —— 工程／開發：平台跟進某個熱門模型（例：Vercel、Cloudflare 接上 Jev）本身就是熱度的一部分 ——
  { name: 'n8n 官方', track: '工程/開發', url: 'https://blog.n8n.io/rss/' },
  { name: 'GitHub 變更日誌', track: '工程/開發', url: 'https://github.blog/changelog/feed/' },
  { name: 'Cloudflare', track: '工程/開發', url: 'https://blog.cloudflare.com/rss/' },
  { name: 'Vercel', track: '工程/開發', url: 'https://vercel.com/atom' },
  // —— 台灣中文 ——
  { name: '中央社科技', track: '台灣科技', url: 'https://feeds.feedburner.com/rsscna/technology' },
  { name: 'iThome', track: '台灣科技', url: 'https://www.ithome.com.tw/rss' },
  // 政府公告不在這裡，見 GOV_FEEDS
]

// 政府公告另外一條線，不走熱度：補助、徵件重要的是「能不能申請、什麼時候截止」，不是多少人在聊，
// 放進熱度排序永遠排不上來（2026-09-23 改版時一度整組拿掉，被使用者糾正「有些很重要」）。
// 這條線只收「有明確申請對象、補助金額或截止日」的，照截止日排；得獎名單、活動花絮、首長行程一律不收
// （舊版的「總統盃無人機競賽 152 隊」被打 8 分混進板上，就是沒守住這條）。
const GOV_FEEDS: Feed[] = [
  { name: '國科會公告', track: '政府一手', url: 'https://www.nstc.gov.tw/nstc/rss/news' },
  { name: '國科會新聞', track: '政府一手', url: 'https://www.nstc.gov.tw/nstc/rss/newsdata' },
  { name: '產業發展署', track: '政府一手', url: 'https://www.ida.gov.tw/ctlr?PRO=rss.RSSView&t=1' },
]
const GOV_MAX_AGE_DAYS = 14 // 公告一個月才幾則，7 天常常整條是空的；截止日才是真正的時效
const GOV_MIN_SCORE = 7

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

// 一條來源最多收幾則。以前是 4：iThome 一天發十幾篇，它 9/18 那篇 Jev 報導早就被擠出前 4 則。
const PER_FEED = 12
const WRITE_CAP = 12 // 寫摘要的話題數（照熱度取前幾名）
const REWRITE_CONCURRENCY = 6

// 第二階段寫摘要＋判斷適不適合改寫成文章。輸入是一整個話題（多篇文章的標題），不是單篇。
const SUMMARY_PROMPT = `你是 Q kangber（n8n 自動化接案 + AI 應用實踐者）的新聞小編。我會給你一個最近很紅的 AI 話題，附上講這件事的幾篇文章標題與摘要。回傳一個 JSON 物件，鍵必須剛好是 中文標題、摘要、適合改寫、改寫建議。

中文標題：一句繁體中文標題，25 字內，講清楚發生什麼事，保留英文專有名詞。

摘要：用繁體中文 200 到 300 字說明這個話題，先講發生了什麼事、再補重點細節與背景、最後帶為什麼大家在討論，分 2 到 3 段寫清楚來龍去脈，讓人不點原文也能完整看懂。
多篇文章講的是同一件事的不同面向（發表、評測、複製版、反方意見）時，要把這些面向串起來講，不要只摘其中一篇。
不可以只把標題換句話說；材料不夠時用你對這個領域的常識補背景，但不可以編造數字、日期或引述。

適合改寫：布林值。有明確論點、方法論、爭議、或能延伸出台灣場景對比、實戰案例這類討論空間的給 true；純人事、募資、財報這種沒觀點好切的給 false。

改寫建議：一句完整的話（25 到 45 字）。適合改寫是 true 時，具體指名可以切的角度（哪個台灣場景對比、延伸哪個反方論點、對 n8n 自動化接案有什麼影響），不能寫「可以結合在地案例探討」這種誰套都成立的空話；適合改寫是 false 時給空字串。

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
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/\s+/g, ' ')
    .trim()
}

type Parsed = Article & { 類型: string; 圖片連結: string }

// Hacker News：10 天內 100 分以上的文章，照分數取前 100。
// 以前只抓「當下首頁前 6 名」：Jev 發表文 1970 分，但一週後早就不在首頁；
// 首頁第 4、5 名的 Enigma（612 分）、五角大廈（535 分）又被來源輪流取砍掉。
// 這裡不過濾主題，非 AI 的交給併話題那一步丟掉。
const HN_DAYS = 10
async function fetchHackerNews(): Promise<Parsed[]> {
  try {
    const since = Math.floor((Date.now() - HN_DAYS * 86400_000) / 1000)
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=100&numericFilters=created_at_i>${since},points>100`,
      { cache: 'no-store', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    )
    if (!res.ok) return []
    const data = (await res.json()) as {
      hits?: Array<{ objectID: string; title?: string; url?: string; points?: number; created_at?: string; story_text?: string | null }>
    }
    return (data.hits || [])
      .filter((h) => h.title)
      .map((h) => ({
        標題: h.title!,
        原文連結: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        來源: 'Hacker News',
        類型: '國際科技',
        摘要: cleanStoryText(h.story_text),
        圖片連結: '',
        發布時間: h.created_at || '',
        點數: h.points || 0,
      }))
  } catch {
    return []
  }
}

// Lobsters AI tag：HN 以外的工程圈討論。熱門榜（hottest）不分主題，併話題時也會被丟掉大半，就不抓了。
async function fetchLobstersAI(): Promise<Parsed[]> {
  try {
    const res = await fetch('https://lobste.rs/t/ai,ml.json', {
      cache: 'no-store',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const hits = (await res.json()) as Array<{
      title: string
      url?: string
      score: number
      created_at: string
      description_plain?: string
      comments_url: string
    }>
    return hits.slice(0, 20).map((h) => ({
      標題: h.title,
      原文連結: h.url || h.comments_url,
      來源: 'Lobsters',
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
    if (out.length >= (feed.max ?? PER_FEED)) break
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

// 沒有 RSS 的網站：直接讀列表頁 HTML。任何一支 parse 掛掉都只讓那條回 0 則，並在報告的「狀態」欄現形。
type Scraper = Feed & { parse: (html: string, s: Scraper) => Parsed[] }

// Anthropic /news：每張卡是一個 <a href>，裡面有 <time>Sep 22, 2026</time>。
// 舊版只認 <a href="/news/…">＋<h*> 標題，結果兩種卡都漏（實測 2026-09-23 只抓到 8 月的舊文，Opus 5.5 公告整篇沒抓到）：
//   精選卡的連結是 /claude-opus-5-5 或完整網址，不在 /news/ 底下
//   列表卡的標題是 <span class="…title…">，不是 <h*>
// 所以改成：任何含 <time> 的 <a>，標題依序找 <h*>、class 含 title 的 span。
function parseAnthropic(html: string, s: Scraper): Parsed[] {
  const out: Parsed[] = []
  const seen = new Set<string>()
  for (const raw of html.split('<a href="').slice(1)) {
    if (out.length >= PER_FEED) break
    const href = raw.match(/^((?:https:\/\/www\.anthropic\.com)?\/[a-z0-9/-]+)"/)
    if (!href) continue
    const end = raw.indexOf('</a>')
    const b = end === -1 ? raw.slice(0, 4000) : raw.slice(0, end)
    const d = b.match(/<time[^>]*>([^<]+)<\/time>/)
    if (!d) continue
    const t = b.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/) || b.match(/<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>/)
    if (!t) continue
    const url = href[1].startsWith('http') ? href[1] : `https://www.anthropic.com${href[1]}`
    if (seen.has(url)) continue
    seen.add(url)
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    out.push({
      標題: strip(t[1]),
      原文連結: url,
      來源: s.name,
      類型: s.track,
      摘要: strip(p ? p[1] : ''),
      圖片連結: '',
      發布時間: strip(d[1]),
    })
  }
  return out
}

// 數位發展部新聞稿：每則一個 <li class="list-group-item …">，
// 標題在 <a title="移至…">、日期在 <div class="listDate …">YYYY-MM-DD</div>。
// 2026-09 前後網址從 /press/press-releases/20684.html 改成沒有 .html，舊的正則因此整條解不到。
function parseModa(html: string, s: Scraper): Parsed[] {
  const out: Parsed[] = []
  for (const b of html.split('<li class="list-group-item').slice(1)) {
    if (out.length >= PER_FEED) break
    const a = b.match(/href="(\/press\/press-releases\/\d+(?:\.html)?)"[^>]*title="(?:移至)?([^"]*)"/)
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
    })
  }
  return out
}

const SCRAPERS: Scraper[] = [
  { name: 'Anthropic 官方', track: 'AI/LLM', url: 'https://www.anthropic.com/news', parse: parseAnthropic },
]
const GOV_SCRAPERS: Scraper[] = [
  { name: '數位發展部', track: '政府一手', url: 'https://moda.gov.tw/press/press-releases/372.html', parse: parseModa },
]

// 話題的代表連結：先挑發布者自己講的（官方），再挑媒體原文，最後才是社群討論串。
// HN 的連結本來就是原文網址，所以 HN 那則也可以當代表，只是排在媒體後面。
const COMMUNITY = new Set(['Hacker News', 'Lobsters', 'r/LocalLLaMA', 'The Rundown AI', 'Google News AI'])
function representative(t: Topic): Parsed {
  const arts = t.文章 as Parsed[]
  const rank = (a: Parsed) => (a.來源.includes('官方') ? 0 : COMMUNITY.has(a.來源) ? 2 : 1)
  return [...arts].sort((a, b) => rank(a) - rank(b) || (b.點數 ?? 0) - (a.點數 ?? 0) || (b.圖片連結 ? 1 : 0) - (a.圖片連結 ? 1 : 0))[0]
}

type Summary = { 中文標題: string; 摘要: string; 適合改寫: boolean; 改寫建議: string }

// 撞到 token 上限要讓前端講清楚，不能跟「今天沒新聞」長得一樣。
export class RateLimitError extends Error {
  constructor(public retryAfter: string) {
    super(`AI 額度暫時用完${retryAfter ? `，約 ${retryAfter} 後恢復` : '，等一下再試'}`)
    this.name = 'RateLimitError'
  }
}

function asRateLimit(e: unknown): RateLimitError | null {
  const s = String(e)
  if (!s.includes('429') && !s.includes('rate_limit')) return null
  const t = (s.match(/try again in ([\dhms.]+)/)?.[1] ?? '').replace(/\.$/, '').replace(/\.\d+s$/, 's')
  return new RateLimitError(t)
}

export async function summarizeTopic(t: Topic, zh: { 標題: string } | null): Promise<Summary | null> {
  const lines = t.文章
    .slice(0, 10)
    .map((a) => `- ${a.標題}（${a.來源}）${a.摘要 ? `：${a.摘要.slice(0, 200)}` : ''}`)
    .join('\n')
  const raw = await chatJSON(
    SUMMARY_PROMPT,
    `話題:${t.話題}\n相關文章:\n${lines}${zh ? `\n台灣媒體報導標題:${zh.標題}` : ''}`,
    800,
    0.5
  )
  try {
    const r = JSON.parse(raw) as Partial<Summary>
    return {
      中文標題: String(r.中文標題 ?? ''),
      摘要: String(r.摘要 ?? ''),
      適合改寫: Boolean(r.適合改寫),
      改寫建議: String(r.改寫建議 ?? ''),
    }
  } catch {
    return null
  }
}

function isFresh(發布時間: string): boolean {
  if (!發布時間) return false
  const t = Date.parse(發布時間)
  if (isNaN(t)) return false
  return Date.now() - t <= MAX_AGE_DAYS * 24 * 3600 * 1000
}

export type FetchReport = {
  抓到: number
  話題: number
  來源: { 名稱: string; 收下: number; 狀態: string }[]
}

async function fetchOne(f: Feed | Scraper) {
  try {
    const res = await fetch(f.url, {
      cache: 'no-store',
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { name: f.name, items: [] as Parsed[], 狀態: `HTTP ${res.status}` }
    const text = await res.text()
    const items = 'parse' in f ? f.parse(text, f) : parseFeed(text, f)
    // 抓得到頁面但一則都沒解出來＝版型換了，要講出來，不要當成「今天沒新聞」
    return { name: f.name, items, 狀態: items.length ? 'ok' : '解不到項目（版型可能已改）' }
  } catch (e) {
    return { name: f.name, items: [] as Parsed[], 狀態: `連不上（${String(e).slice(0, 40)}）` }
  }
}

// 抓所有來源、依網址去重、只留 7 天內的。scripts/news-eval.ts、scripts/news-push.ts 也用這支。
export async function collectArticles(): Promise<{ articles: Parsed[]; 來源: FetchReport['來源'] }> {
  const [hn, lobsters, ...rest] = await Promise.all([
    fetchHackerNews(),
    fetchLobstersAI(),
    ...[...FEEDS, ...SCRAPERS].map(fetchOne),
  ])
  const groups = [
    { name: 'Hacker News', items: hn, 狀態: hn.length ? 'ok' : '抓不到' },
    { name: 'Lobsters', items: lobsters, 狀態: lobsters.length ? 'ok' : '抓不到' },
    ...rest,
  ]
  const seen = new Set<string>()
  const articles: Parsed[] = []
  const 來源: FetchReport['來源'] = []
  for (const g of groups) {
    let n = 0
    for (const p of g.items) {
      if (seen.has(p.原文連結) || !isFresh(p.發布時間)) continue
      seen.add(p.原文連結)
      articles.push(p)
      n++
    }
    來源.push({ 名稱: g.name, 收下: n, 狀態: g.狀態 })
  }
  return { articles, 來源 }
}

// ---------- 政府公告 ----------

const GOV_PROMPT = `你幫 Q kangber（n8n 自動化接案、一人公司、AI 應用實踐者）過濾台灣政府公告。我會給你一批公告標題（每則有編號）。
判斷每則對他有沒有用：他在找的是「可以申請的東西」——補助、計畫徵求、競賽獎金、培訓名額、採購標案，尤其跟 AI、數位、軟體、新創、中小企業有關的。

分數 0 到 10：
- 有明確申請對象、補助金額或截止日的補助／徵件／計畫徵求／標案，而且 AI、數位、軟體、新創、中小企業能申請的：8 到 10
- 同上但對象是學術機構、大企業或其他產業，一人公司基本申請不到的：5 到 6
- 政策方向、法規變動，會影響 AI 或數位產業但不能申請的：5
- 核定名單、得獎名單、活動花絮、首長行程、研討會、展覽、內部行政、網路維護公告：0 到 2

每則回：
- 分數
- 截止日：公告裡有寫申請截止日就給 YYYY-MM-DD（民國年要換成西元），沒寫就空字串，不可以猜
- 重點：一句繁體中文（60 字內）講「誰可以申請、給什麼、什麼時候截止」；不能申請的就講這則在說什麼

回傳 JSON：{"結果":[{"編號":1,"分數":8,"截止日":"2026-10-31","重點":"…"}]}
每一則都要回，編號要一致。只回 JSON。`

// 抓政府公告 → 一次整批請 LLM 評「能不能申請」→ 過門檻的變成候選（照截止日排，沒寫截止日的排後面）。
// 公告一次才十幾二十則，整批一次呼叫就好，不用像熱門話題那樣另外寫摘要。
export async function govCandidates(): Promise<{ items: Candidate[]; 來源: FetchReport['來源'] }> {
  const groups = await Promise.all([...GOV_FEEDS, ...GOV_SCRAPERS].map(fetchOne))
  const fresh = (p: Parsed) => {
    const t = Date.parse(p.發布時間)
    return !isNaN(t) && Date.now() - t <= GOV_MAX_AGE_DAYS * 86400_000
  }
  const 來源: FetchReport['來源'] = []
  const items: Parsed[] = []
  const seen = new Set<string>()
  for (const g of groups) {
    const kept = g.items.filter((p) => fresh(p) && !seen.has(p.原文連結))
    kept.forEach((p) => seen.add(p.原文連結))
    items.push(...kept)
    來源.push({ 名稱: g.name, 收下: kept.length, 狀態: g.狀態 })
  }
  if (!items.length) return { items: [], 來源 }

  const list = items.map((p, i) => `[${i + 1}] ${p.標題}｜${p.來源}${p.摘要 ? `｜${p.摘要.slice(0, 150)}` : ''}`).join('\n')
  let rows: { 編號?: number; 分數?: number; 截止日?: string; 重點?: string }[] = []
  try {
    rows = (JSON.parse(await chatJSON(GOV_PROMPT, list, 120 * items.length, 0)) as { 結果?: typeof rows }).結果 ?? []
  } catch (e) {
    const rl = asRateLimit(e)
    if (rl) throw rl
    // 政府公告這條失敗不該拖垮熱門話題，回空的、在報告裡講清楚
    來源.push({ 名稱: '政府公告評分', 收下: 0, 狀態: `失敗（${llmErrorMessage(e).slice(0, 60)}）` })
    return { items: [], 來源 }
  }
  const out: Candidate[] = []
  for (const r of rows) {
    const p = items[Number(r.編號) - 1]
    const 分數 = Number(r.分數 ?? 0)
    if (!p || 分數 < GOV_MIN_SCORE) continue
    const 截止日 = /^\d{4}-\d{2}-\d{2}$/.test(r.截止日 ?? '') ? r.截止日! : ''
    if (截止日 && Date.parse(截止日) < Date.now() - 86400_000) continue // 已經截止的不收
    out.push({
      時間: twTime(new Date(p.發布時間)),
      類型: '政府一手',
      分數,
      話題: p.標題,
      熱度明細: null,
      相關文章: 1,
      截止日,
      標題: p.標題,
      中文標題: '',
      來源: p.來源,
      原文連結: p.原文連結,
      中文報導: null,
      圖片連結: p.圖片連結,
      配圖: p.圖片連結 ? '是' : '否',
      摘要: String(r.重點 ?? ''),
      適合改寫: false,
      改寫建議: '',
    })
  }
  out.sort((a, b) => (a.截止日 || '9999').localeCompare(b.截止日 || '9999') || b.分數 - a.分數)
  return { items: out, 來源 }
}

// 抓 → 併話題 → 量熱度，照熱度排好。前端、評估腳本、LINE 推播共用。
export async function trendingTopics(): Promise<{ topics: Topic[]; articles: number; 來源: FetchReport['來源'] }> {
  const { articles, 來源 } = await collectArticles()
  let clustered
  try {
    clustered = await clusterTopics(articles)
  } catch (e) {
    const rl = asRateLimit(e)
    if (rl) throw rl
    throw new Error(`併話題失敗：${llmErrorMessage(e)}`)
  }
  const topics = await rankTopics(clustered)
  return { topics, articles: articles.length, 來源 }
}

// 話題 → 候選：挑代表連結、找台灣中文報導、寫摘要
export async function toCandidates(topics: Topic[]): Promise<Candidate[]> {
  const out: (Candidate | null)[] = []
  for (let i = 0; i < topics.length; i += REWRITE_CONCURRENCY) {
    out.push(
      ...(await Promise.all(
        topics.slice(i, i + REWRITE_CONCURRENCY).map(async (t) => {
          const rep = representative(t)
          const zh = await zhCoverage(t)
          let s: Summary | null
          try {
            s = await summarizeTopic(t, zh)
          } catch (e) {
            const rl = asRateLimit(e)
            if (rl) throw rl
            return null
          }
          if (!s || !s.摘要) return null
          const d = rep.發布時間 && !isNaN(Date.parse(rep.發布時間)) ? new Date(rep.發布時間) : new Date()
          return {
            時間: twTime(d),
            類型: rep.類型,
            分數: t.熱度,
            話題: t.話題,
            熱度明細: t.明細,
            相關文章: t.文章.length,
            截止日: '',
            標題: rep.標題,
            中文標題: s.中文標題,
            來源: rep.來源,
            原文連結: await resolveGoogleNews(rep.原文連結),
            中文報導: zh ? { 標題: zh.標題, 連結: await resolveGoogleNews(zh.連結) } : null,
            圖片連結: rep.圖片連結,
            配圖: rep.圖片連結 ? '是' : '否',
            摘要: s.摘要,
            適合改寫: s.適合改寫,
            改寫建議: s.改寫建議,
          } satisfies Candidate
        })
      ))
    )
  }
  return out.filter((c): c is Candidate => c !== null)
}

// 發過的話題不再推：比網址，也比話題關鍵字有沒有出現在最近 7 天發過的標題裡
// （同一件事換一篇文章當代表，網址就不一樣了）。
function alreadyPosted(t: Topic, posted: { 標題: string; 原文連結: string; 發文時間: string }[]): boolean {
  const urls = new Set(t.文章.map((a) => a.原文連結))
  const key = t.種類 === '名稱' ? t.必含.toLowerCase() : '\u0000' // 只有名稱類的關鍵字夠準，拿來比標題
  const weekAgo = Date.now() - 7 * 86400_000
  return posted.some(
    (p) =>
      urls.has(p.原文連結) ||
      (p.標題.toLowerCase().includes(key) && Date.parse(p.發文時間.replace(/\//g, '-')) > weekAgo)
  )
}

export async function fetchNewsCandidates(): Promise<{
  items: Candidate[]
  scanned: number
  report: FetchReport
}> {
  const posted = await getPostedLog().catch(() => [])
  // 兩條線並行：政府公告那條只有一次 LLM 呼叫，不該讓熱門話題等它
  const [{ topics, articles, 來源 }, gov] = await Promise.all([trendingTopics(), govCandidates()])
  const fresh = topics.filter((t) => !alreadyPosted(t, posted)).slice(0, WRITE_CAP)
  const hot = await toCandidates(fresh)
  const postedUrls = new Set(posted.map((p) => p.原文連結))
  const items = [...hot, ...gov.items.filter((c) => !postedUrls.has(c.原文連結))]
  return { items, scanned: articles, report: { 抓到: articles, 話題: topics.length, 來源: [...來源, ...gov.來源] } }
}
