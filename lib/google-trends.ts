// Google Trends 網頁背後的介面（非官方）：竄升相關搜尋、搜尋量比較。
// 官方 Trends API 要申請才能用；這個介面網頁自己在用。實測 2026-09-23：一輪 50 個請求沒事，
// 但同一天開發時打了幾百個之後整個 429。所以三層防護：
//   請求間隔 3 秒、被擋就等一分鐘重試（最多兩次）、結果快取 3 小時（新聞板和 LINE 推播共用，竄升清單本來就變得慢）。
// 還是被擋就往外丟 TrendsBlockedError，呼叫端退回別的做法。
import { promises as fs } from 'fs'
import path from 'path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const TIMEOUT_MS = 15_000
const GAP_MS = 3000 // 請求間隔
const BACKOFF_MS = 60_000 // 429 之後等多久再試
const RETRIES = 2
const CACHE_FILE = path.join(process.cwd(), 'data', 'trends-cache.json')
const CACHE_TTL_MS = 3 * 3600_000

// geo：'TW'＝台灣、'US'＝美國、''＝全球
export type Geo = 'TW' | 'US' | ''

export class TrendsBlockedError extends Error {
  constructor(status: number) {
    super(`Google Trends 擋下請求（HTTP ${status}）`)
    this.name = 'TrendsBlockedError'
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class TrendsClient {
  private cookie = ''
  private last = 0

  private async init() {
    if (this.cookie) return
    const res = await fetch('https://trends.google.com/trends/?geo=TW', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    this.cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') || 'x=1'
  }

  // 快取：key 是「做什麼＋參數」，不是網址——網址裡的 token 每次都不一樣
  private cache: Record<string, { at: number; data: unknown }> | null = null
  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache) this.cache = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8').catch(() => '{}'))
    const hit = this.cache![key]
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T
    const data = await fn()
    this.cache![key] = { at: Date.now(), data }
    // 過期的順手清掉，檔案不會一直長
    for (const [k, v] of Object.entries(this.cache!)) if (Date.now() - v.at > CACHE_TTL_MS) delete this.cache![k]
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true }).catch(() => {})
    await fs.writeFile(CACHE_FILE, JSON.stringify(this.cache)).catch(() => {}) // 寫不進去（唯讀環境）就只是沒快取
    return data
  }

  // 回應前面有一段防 XSSI 的垃圾（")]}'"），從第一個 { 開始才是 JSON
  private async get(url: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    await this.init()
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const wait = this.last + GAP_MS - Date.now()
      if (wait > 0) await sleep(wait)
      this.last = Date.now()
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Cookie: this.cookie },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.status === 429 && attempt < RETRIES) {
        await sleep(BACKOFF_MS)
        continue
      }
      if (!res.ok) throw new TrendsBlockedError(res.status)
      const text = await res.text()
      return JSON.parse(text.slice(text.indexOf('{')))
    }
    throw new TrendsBlockedError(429)
  }

  private async explore(keywords: string[], geo: Geo, time = 'now 7-d') {
    const req = { comparisonItem: keywords.map((k) => ({ keyword: k, geo, time })), category: 0, property: '' }
    const data = await this.get(
      `https://trends.google.com/trends/api/explore?hl=zh-TW&tz=-480&req=${encodeURIComponent(JSON.stringify(req))}`
    )
    return data.widgets as { id: string; request: unknown; token: string }[]
  }

  // 某個詞過去 7 天的竄升相關搜尋：[搜尋詞, 漲幅]。漲幅是 Google 給的字串，「飆升」＝超過 5000%。
  async rising(keyword: string, geo: Geo): Promise<{ query: string; growth: string; value: number }[]> {
    return this.cached(`rising|${keyword}|${geo}`, () => this.risingRaw(keyword, geo))
  }
  private async risingRaw(keyword: string, geo: Geo): Promise<{ query: string; growth: string; value: number }[]> {
    const w = (await this.explore([keyword], geo)).find((x) => x.id === 'RELATED_QUERIES')
    if (!w) return []
    const data = await this.get(
      `https://trends.google.com/trends/api/widgetdata/relatedsearches?hl=zh-TW&tz=-480&req=${encodeURIComponent(
        JSON.stringify(w.request)
      )}&token=${w.token}`
    )
    const lists = data.default?.rankedList ?? []
    const rising = (lists[1]?.rankedKeyword ?? []) as { query: string; formattedValue: string; value: number }[]
    return rising.map((x) => ({ query: x.query, growth: x.formattedValue, value: x.value }))
  }

  // 幾個詞跟對照詞比過去 7 天的平均搜尋量，回傳「是對照詞的幾倍」。一次最多 4 個詞（加對照詞共 5 個，Trends 的上限）。
  // 被擋的那批就跳過（那幾個詞沒有值），不讓整輪失敗。
  async ratios(keywords: string[], anchor: string, geo: Geo): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    for (let i = 0; i < keywords.length; i += 4) {
      const batch = keywords.slice(i, i + 4)
      const got = await this.cached(`ratios|${anchor}|${geo}|${batch.join('|')}`, () =>
        this.ratiosRaw(batch, anchor, geo)
      ).catch((e) => {
        if (e instanceof TrendsBlockedError) return {} as Record<string, number>
        throw e
      })
      for (const [k, v] of Object.entries(got)) out.set(k, v)
    }
    return out
  }
  private async ratiosRaw(batch: string[], anchor: string, geo: Geo): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    {
      const kws = [anchor, ...batch]
      const w = (await this.explore(kws, geo)).find((x) => x.id === 'TIMESERIES')
      if (!w) return out
      const data = await this.get(
        `https://trends.google.com/trends/api/widgetdata/multiline?hl=zh-TW&tz=-480&req=${encodeURIComponent(
          JSON.stringify(w.request)
        )}&token=${w.token}`
      )
      const avgs = (data.default?.averages ?? []) as number[]
      const base = avgs[0] || 0
      // 對照詞在這個地區搜尋量是 0（台灣有時會這樣）就比不出來，整批跳過，不要除以 0
      if (!base) return out
      kws.slice(1).forEach((k, j) => (out[k] = (avgs[j + 1] ?? 0) / base))
    }
    return out
  }
}
