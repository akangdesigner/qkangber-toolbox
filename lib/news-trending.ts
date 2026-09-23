// 熱度：把「一則一則的文章」併成「話題」，再用外部訊號量這個話題現在有多紅。
//
// 為什麼要這支：舊版是每則文章各自讓 LLM 評「分享價值」，從來沒有「現在多少人在聊」這個概念。
// 2026-09-23 對照當週真正的熱門話題，9 個只上板 2 個——最熱的 Jev 在三個來源都有抓到，
// 但每篇單獨看都像冷門技術文，被打 5-6 分刷掉。一個話題同時被很多地方講、搜尋量衝上去，才是「紅」。
//
// 四個訊號，各自補對方的盲點（第四個「來源數」見 heatScore）：
//   HN 分數加總（10 天）：工程圈的熱度。只看當天首頁會錯——Jev 9/15 發表那篇 1970 分，一週後早就掉出首頁。
//   Google News 報導篇數（7 天）：媒體熱度。上限 100 篇，大話題都會頂到，只能分出大小，分不出大的誰更大。
//   Google Trends（7 天，對照詞 Claude AI）：一般人的搜尋熱度。這是唯一把 Jev 排第一的訊號
//     （實測 Jev 31、GPT-6 5、Opus 5.5 1；HN 分數則是 Opus／GPT-6 較高）。
//     對照詞不能用 ChatGPT：它太大，其他詞全被壓成 0。Trends 不是官方 API，被擋就少這個訊號，不賠掉整輪。
import { chatJSON } from '@/lib/llm-json'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const TIMEOUT_MS = 15_000

// 丟進來併話題的最小單位（lib/news-fetch 的 Parsed 的子集，免得兩邊互相 import）
export type Article = {
  標題: string
  原文連結: string
  來源: string
  摘要: string
  發布時間: string
  點數?: number // HN 分數，其他來源沒有
}

export type Heat = {
  hn: number // 10 天內標題含關鍵字的 HN 文章分數加總
  hn篇數: number
  新聞: number // Google News 7 天內標題含關鍵字的報導篇數（上限 100）
  搜尋: number | null // Google Trends 7 天平均 ÷ 對照詞 Claude AI；抓不到是 null
  來源數: number // 我們自己抓到的文章裡，有幾個不同來源在講這件事
  // 外部搜到的標題有幾成真的在講這件事（0-1），見 verifyMatches。HN、新聞分開算：
  // 五角大廈那則 HN 搜到的兩篇都對，Google News 卻混了一半別的五角大廈新聞，一起算會把準的那個也拖下去。
  hn相關度: number
  新聞相關度: number // Google Trends 也乘這個（一般人的搜尋跟媒體報導是同一群人）
  // 以下只有「從 Google Trends 找話題」那條線有（lib/news-trends）：搜尋量是對照詞 Claude AI 的幾倍、最猛的漲幅、原始搜尋詞
  台灣?: number | null
  全球?: number | null
  漲幅?: string
  搜尋詞?: string[]
}

export type Topic = {
  話題: string // 給人看的名字，例如「Jev」「Claude Opus 5.5 與 GPT-6 同日發表」
  查詢: string // 拿去搜 HN／Google News／Trends 的詞
  必含: string // 標題裡要有這個字才算同一個話題（HN、Google News 的搜尋都是模糊比對，查 Kev 會撈到 Key）
  // 名稱：查詢是專有名詞，標題含「必含」就算。事件：沒有專屬名字，標題要含查詢裡至少兩個字才算。
  // 籠統：公司名或領域詞，外部搜到的是整家公司／整個領域的熱度，不拿去搜（見 rankTopics）。
  種類: '名稱' | '事件' | '籠統' 
  文章: Article[]
  熱度: number // 0-100，見 heatScore
  明細: Heat
}

// ---------- 併話題 ----------

