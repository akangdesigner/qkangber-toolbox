// 找「Threads 上會爆」的 AI 話題：台灣 Google News 搜一組關鍵字 → 併成話題 → LLM 照 Threads 爆點打分 → 跟報導媒體數合成熱度。
//
// 為什麼換掉 Google Trends 那套（lib/news-trends，2026-10-29 拿掉）：它用搜尋詞的搜尋量當熱度，
// LLM 挑的搜尋詞常常就是「chatgpt」「claude」「grok」這種品牌名，等於在量品牌有名不有名——
// Uber 導入 ChatGPT、Anthropic 上市都 100 分，被使用者嫌「都是垃圾 AI 工具、不是 Threads 愛看的」。
// 實際翻 Threads 中文區（2026-10-29，244 篇）：會爆的是選舉 AI 深偽、AI 害人出事、名人爭議發言、
// 誇張突破加梗、工作被取代、跟錢有關；產品發表、企業導入、上市財報幾乎沒人轉。
// 標準答案在 data/news-eval/2026-10-29.json，改這支前後都跑 scripts/news-eval.ts。
//
// 不直接爬 Threads：自動抓 Threads 搜尋違反它的使用條款，伺服器位址會被擋。
// Threads 上會爆的事，台灣媒體幾天內幾乎都會報，所以從台灣 Google News 找，再用「會不會爆」排。
import { chatJSON } from '@/lib/llm-json'
import { clusterTopics, type Article, type Heat, type Topic } from '@/lib/news-trending'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const TIMEOUT_MS = 15_000
const PER_QUERY = 25

// 關鍵字照 2026-10-29 在 Threads 上實測的結果挑：深偽、AI影片、AI詐騙、提示詞撈到的高互動文最多；
// 「Gemini」一半是雙子座星座文、「黃仁勳」大多是政治文，但新聞搜尋不會撈到這些，留著。
// 英文那幾組是給國外出事、台灣媒體還沒跟上的（ChatGPT 鼓勵減藥致死那則，台灣當天只有 Threads 在傳）。
const QUERIES: { q: string; locale: 'zh' | 'en' }[] = [
  { q: 'AI 深偽', locale: 'zh' },
  { q: 'AI 詐騙', locale: 'zh' },
  { q: 'AI 影片', locale: 'zh' },
  { q: 'AI 選舉', locale: 'zh' },
  { q: '網軍 AI', locale: 'zh' },
  { q: 'AI 爭議', locale: 'zh' },
  // 葛如鈞競選網站那則（Threads 上 2,330 則留言），新聞標題寫的是「下達 AI 指令」「抄襲」，搜「AI 選舉」撈不到
  { q: 'AI 抄襲', locale: 'zh' },
  { q: 'AI指令', locale: 'zh' },
  // AI 害到人：ChatGPT 鼓勵減藥致死，標題是「ChatGPT 害死人」「喪命」「猝死」
  { q: 'ChatGPT 死亡', locale: 'zh' },
  { q: 'AI 害死', locale: 'zh' },
  { q: 'AI 取代', locale: 'zh' },
  { q: 'AI 裁員', locale: 'zh' },
  { q: 'ChatGPT', locale: 'zh' },
  { q: 'Claude', locale: 'zh' },
  { q: 'OpenAI', locale: 'zh' },
  { q: 'Gemini AI', locale: 'zh' },
  // 黃仁勳單搜全是財經新聞（費半、記憶體），會吵的發言（「亞洲父母養的孩子要看心理醫生」）只在 Threads 上傳、新聞沒報，抓不到
  { q: '黃仁勳 爭議', locale: 'zh' },
  { q: '提示詞', locale: 'zh' },
  { q: 'ChatGPT lawsuit OR death OR suicide', locale: 'en' },
  { q: 'AI deepfake', locale: 'en' },
  { q: 'OpenAI controversy', locale: 'en' },
]

const LOCALE = { zh: 'hl=zh-TW&gl=TW&ceid=TW:zh-Hant', en: 'hl=en-US&gl=US&ceid=US:en' }

