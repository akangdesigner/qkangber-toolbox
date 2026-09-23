// 從 Google Trends 找話題：先看大家在搜什麼，再去找對應的新聞。
//
// 為什麼反過來做：「先抓新聞、再量熱度」只看得到來源裡有的東西，熱度又是拿 HN（工程師圈）量的，
// 結果板上一排「某某發表新模型」——HN 很熱，圈外沒人搜（2026-09-23：Opus 5.5、Grok 4.7、MiMo 搜尋量都幾乎是 0）。
// 使用者要的是流量：Google 上越多人搜越好。同一天從「AI」「Claude」等種子詞的竄升搜尋直接挖到
// Jev（台灣、全球都是第一）、Michael Burry 放空 AI 股、Claude 被拿來駭 OpenAI、美軍 AI 情報誤判——
// 前三個新聞來源那套全部沒排上來或根本沒抓到。
//
// 流程：種子詞 → 台灣＋全球的竄升相關搜尋 → LLM 把講同一件事的搜尋詞併起來、丟掉錯字和雜訊
//      → 台灣、全球各跟對照詞比搜尋量 → 取比較高的那邊當熱度 → Google News 找這件事的報導
import { chatJSON } from '@/lib/llm-json'
import { TrendsBlockedError, TrendsClient, type Geo } from '@/lib/google-trends'
import type { Article, Heat, Topic } from '@/lib/news-trending'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

// 種子詞：竄升搜尋是「跟這個詞一起被搜、而且暴增的詞」，所以種子決定撈得到哪一類。
// 「AI stocks」是使用者點名喜歡的 AI 概念股那類（實測撈到 michael burry ai stocks short +1450%）；
// 「AI 股」「AI 教育」在台灣資料太少，實測回空的，就不放。「AI education」在全球會撈到「怎麼煮義大利麵」，也不放。
// 找話題用台灣＋美國（美國的竄升清單新聞事件最多：「us military ai false intelligence report」
// 「smartphone ai settlement」只在美國清單出現，全球清單沒有）；量搜尋量才用台灣＋全球，見 trendsTopics。
const SEEDS: { kw: string; geo: Geo }[] = [
  { kw: 'AI', geo: 'TW' },
  { kw: 'ChatGPT', geo: 'TW' },
  { kw: 'Gemini', geo: 'TW' },
  { kw: 'Claude', geo: 'TW' },
  { kw: 'AI', geo: 'US' },
  { kw: 'ChatGPT', geo: 'US' },
  { kw: 'Claude', geo: 'US' },
  { kw: 'Gemini', geo: 'US' },
  { kw: 'OpenAI', geo: 'US' },
  { kw: 'AI stocks', geo: 'US' },
]

// 量搜尋量的對照詞。要夠穩定、又不能大到把其他詞壓成 0（ChatGPT 就太大）。
// 實測全球：Jev 是它的 0.7 倍、GPT-6 0.11 倍、Opus 5.5 0.02 倍，刻度拉得開。
const ANCHOR = 'Claude AI'

const GEO_NAME: Record<Geo, string> = { TW: '台灣', US: '美國', '': '全球' }

type Rising = { query: string; growth: string; value: number; geo: Geo; seed: string }

const GROUP_PROMPT = `我從 Google Trends 抓了一批「最近 7 天竄升的搜尋詞」，每個有編號、地區、漲幅、是從哪個種子詞帶出來的。
請把「在搜同一件事」的搜尋詞併成一個話題，並丟掉沒用的。

跟 AI 有關的搜尋詞每一個都要留下來，只有一個搜尋詞也可以自成一個話題——冷不冷門我會另外用搜尋量判斷，你不要先篩。
例如「zsky ai」「80 年代 ai」「ai 女友」「chatgpt edu」「anthropic claude used to hack openai」都要留。

同一件事一定要併在一起：產品本名、公司名、版本寫法不同都是同一個（「jev」「jev ai」「typesafe ai」是同一個；
「opus 5.5」「claude 5.5」「claude opus5.5」「claude code opus 5.5」是同一個；「gpt 6 sol」「chatgpt 6 sol」是同一個）。

只有這些要丟掉：
- 錯字、網址、登入、下載、當機查詢這種導航用的搜尋（「chatgpt login」「chatgpt.com」「is chatgpt down」「gemeni」「cha」）
- 跟 AI 無關的（「how to make sushi」「walmart near me」「claude monet」「claude le roy」、人名網站）
- 只是某支股票代號、沒有新聞事件的（「amzn stock」「fintechzoom.io stocks」）；有事件的要留（「michael burry ai stocks short」）

每個話題給：
- 話題：繁體中文 20 字內，講大家在搜的是什麼事（例：「Jev 決策模型爆紅」「Michael Burry 放空 AI 股」）
- 查詢：拿去 Google Trends 比搜尋量的詞，1-2 個字，是一般人搜這件事最常打的寫法（「jev」不是「jev ai」；
  「michael burry」不是「michael burry ai stocks short」——整句太長，實際搜尋量會是 0）
- 新聞查詢：拿去 Google News 找報導的英文關鍵字，2-4 個字，要能精準找到這件事（「Jev TypeSafe」「Michael Burry AI stocks」）
- 必含：報導標題提到這件事時一定會有的一個字（「Jev」「Burry」「Opus 5.5」）
- 編號：屬於這個話題的搜尋詞編號

回傳 JSON：{"話題":[{"話題":"…","查詢":"…","新聞查詢":"…","必含":"…","編號":[1,3]}]}
只回 JSON。`

type Group = { 話題: string; 查詢: string; 新聞查詢: string; 必含: string; 搜尋詞: Rising[] }