// 做法：LLM 一批 40 篇，逐篇回「是不是 AI、主角是誰」，再由程式照主角分組。
// 以前是把 300 多篇一次丟給 LLM 叫它自己分群，實測三個毛病：整篇漏掉（五角大廈 HN 552 分那則直接消失）、
// 亂湊分類（「AI 監管與隱私」這種把不相干的文章湊一堆）、同一件事被拆開或不同事被併起來。
// 逐篇回答就不會漏；分組交給程式，同一個主角一定併在一起。
const EXTRACT_PROMPT = `你是 AI 新聞編輯。我會給你一批最近一週的科技文章標題（每則有編號），請逐篇回答它在講什麼。

每一篇都要回：
- AI：布林值。跟 AI 有關（AI 模型、AI 工具、AI 公司、AI 產業、AI 政策、AI 用在軍事／法律／醫療等等的事件）給 true；
  跟 AI 無關（純程式語言、一般硬體、一般資安、運動、生活）給 false，其他欄位給空字串。
- 主角：這篇在講的那件事的主角名字，英文，用來把講同一件事的文章併在一起。規則：
  * 產品或模型就用它的名字：「Jev」「Claude Opus 5.5」「GPT-6 Sol」「Meta Muse」「Grok 4.7」。
  * 模仿、複製、評測、比較、跟進上架某個東西的文章，主角寫被模仿的那個原版：「Kev: Tiny Jev-like models」「OpenJev」「Vercel 上架 Jev」「我一年前就做過 Jev 這種架構」主角都是「Jev」。
  * 同一系列不同產品要分開：「GPT-6 Sol」和「GPT-6 Astra」是不同主角。
  * 沒有產品名的事件，用事件裡最關鍵的人名、機構名：五角大廈承認 AI 導致誤炸 →「Pentagon」；Amodei 呼籲放緩 AI 開發 →「Amodei」。
  * 同一件事不管在哪一篇，主角都要寫得一模一樣（大小寫、空格都一樣），這樣我才併得起來。
- 查詢：拿去 Google 搜尋這件事用的 1 到 3 個英文字。產品就是它的名字（「Jev」「Claude Opus 5.5」「Meta Muse」）；
  事件是主角加 1-2 個關鍵字（「Pentagon AI strike」「Amodei AI slowdown」）。不要加描述詞，「Jev decision model」是錯的。
- 種類：「名稱」（查詢是產品或模型的專有名詞）、「事件」（查詢是主角加關鍵字）、「籠統」（講的是 OpenAI、Google 這種整家公司，或整個領域，沒有一件具體的事）。
- 話題：繁體中文 15 字內，講這件事（例：「Jev 決策模型爆紅」「五角大廈承認 AI 導致誤炸」）。

回傳 JSON：{"結果":[{"編號":1,"AI":true,"主角":"Jev","查詢":"Jev","種類":"名稱","話題":"Jev 決策模型爆紅"}]}
每一篇都要回，編號要跟我給的一致。只回 JSON。`

const EXTRACT_BATCH = 40
const EXTRACT_CONCURRENCY = 3

type Extracted = { 主角: string; 查詢: string; 種類: string; 話題: string }

async function extractBatch(articles: Article[], offset: number): Promise<Map<number, Extracted>> {
  const list = articles
    .map((a, i) => `[${offset + i + 1}] ${a.標題}｜${a.來源}${a.摘要 ? `｜${a.摘要.slice(0, 100)}` : ''}`)
    .join('\n')
  const raw = await chatJSON(EXTRACT_PROMPT, list, 90 * articles.length, 0)
  const out = new Map<number, Extracted>()
  try {
    const rows = (JSON.parse(raw) as { 結果?: Record<string, unknown>[] }).結果 ?? []
    for (const r of rows) {
      const i = Number(r.編號) - 1
      if (!Number.isInteger(i) || i < offset || i >= offset + articles.length) continue
      if (r.AI !== true || !r.主角 || !r.查詢) continue
      out.set(i, { 主角: String(r.主角).trim(), 查詢: String(r.查詢).trim(), 種類: String(r.種類 ?? ''), 話題: String(r.話題 ?? '') })
    }
  } catch {
    // 壞 JSON：這一批當作沒有 AI 文章，不賠掉整輪
  }
  return out
}

// 模型標了名稱／事件、但查詢其實是公司名、大品牌或一般詞的，這裡再擋一次。
// 實測：「OpenAI」當查詢，HN 10 天 4926 分、搜尋量是 Claude AI 的 1.5 倍，把兩個小話題推上第 4、5 名。
// Muse 單獨一個字會撞到樂團，要寫「Meta Muse」。
const GENERIC = new Set([
  'ai', 'model', 'models', 'llm', 'agent', 'agents', 'agentic', 'infrastructure', 'security', 'openai',
  'chatgpt', 'gpt', 'anthropic', 'claude', 'google', 'gemini', 'meta', 'llama', 'microsoft', 'copilot',
  'apple', 'nvidia', 'amazon', 'aws', 'xai', 'grok', 'qwen', 'alibaba', 'deepseek', 'mistral', 'hugging face', 'muse',
])
// 事件的主角不能是這些：它們是專有名詞沒錯，但大到什麼新聞都配得到
const BROAD = new Set([
  'eu', 'us', 'usa', 'uk', 'china', 'chinese', 'europe', 'european', 'america', 'american', 'trump', 'congress',
  'senate', 'white house', 'taiwan', 'japan', 'india', 'silicon valley', 'wall street',
])