async function searchNews(q: string, locale: 'zh' | 'en'): Promise<Article[]> {
  try {
    const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&${LOCALE[locale]}`, {
      headers: { 'User-Agent': UA },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return []
    const xml = await res.text()
    const out: Article[] = []
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const raw = (m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      const link = m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? ''
      const src = (m[1].match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? 'Google News').replace(/&amp;/g, '&')
      const date = m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? ''
      // 標題結尾的「 - 媒體名」拿掉，併話題時才不會被媒體名帶偏
      const 標題 = raw.replace(/\s+-\s+[^-]+$/, '').trim()
      if (!標題 || !link) continue
      out.push({ 標題, 原文連結: link, 來源: src, 摘要: '', 發布時間: date })
      if (out.length >= PER_QUERY) break
    }
    return out
  } catch {
    return []
  }
}

// 同一件事各家標題幾乎一樣（中央社稿被轉載），去掉標點空白比對
const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')

export async function collectThreadsNews(): Promise<Article[]> {
  const lists = await Promise.all(QUERIES.map((x) => searchNews(x.q, x.locale)))
  const seen = new Set<string>()
  const out: Article[] = []
  for (const a of lists.flat()) {
    const k = norm(a.標題)
    if (seen.has(k) || seen.has(a.原文連結)) continue
    seen.add(k)
    seen.add(a.原文連結)
    out.push(a)
  }
  return out
}

// 打分的標準就是 2026-10-29 在 Threads 上看到的：哪種事有人轉、有人吵。
const SCORE_PROMPT = `你是台灣 Threads 的 AI 話題小編。我會給你一批最近一週的 AI 新聞話題（每個有編號、話題名稱、幾篇報導標題、幾家媒體報）。
請判斷每個話題「發到 Threads 上會不會爆」，分數 0 到 100。

Threads 台灣用戶實際會轉、會吵的（實測讚數、留言數最高的類型）：
- AI 造假、深偽、詐騙，尤其扯到選舉、名人、網軍（「這支影片是 AI 做的」「假帳號洗政治 AI 影片」）：90-100
- AI 害到人、出事、被告，有具體受害者（「ChatGPT 鼓勵減藥後死亡」）：85-100
- 名人說了引戰的話（「黃仁勳：亞洲父母養的孩子都要看心理醫生」）：75-95
- 台灣在地、跟政治人物或選舉有關的 AI 爭議（「立委用 AI 做競選網站被指抄對手提示詞」）：80-95
- 誇張的突破，一般人看不懂細節但有梗可以玩（「OpenAI 推翻數學假說，數學家要失業」）：70-90
- 工作被取代、裁員、學生都用 AI 寫報告：65-85
- 跟錢有關：免費、漲價、額度縮水、訂閱該留哪個：55-75
- 反 AI 情緒、AI 讓生活變糟：55-75

幾乎沒人轉的，一律 30 分以下：
- 新產品、新模型、新功能發表（「Gemini 4 Carbon 推出」「Claude Duet 上線」「Siri 新功能」）
- 企業導入、合作、採購（「Uber 全員用 ChatGPT」）
- 上市、募資、財報、股價、市值
- 技術規格、跑分、研究報告、政策白皮書、研討會

同一個話題同時符合好幾種，取最高的。每個話題回：
- 分數：0-100
- 爆點：一句 15 字內講它在 Threads 上會被怎麼討論（例：「選前 AI 造謠，大家搶著揭穿」）；30 分以下給空字串

回傳 JSON：{"結果":[{"編號":1,"分數":92,"爆點":"…"}]}
每個都要回，編號要一致。只回 JSON。`

const SCORE_BATCH = 30

type Scored = { 分數: number; 爆點: string }

async function scoreBatch(topics: Omit<Topic, '熱度' | '明細'>[], offset: number): Promise<Map<number, Scored>> {
  const list = topics
    .map((t, i) => {
      const titles = t.文章.slice(0, 3).map((a) => `「${a.標題.slice(0, 60)}」`).join(' ')
      return `[${offset + i + 1}] ${t.話題}｜${outlets(t)} 家媒體｜${titles}`
    })
    .join('\n')
  const raw = await chatJSON(SCORE_PROMPT, list, 60 * topics.length + 200, 0)
  const out = new Map<number, Scored>()
  try {
    for (const r of (JSON.parse(raw) as { 結果?: Record<string, unknown>[] }).結果 ?? []) {
      const i = Number(r.編號) - 1
      if (!Number.isInteger(i) || i < offset || i >= offset + topics.length) continue
      out.set(i, { 分數: Math.max(0, Math.min(100, Number(r.分數) || 0)), 爆點: String(r.爆點 ?? '') })
    }
  } catch {
    // 壞 JSON：這一批當 0 分，不賠掉整輪
  }
  return out
}

const outlets = (t: Pick<Topic, '文章'>) => new Set(t.文章.map((a) => a.來源)).size

// 熱度＝「會不會爆」七成＋「多少家媒體在報」三成。只看 LLM 分數的話，一篇小報的聳動標題會跟全台都在報的事同分；
// 只看媒體數又回到「大新聞」而不是「Threads 愛看的」。媒體數 12 家算滿。
const log01 = (v: number, full: number) => Math.min(1, Math.log10(1 + v) / Math.log10(1 + full))

// clusterTopics 照「主角」分組，台灣新聞常常只寫得出「ChatGPT」「OpenAI」這種公司名當主角，
// 結果一個「ChatGPT」話題底下塞 46 篇不相干的事（減藥致死、宗教提問、使用技巧），熱度又被 46 篇灌到 100。
// 籠統的組再問一次 LLM，拆成具體的事件；拆不出具體事件的文章就丟掉（多半是教學、評測、泛論）。
const SPLIT_PROMPT = `下面這批新聞標題都提到同一家 AI 公司或產品，但講的是很多不同的事。請把「講同一件具體的事」的標題併成一組。
具體的事＝有特定的人、案件、事件、爭議、發言（「華人女工程師聽 ChatGPT 減藥後死亡、家屬提告」「OpenAI 服務大當機」）。
泛泛的使用教學、產品評測、趨勢分析、股價財經這種沒有特定事件的，不要放進任何一組。
每組給：
- 話題：繁體中文 15 字內講這件事
- 必含：報導標題提到這件事一定會有的一個詞（人名、案名、關鍵字，例：「減藥」「當機」）
- 編號：屬於這件事的標題編號
回傳 JSON：{"事件":[{"話題":"…","必含":"…","編號":[1,4]}]}，一組都沒有就回 {"事件":[]}。只回 JSON。`

const SPLIT_MIN = 3 // 籠統組至少幾篇才拆；兩篇以下直接當一則

type Draft = Omit<Topic, '熱度' | '明細'>

async function splitGeneric(t: Draft): Promise<Draft[]> {
  const list = t.文章.map((a, i) => `[${i + 1}] ${a.標題.slice(0, 80)}｜${a.來源}`).join('\n')
  try {
    const raw = await chatJSON(SPLIT_PROMPT, list, 50 * t.文章.length + 300, 0)
    const rows = ((JSON.parse(raw) as { 事件?: Record<string, unknown>[] }).事件 ?? []) as { 話題?: string; 必含?: string; 編號?: number[] }[]
    return rows
      .map((r) => ({
        話題: String(r.話題 ?? ''),
        查詢: String(r.必含 ?? t.查詢),
        必含: String(r.必含 ?? t.必含),
        種類: '事件' as const,
        文章: (r.編號 ?? []).map((n) => t.文章[Number(n) - 1]).filter(Boolean),
      }))
      .filter((d) => d.話題 && d.文章.length)
  } catch {
    return [] // 拆失敗就整組丟掉，不讓一大包籠統話題霸占第一名
  }
}

export async function threadsTopics(): Promise<Topic[]> {
  const articles = await collectThreadsNews()
  if (!articles.length) return []
  const raw = await clusterTopics(articles)
  const big = raw.filter((t) => t.種類 === '籠統' && t.文章.length >= SPLIT_MIN)
  const split = await Promise.all(big.map(splitGeneric))
  const clustered = [...raw.filter((t) => !big.includes(t)), ...split.flat()]
  const scores = new Map<number, Scored>()
  const offsets: number[] = []
  for (let i = 0; i < clustered.length; i += SCORE_BATCH) offsets.push(i)
  const maps = await Promise.all(offsets.map((off) => scoreBatch(clustered.slice(off, off + SCORE_BATCH), off)))
  for (const m of maps) for (const [k, v] of m) scores.set(k, v)

  // 先算好分數，再把同一件事併起來（併完重算媒體數與熱度）
  const scored = clustered.map((t, i) => ({ ...t, s: scores.get(i) ?? { 分數: 0, 爆點: '' } }))
  const merged = await mergeSame(scored)

  return merged
    .map((t) => {
      const 媒體數 = outlets(t)
      const 明細: Heat = {
        hn: 0,
        hn篇數: 0,
        新聞: t.文章.length,
        搜尋: null,
        來源數: 媒體數,
        hn相關度: 1,
        新聞相關度: 1,
        爆點分: t.s.分數,
        爆點: t.s.爆點,
      }
      const { s, ...rest } = t
      return { ...rest, 熱度: Math.round(s.分數 * W.爆點 + log01(媒體數, 12) * 100 * W.媒體), 明細 }
    })
    .sort((a, b) => b.熱度 - a.熱度)
}

// 熱度權重：一家媒體報的國外深偽小新聞，爆點分 100 照 7:3 算也有 78 分，跟全台在報的事擠在一起；改 6:4 拉開
const W = { 爆點: 0.6, 媒體: 0.4 }

// 同一件事會被拆成好幾則：clusterTopics 的主角寫法不同、拆籠統組時又各拆一份
// （實測 ChatGPT 減藥致死同時佔第 1、6、11、20 名；西班牙總理夫人深偽兩則）。
// 只併有機會上板的（爆點分 50 以上），一次 LLM 呼叫。
const MERGE_PROMPT = `下面是一批 AI 新聞話題，每個有編號、話題名稱、一篇代表標題。有些其實是同一件具體的事，只是名稱寫法不同
（例：「華人女工程師聽信 ChatGPT 減藥致死」「家長控 OpenAI 導致女兒死亡」「GPT-4o 醫療建議致死案」是同一件事）。
請找出「講同一件具體的事」的話題組；只是同一類（都是深偽、都是裁員）但不同案件的不要併。
回傳 JSON：{"合併":[[1,6,11],[14,21]]}，沒有就回 {"合併":[]}。只回 JSON。`

type ScoredDraft = Draft & { s: Scored }

async function mergeSame(topics: ScoredDraft[]): Promise<ScoredDraft[]> {
  const hot = topics.filter((t) => t.s.分數 >= 50).sort((a, b) => b.s.分數 - a.s.分數).slice(0, 80)
  if (hot.length < 2) return topics
  const list = hot.map((t, i) => `[${i + 1}] ${t.話題}｜${t.文章[0]?.標題.slice(0, 60) ?? ''}`).join('\n')
  let sets: number[][] = []
  try {
    sets = (JSON.parse(await chatJSON(MERGE_PROMPT, list, 800, 0)) as { 合併?: number[][] }).合併 ?? []
  } catch {
    return topics // 併失敗就維持原樣，頂多重複幾則
  }
  const gone = new Set<ScoredDraft>()
  for (const set of sets) {
    const group = [...new Set(set.map((n) => hot[Number(n) - 1]).filter((t) => t && !gone.has(t)))]
    if (group.length < 2) continue
    // 留文章最多的那則當主體（名稱、查詢最可能是大家在用的），分數取最高
    group.sort((a, b) => b.文章.length - a.文章.length)
    const [main, ...rest] = group
    const urls = new Set(main.文章.map((a) => a.原文連結))
    for (const t of rest) {
      for (const a of t.文章) if (!urls.has(a.原文連結)) (urls.add(a.原文連結), main.文章.push(a))
      if (t.s.分數 > main.s.分數) main.s = t.s
      gone.add(t)
    }
  }
  return topics.filter((t) => !gone.has(t))
}