async function groupQueries(rising: Rising[]): Promise<Group[]> {
  const list = rising
    .map((r, i) => `[${i + 1}] ${r.query}｜${GEO_NAME[r.geo]}｜${r.growth}｜種子：${r.seed}`)
    .join('\n')
  const raw = await chatJSON(GROUP_PROMPT, list, 4000, 0)
  const rows = ((JSON.parse(raw) as { 話題?: Record<string, unknown>[] }).話題 ?? []) as {
    話題?: string
    查詢?: string
    新聞查詢?: string
    必含?: string
    編號?: number[]
  }[]
  const out: Group[] = []
  for (const r of rows) {
    const 搜尋詞 = (r.編號 ?? []).map((n) => rising[Number(n) - 1]).filter(Boolean)
    if (!r.話題 || !r.查詢 || !搜尋詞.length) continue
    out.push({
      話題: r.話題,
      查詢: r.查詢.trim(),
      新聞查詢: (r.新聞查詢 || r.查詢).trim(),
      必含: (r.必含 || r.查詢).trim(),
      搜尋詞,
    })
  }
  return out
}

// 漲幅字串 → 數字，拿來挑「最猛的那個」顯示：「飆升」＝ 5000% 以上
function growthNum(g: string): number {
  if (/飆升|breakout/i.test(g)) return 5000
  return Number(g.replace(/[^\d]/g, '')) || 0
}

// Google News 找報導：英文、台灣中文各找一次。標題要含「必含」才算，搜尋是模糊比對。
async function findNews(g: Group): Promise<Article[]> {
  const search = async (q: string, locale: string) => {
    try {
      const res = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:7d`)}&${locale}`, {
        headers: { 'User-Agent': UA },
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return []
      const xml = await res.text()
      const out: Article[] = []
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const title = (m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
        const link = m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? ''
        const date = m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? ''
        const src = m[1].match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? 'Google News'
        if (!title || !link || !title.toLowerCase().includes(g.必含.toLowerCase())) continue
        out.push({ 標題: title, 原文連結: link, 來源: src.replace(/&amp;/g, '&'), 摘要: '', 發布時間: date })
        if (out.length >= 8) break
      }
      return out
    } catch {
      return []
    }
  }
  const [en, zh] = await Promise.all([
    search(g.新聞查詢, 'hl=en-US&gl=US&ceid=US:en'),
    search(g.新聞查詢, 'hl=zh-TW&gl=TW&ceid=TW:zh-Hant'),
  ])
  return [...en, ...zh]
}

// 搜尋量換成 0-100，對數刻度：對照詞的 5 倍＝滿分。
// 以前用「對照詞的一半」當滿分，台灣的 Claude AI 搜的人少，一比之下 6 個話題都頂到 100 分，排不出高低。
const volScore = (ratio: number | null) =>
  ratio === null ? 0 : Math.round(Math.min(1, Math.log10(1 + Math.max(0, ratio) * 100) / Math.log10(1 + 500)) * 100)

export async function trendsTopics(): Promise<Topic[]> {
  const tc = new TrendsClient()

  // 1. 竄升搜尋
  // 一個種子被擋就跳過，用其他的；全部被擋才往外丟，讓呼叫端退回新聞來源那套
  const rising: Rising[] = []
  let blocked = 0
  for (const s of SEEDS) {
    try {
      const rs = await tc.rising(s.kw, s.geo)
      for (const r of rs) rising.push({ ...r, geo: s.geo, seed: s.kw })
    } catch (e) {
      if (!(e instanceof TrendsBlockedError)) throw e
      blocked++
    }
  }
  if (blocked === SEEDS.length) throw new TrendsBlockedError(429)
  if (!rising.length) return []

  // 2. 併話題
  const groups = await groupQueries(rising)
  if (!groups.length) return []

  // 3. 台灣、全球各比一次搜尋量（同一個對照詞，分數才比得起來）
  const queries = [...new Set(groups.map((g) => g.查詢))]
  const [tw, world] = [await tc.ratios(queries, ANCHOR, 'TW'), await tc.ratios(queries, ANCHOR, '')]

  // 4. 找報導，找不到報導的話題寫不出摘要，丟掉
  const topics: Topic[] = []
  await Promise.all(
    groups.map(async (g) => {
      const 文章 = await findNews(g)
      if (!文章.length) return
      const 台灣 = tw.has(g.查詢) ? tw.get(g.查詢)! : null
      const 全球 = world.has(g.查詢) ? world.get(g.查詢)! : null
      const best = [...g.搜尋詞].sort((a, b) => growthNum(b.growth) - growthNum(a.growth))[0]
      const 明細: Heat = {
        hn: 0,
        hn篇數: 0,
        新聞: 文章.length,
        搜尋: Math.max(台灣 ?? 0, 全球 ?? 0),
        來源數: new Set(文章.map((a) => a.來源)).size,
        hn相關度: 1,
        新聞相關度: 1,
        台灣,
        全球,
        漲幅: `${GEO_NAME[best.geo]} ${best.growth}`,
        搜尋詞: g.搜尋詞.map((r) => r.query),
      }
      topics.push({
        話題: g.話題,
        查詢: g.新聞查詢,
        必含: g.必含,
        種類: '名稱',
        文章,
        // 台灣、全球取比較高的那邊：「台灣也紅」和「全球爆紅、台灣還沒跟上」都要看得到
        熱度: Math.max(volScore(台灣), volScore(全球)),
        明細,
      })
    })
  )
  return topics.sort((a, b) => b.熱度 - a.熱度)
}