const mostCommon = (xs: string[]) => {
  const n = new Map<string, number>()
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

// 逐篇抽主角之後，同一件事還是可能被寫成不同主角：五角大廈誤炸那則，HN 那篇主角是「Pentagon」，
// Gizmodo 那篇（講 Palantir 的系統）是「Palantir」，另一篇是「US Military」——拆成三個話題，每個都只有 1 個來源，
// 「來源數」這個最重的訊號就變成 0，整件事掉到第 48 名。
// 所以分組之後再問一次：把所有主角＋代表標題列出來，請 LLM 指出哪些是同一件事。一次呼叫，約 5k token。
const MERGE_PROMPT = `下面是一批 AI 新聞話題，每個話題有編號、主角、一篇代表文章標題。有些其實是同一件事，只是主角寫法不同
（例：「Pentagon」「Palantir」「US Military」三個都在講美軍 AI 系統導致伊朗學校誤炸；「GPT-6」和「GPT-6 Sol」都在講 GPT-6 Sol/Luna 發表）。
請找出「講的是同一件具體的事」的話題組。只是同一家公司、同一個領域的不算，要是同一個產品發表、同一個事件。
回傳 JSON：{"合併":[[3,17,42],[5,9]]}，每組是編號陣列，沒有要合併的就回 {"合併":[]}。只回 JSON。`

async function mergeSameEvent(groups: Map<string, { idx: number; e: Extracted }[]>, articles: Article[]): Promise<void> {
  const keys = [...groups.keys()]
  if (keys.length < 2) return
  const list = keys
    .map((k, i) => {
      const g = groups.get(k)!
      return `[${i + 1}] 主角：${g[0].e.主角}｜${articles[g[0].idx].標題.slice(0, 90)}`
    })
    .join('\n')
  let sets: number[][] = []
  try {
    sets = (JSON.parse(await chatJSON(MERGE_PROMPT, list, 1500, 0)) as { 合併?: number[][] }).合併 ?? []
  } catch {
    return // 合併失敗就維持原樣，頂多拆得細一點
  }
  for (const set of sets) {
    const ks = [...new Set(set.map((n) => keys[Number(n) - 1]).filter((k) => k && groups.has(k)))]
    if (ks.length < 2) continue
    // 併進文章最多的那組，它的主角寫法最可能是大家在用的
    ks.sort((a, b) => groups.get(b)!.length - groups.get(a)!.length)
    const [main, ...rest] = ks
    for (const k of rest) {
      groups.get(main)!.push(...groups.get(k)!)
      groups.delete(k)
    }
  }
}

export async function clusterTopics(articles: Article[]): Promise<Omit<Topic, '熱度' | '明細'>[]> {
  const offsets: number[] = []
  for (let i = 0; i < articles.length; i += EXTRACT_BATCH) offsets.push(i)
  let failed = 0
  const maps = await pool(offsets, EXTRACT_CONCURRENCY, (off) =>
    extractBatch(articles.slice(off, off + EXTRACT_BATCH), off).catch((e) => {
      // 429／額度用完要往外丟讓前端講清楚；其他錯誤只丟這一批
      if (/429|402|rate_limit|credits/.test(String(e))) throw e
      failed++
      return new Map<number, Extracted>()
    })
  )
  if (failed === offsets.length) throw new Error('每一批都失敗了')

  // 照主角分組（大小寫不分）
  const groups = new Map<string, { idx: number; e: Extracted }[]>()
  for (const m of maps)
    for (const [idx, e] of m) {
      const key = e.主角.toLowerCase()
      const g = groups.get(key)
      if (g) g.push({ idx, e })
      else groups.set(key, [{ idx, e }])
    }

  // 主角是別的主角加字的，併過去：「GPT-6 Sol and Luna」→「GPT-6 Sol」。
  // 只併進兩個字以上的主角：「GPT-6 Sol」不能再併進「GPT-6」，不然 Sol、Astra 兩件事會湊成一個。
  const keys = [...groups.keys()].sort((a, b) => b.length - a.length)
  for (const k of keys) {
    const parent = keys
      .filter((p) => p !== k && p.split(/\s+/).length >= 2 && (k.startsWith(p + ' ') || k.startsWith(p + '-')))
      .sort((a, b) => b.length - a.length)[0]
    if (parent && groups.has(parent) && groups.has(k)) {
      groups.get(parent)!.push(...groups.get(k)!)
      groups.delete(k)
    }
  }

  await mergeSameEvent(groups, articles)

  const out: Omit<Topic, '熱度' | '明細'>[] = []
  for (const g of groups.values()) {
    const 必含 = mostCommon(g.map((x) => x.e.主角))
    let 查詢 = mostCommon(g.map((x) => x.e.查詢))
    // 查詢太長（模型還是會塞描述詞）就退回主角：「Jev decision model」在 HN、Google News、Trends 全都搜不到東西
    if (查詢.split(/\s+/).length > 3) 查詢 = 必含
    const kind = mostCommon(g.map((x) => x.e.種類))
    const q = 查詢.toLowerCase()
    const b = 必含.toLowerCase()
    // 主角是 Trump、China 這種大詞也可以算事件，只要查詢裡還有別的具體字（「Trump super intelligence」）：
    // 比對時標題要同時有 Trump 和那個字，不會把所有川普新聞都算進來；剩下的誤中交給 verifyMatches 打折。
    const others = 查詢.split(/\s+/).filter((w) => w.toLowerCase() !== b && !GENERIC.has(w.toLowerCase()))
    const properEvent = /^[A-Z0-9]/.test(必含) && !GENERIC.has(b) && others.length >= (BROAD.has(b) ? 1 : 0) && 查詢.split(/\s+/).length >= 2
    const 種類: Topic['種類'] =
      GENERIC.has(q) || GENERIC.has(b)
        ? '籠統'
        : kind === '名稱'
          ? '名稱'
          : kind === '事件' && properEvent
            ? '事件'
            : '籠統'
    out.push({
      話題: g[0].e.話題 || 必含,
      查詢,
      必含,
      種類,
      文章: g.map((x) => articles[x.idx]),
    })
  }
  return out
}

// ---------- 三個熱度訊號 ----------

// 標題要真的含關鍵字：大小寫不分、前後不能黏著英數字（Jev 不能配到 Jevons）
function mentions(title: string, word: string): boolean {
  const w = word.trim().toLowerCase()
  if (!w) return false
  const t = title.toLowerCase()
  let i = t.indexOf(w)
  while (i !== -1) {
    const before = t[i - 1] ?? ' '
    const after = t[i + w.length] ?? ' '
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true
    i = t.indexOf(w, i + 1)
  }
  return false
}

const HN_DAYS = 10 // 7 天會漏掉話題的起點：Jev 發表文剛好是第 8 天

// 標題算不算在講這個話題。名稱：含「必含」。事件：含「必含」，再加查詢裡任何一個其他的字。
// 事件還要多含查詢裡另一個字：只看「Pentagon」會把所有五角大廈新聞都算進來。
function matches(title: string, t: Pick<Topic, '查詢' | '必含' | '種類'>): boolean {
  if (!mentions(title, t.必含)) return false
  if (t.種類 === '名稱') return true
  const others = t.查詢.split(/\s+/).filter((w) => w && w.toLowerCase() !== t.必含.toLowerCase())
  return !others.length || others.some((w) => mentions(title, w))
}

export async function hnHeat(
  t: Pick<Topic, '查詢' | '必含' | '種類'>
): Promise<{ points: number; count: number; titles: string[] }> {
  const 查詢 = t.查詢
  const since = Math.floor((Date.now() - HN_DAYS * 86400_000) / 1000)
  const params = new URLSearchParams({
    // 事件的查詢不要求每個字都出現（Algolia 預設會），讓 matches 自己判斷
    query: 查詢,
    ...(t.種類 === '事件' ? { optionalWords: 查詢 } : {}),
    tags: 'story',
    hitsPerPage: '100',
    numericFilters: `created_at_i>${since}`,
  })
  const res = await fetch(`https://hn.algolia.com/api/v1/search?${params}`, {
    headers: { 'User-Agent': UA },
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return { points: 0, count: 0, titles: [] }
  const hits = ((await res.json()).hits ?? []) as { title?: string; points?: number }[]
  const matched = hits.filter((h) => h.title && matches(h.title, t)).sort((a, b) => (b.points || 0) - (a.points || 0))
  return {
    points: matched.reduce((s, h) => s + (h.points || 0), 0),
    count: matched.length,
    titles: matched.slice(0, 8).map((h) => h.title!),
  }
}

export async function newsCount(t: Pick<Topic, '查詢' | '必含' | '種類'>): Promise<{ count: number; titles: string[] }> {
  // 名稱加引號要求整串出現；事件不加，讓 Google News 自己找相關的，再用 matches 過濾
  const q = encodeURIComponent(`${t.種類 === '名稱' ? `"${t.查詢}"` : t.查詢} when:7d`)
  const res = await fetch(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, {
    headers: { 'User-Agent': UA },
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) return { count: 0, titles: [] }
  const xml = await res.text()
  const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => m[1].replace(/&amp;/g, '&'))
  const hit = titles.filter((title) => matches(title, t))
  return { count: hit.length, titles: hit.slice(0, 8) }
}

// 台灣中文媒體有沒有報導：有的話附一條給使用者參考、寫草稿時也有中文脈絡可用
export async function zhCoverage(t: Pick<Topic, '查詢' | '必含' | '種類'>): Promise<{ 標題: string; 連結: string } | null> {
  const { 查詢, 必含 } = t
  // 中文標題不會有英文的事件關鍵字，事件類就只能靠名稱類的必含；籠統的不找
  if (t.種類 === '籠統') return null
  try {
    const q = encodeURIComponent(`${查詢} when:7d`)
    const res = await fetch(`https://news.google.com/rss/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, {
      headers: { 'User-Agent': UA },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const xml = await res.text()
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const t = m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''
      const l = m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? ''
      // 要是中文標題，不然 zh-TW 版也會混英文原文進來
      if (t && l && mentions(t, 必含) && /[一-鿿]/.test(t)) return { 標題: t.replace(/&amp;/g, '&'), 連結: l }
    }
  } catch {}
  return null
}

const TRENDS_ANCHOR = 'Claude AI'

// Google Trends 網頁背後的介面（非官方）：一次最多 5 個詞，所以 4 個話題＋1 個固定對照詞一批，
// 每個話題的值都除以同一批的對照詞，不同批次才比得起來。
// 被擋（429）或格式變了就回空 Map，呼叫端當作「沒有這個訊號」。
export async function trendsRatios(queries: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!queries.length) return out
  try {
    const home = await fetch('https://trends.google.com/trends/?geo=US', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    const headers = { 'User-Agent': UA, Cookie: cookie }
    const strip = (s: string) => JSON.parse(s.slice(s.indexOf('{')))
    for (let i = 0; i < queries.length; i += 4) {
      const kws = [TRENDS_ANCHOR, ...queries.slice(i, i + 4)]
      const req = {
        comparisonItem: kws.map((k) => ({ keyword: k, geo: '', time: 'now 7-d' })),
        category: 0,
        property: '',
      }
      const ex = await fetch(
        `https://trends.google.com/trends/api/explore?hl=en-US&tz=-480&req=${encodeURIComponent(JSON.stringify(req))}`,
        { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }
      )
      if (!ex.ok) break
      const w = (strip(await ex.text()).widgets as { id: string; request: unknown; token: string }[]).find(
        (x) => x.id === 'TIMESERIES'
      )
      if (!w) break
      const ml = await fetch(
        `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=-480&req=${encodeURIComponent(
          JSON.stringify(w.request)
        )}&token=${w.token}`,
        { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }
      )
      if (!ml.ok) break
      const avgs = (strip(await ml.text()).default?.averages ?? []) as number[]
      const anchor = avgs[0] || 0
      if (!anchor) continue
      kws.slice(1).forEach((k, j) => out.set(k, (avgs[j + 1] ?? 0) / anchor))
      await new Promise((r) => setTimeout(r, 1200)) // 連打會被擋
    }
  } catch {}
  return out
}

// ---------- 合成 0-100 ----------

// 四個訊號都換成 0-1 再加權。用絕對刻度（不是「這一輪的最大值＝1」），
// 分數才有跨天的意義，LINE 推播的門檻也才固定得住。
//   HN：10 天加總 3000 分＝滿分（Jev 約 3700、Opus 5.5 約 1650、一般 AI 話題幾百）
//   新聞：100 篇＝滿分（Google News 上限就是 100）
//   搜尋：Claude AI 的一半＝滿分（Jev 0.7、GPT-6 0.11、Opus 5.5 0.02）
//   來源數：8 個不同來源＝滿分。實測 Jev 有 7 個（HN、Reddit、Lobsters、Simon Willison、Latent Space、Vercel…），
//     是這週最多的——「一件事同時在很多地方被講」本身就是熱度，而且這個訊號不靠任何外部服務，不會被擋。
// 搜尋和來源數權重最高：它們是唯二把 Jev 排第一的訊號；HN 分數偏愛「發表當天」的大新聞。
const W = { hn: 0.25, 新聞: 0.15, 搜尋: 0.3, 來源數: 0.3 }
const log01 = (v: number, full: number) => Math.min(1, Math.log10(1 + Math.max(0, v)) / Math.log10(1 + full))

// 籠統的話題（公司名、領域詞當主角）多半是 LLM 把幾篇不相干的文章湊成一堆，不是「一件發生的事」。
// 來源數算到媒體之後，這種雜燴會因為混了好幾家 Google News 媒體而虛胖（實測「AI stocks rally」8 個來源、排第 8），所以打對折。
const GENERIC_PENALTY = 0.5

export function heatScore(h: Heat, 種類?: Topic['種類']): number {
  const parts: [number, number][] = [
    [W.hn, h.hn相關度 * log01(h.hn, 3000)],
    [W.新聞, h.新聞相關度 * log01(h.新聞, 100)],
    [W.來源數, Math.min(1, Math.max(0, h.來源數 - 1) / 7)], // 只有 1 個來源＝0，不是 1/8
  ]
  if (h.搜尋 !== null) parts.push([W.搜尋, h.新聞相關度 * log01(h.搜尋 * 100, 50)])
  // Trends 被擋時用剩下的重新攤權重，不要讓整輪分數平白少 30 分
  const wsum = parts.reduce((s, [w]) => s + w, 0)
  const score = (parts.reduce((s, [w, v]) => s + w * v, 0) / wsum) * 100
  return Math.round(種類 === '籠統' ? score * GENERIC_PENALTY : score)
}

// 「來源」要算到媒體：Google News 聚合來的每一篇是不同媒體（標題結尾「 - The Guardian」），
// 全算成「Google News AI」一個來源的話，川普把 AI 改名「超級智慧」那種 10 家媒體同時報的大事只算 1 個來源。
function outlet(a: Article): string {
  if (a.來源 !== 'Google News AI') return a.來源
  return a.標題.match(/ - ([^-]+)$/)?.[1]?.trim().toLowerCase() || a.來源
}

async function pool<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (next < xs.length) {
        const i = next++
        out[i] = await fn(xs[i])
      }
    })
  )
  return out
}

// 量每個話題的熱度，照熱度排好回傳。
// Trends 只查前 TRENDS_TOP 名（先用其他三個訊號排一次），查全部 60 個話題要 15 批、很容易被擋。
const TRENDS_TOP = 16

export async function rankTopics(topics: Omit<Topic, '熱度' | '明細'>[]): Promise<Topic[]> {
  const base = await pool(topics, 6, async (t) => {
    // 籠統的查詢（公司名、一般詞）不拿去外部搜：搜到的是整家公司／整個領域的熱度，不是這件事的。
    // 這種話題只用我們自己抓到的東西量：話題裡 HN 文章的分數、有幾個來源在講。
    const none = { points: 0, count: 0, titles: [] as string[] }
    const [hn, news] =
      t.種類 !== '籠統'
        ? await Promise.all([hnHeat(t).catch(() => none), newsCount(t).catch(() => ({ count: 0, titles: [] as string[] }))])
        : [none, { count: 0, titles: [] as string[] }]
    // 話題裡的 HN 文章，關鍵字搜尋搜不到的要另外加回來
    // （「I built non-autoregressive decision models a year ago」1338 分，講的是 Jev 卻沒寫 Jev）。
    // 有搜到的（不是籠統、而且標題配得上）已經算在搜尋結果裡，不重複加。
    const extra = t.文章.filter((a) => a.點數 && !(t.種類 !== '籠統' && matches(a.標題, t)))
    const 明細: Heat = {
      hn: hn.points + extra.reduce((s, a) => s + (a.點數 ?? 0), 0),
      hn篇數: hn.count + extra.length,
      新聞: news.count,
      搜尋: null,
      來源數: new Set(t.文章.map(outlet)).size,
      hn相關度: 1,
      新聞相關度: 1,
    }
    return { ...t, 明細, 熱度: heatScore(明細, t.種類), hn樣本: hn.titles, 新聞樣本: news.titles }
  })
  base.sort((a, b) => b.熱度 - a.熱度)
  await verifyMatches(base.slice(0, VERIFY_TOP))
  for (const t of base) t.熱度 = heatScore(t.明細, t.種類)
  base.sort((a, b) => b.熱度 - a.熱度)
  // Trends 只查名稱類：事件的查詢是幾個字湊的，搜尋量不代表這件事
  const top = base.filter((t) => t.種類 === '名稱').slice(0, TRENDS_TOP)
  const ratios = await trendsRatios([...new Set(top.map((t) => t.查詢))])
  // 只查到一半（中途被擋）就整個不用：一半有、一半當 0，比完全沒有還不公平
  if (ratios.size && top.every((t) => ratios.has(t.查詢))) {
    // 沒進前 16 名的沒查 Trends，一律當 0：不這樣的話，它們只用其他訊號重新攤權重，
    // 會反超前段那些「查了 Trends 才發現搜尋量普通」的話題。它們在其他訊號已經排不進前段，當 0 不冤。
    for (const t of base) {
      t.明細.搜尋 = ratios.get(t.查詢) ?? 0
      t.熱度 = heatScore(t.明細, t.種類)
    }
  }
  return base.sort((a, b) => b.熱度 - a.熱度).map(({ hn樣本: _h, 新聞樣本: _n, ...t }) => t)
}

// 外部搜尋是關鍵字比對，碰到一般英文字就會失真：實測「Bend」（程式語言，也是「彎曲」）、「Transformers」（也是電影）、
// 「AX」搜到一堆無關新聞，把單篇文章的小話題推到第 3、4 名。
// 所以前段班的話題，把搜到的標題抽樣給 LLM 看「幾成真的在講這件事」，外部訊號乘上這個比例。
// 一次整批問，約 6k token。失敗就當全部相關（等於沒驗證），不賠掉整輪。
const VERIFY_TOP = 25
const VERIFY_PROMPT = `我在量一些 AI 話題的熱度，用關鍵字搜了 Hacker News 和 Google News。關鍵字比對會誤中：同名但不相干的東西、一般英文單字的其他意思。
每個話題我會給你：話題名稱、搜尋關鍵字、我們自己抓到的代表文章標題、搜到的標題樣本。
請分別判斷 HN 樣本、新聞樣本裡有幾成是在講「同一個話題」（同一個產品／事件，包括它的評測、複製版、後續討論）。
回傳 JSON：{"結果":[{"編號":1,"HN":0.9,"新聞":0.5}]}，都是 0 到 1 的小數；該組沒有樣本的給 1。只回 JSON。`

async function verifyMatches(topics: (Topic & { hn樣本: string[]; 新聞樣本: string[] })[]): Promise<void> {
  const need = topics.filter((t) => t.hn樣本.length || t.新聞樣本.length)
  if (!need.length) return
  const list = need
    .map(
      (t, i) =>
        `[${i + 1}] 話題：${t.話題}｜關鍵字：${t.查詢}\n代表文章：${t.文章
          .slice(0, 3)
          .map((a) => a.標題)
          .join(' / ')}\nHN 樣本：\n${t.hn樣本.map((x) => `  - ${x}`).join('\n') || '  （無）'}\n新聞樣本：\n${
          t.新聞樣本.map((x) => `  - ${x}`).join('\n') || '  （無）'
        }`
    )
    .join('\n\n')
  try {
    const rows = (JSON.parse(await chatJSON(VERIFY_PROMPT, list, 40 * need.length + 50, 0)) as {
      結果?: { 編號?: number; HN?: number; 新聞?: number }[]
    }).結果 ?? []
    const clamp = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : 1)
    for (const r of rows) {
      const t = need[Number(r.編號) - 1]
      if (!t) continue
      t.明細.hn相關度 = clamp(r.HN)
      t.明細.新聞相關度 = clamp(r.新聞)
    }
  } catch {}
}
