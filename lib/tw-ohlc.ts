// 台股日 K 線：TWSE（上市）／TPEx（上櫃）官方端點
//
// 為什麼不繼續用 Yahoo：Zeabur 的機房出口 IP 被 query1.finance.yahoo.com 擋掉，
// 線上每一檔都抓不到。因為 fetchYahoo 在 !res.ok 時只是 return null，上層一律
// 翻成「查無此代號」，所以症狀看起來像資料壞掉、實際上是整個 host 連不進去。
// 同一台機器上 TWSE/TPEx 是通的（/api/universe 一直正常），故日 K 改吃官方來源。
//
// 代價：官方端點是「一檔一個月」一次呼叫，湊滿季線需要的 >120 個交易日要抓 7 個月。
// 30 檔 × 7 個月 = 210 個請求，直接並發會被 TWSE 限流，所以這裡配了兩層防護：
//   1) 全域併發閘門（MAX_CONCURRENT），限制同時在飛的請求數
//   2) 每檔快取（CACHE_TTL），同一個交易日內重複健檢不會重打
import type { Candle } from './stock'

const HISTORY_MONTHS = 7 // 約 140 個交易日，夠算季線(60)與畫圖(120)
const MAX_CONCURRENT = 6
const CACHE_TTL = 6 * 3600 * 1000

// ---------- 全域併發閘門 ----------
let inFlight = 0
const waiters: Array<() => void> = []
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r))
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
    waiters.shift()?.() // 放行下一個排隊者
  }
}

// ---------- 小工具 ----------
// 民國日期 "115/07/01" → unix 秒（與 Yahoo 的 time 欄位同單位）
function rocToEpoch(roc: string): number | null {
  const m = String(roc).trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/)
  if (!m) return null
  return Date.UTC(Number(m[1]) + 1911, Number(m[2]) - 1, Number(m[3])) / 1000
}

// "2,495.00" → 2495；"--"（當天無成交）→ null
function num(s: unknown): number | null {
  const v = Number(String(s ?? '').replace(/,/g, '').trim())
  return Number.isFinite(v) ? v : null
}

// 近 n 個月（含本月），以台北時間為準
function recentMonths(n: number): Array<{ y: number; m: number }> {
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' })
  let y = Number(today.slice(0, 4))
  let m = Number(today.slice(5, 7))
  const out: Array<{ y: number; m: number }> = []
  for (let i = 0; i < n; i++) {
    out.push({ y, m })
    if (--m === 0) { m = 12; y-- }
  }
  return out.reverse() // 由舊到新
}

// 官方表格列 → Candle。TWSE 與 TPEx 的 OHLC 都落在索引 3~6，只有成交量單位不同。
function rowToCandle(row: unknown[], volumeMultiplier: number): Candle | null {
  const time = rocToEpoch(String(row[0]))
  const open = num(row[3]), high = num(row[4]), low = num(row[5]), close = num(row[6])
  if (time == null || open == null || high == null || low == null || close == null) return null // 無成交日
  return { time, open, high, low, close, volume: (num(row[1]) ?? 0) * volumeMultiplier }
}

async function getJson(url: string): Promise<any | null> {
  return withSlot(async () => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null // 逾時／連線失敗都當這個月沒資料，讓其他月份照常補上
    }
  })
}

// ---------- 上市（TWSE）----------
async function twseMonth(code: string, y: number, m: number): Promise<Candle[]> {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${y}${String(m).padStart(2, '0')}01&stockNo=${code}&response=json`
  const j = await getJson(url)
  if (!j || j.stat !== 'OK' || !Array.isArray(j.data)) return []
  return (j.data as unknown[][]).map((r) => rowToCandle(r, 1)).filter((c): c is Candle => c !== null) // TWSE 成交量單位＝股
}

// 從 title「115年07月 2330 台積電  各日成交資訊」取中文名
function twseName(title: unknown, code: string): string | undefined {
  const m = String(title ?? '').match(new RegExp(`${code}\\s+(\\S+)`))
  return m ? m[1].trim() : undefined
}

// ---------- 上櫃（TPEx）----------
async function tpexMonth(code: string, y: number, m: number): Promise<{ candles: Candle[]; name?: string }> {
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${y}/${String(m).padStart(2, '0')}/01&id=&response=json`
  const j = await getJson(url)
  const table = j?.tables?.[0]
  if (!table || !Array.isArray(table.data)) return { candles: [] }
  // TPEx 成交量單位＝張，×1000 換成股，與 TWSE 對齊
  const candles = (table.data as unknown[][]).map((r) => rowToCandle(r, 1000)).filter((c): c is Candle => c !== null)
  const name = String(table.subtitle ?? '').match(new RegExp(`${code}\\s+(\\S+)`))?.[1]
  return { candles, name }
}

// ---------- 對外 ----------
export type TwOhlc = { candles: Candle[]; name?: string; market: 'TWSE' | 'TPEx' }

const cache = new Map<string, { at: number; data: TwOhlc | null }>()

// 抓單一台股代號的日 K。先用「本月一次呼叫」判斷它是上市還是上櫃，
// 確定交易所後才展開其餘月份——省掉對錯誤市場的 7 次無效請求。
export async function fetchTwCandles(code: string): Promise<TwOhlc | null> {
  const key = code.trim()
  if (!/^\d{4,6}[A-Z]?$/.test(key)) return null // 非台股代號（美股等）交給呼叫端退回 Yahoo

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data

  const months = recentMonths(HISTORY_MONTHS)
  const probe = months[months.length - 1] // 本月

  let market: 'TWSE' | 'TPEx' | null = null
  let name: string | undefined
  const collected = new Map<number, Candle>()

  // 步驟一：本月探測，決定交易所
  const twseProbeUrl = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${probe.y}${String(probe.m).padStart(2, '0')}01&stockNo=${key}&response=json`
  const tw = await getJson(twseProbeUrl)
  if (tw?.stat === 'OK' && Array.isArray(tw.data) && tw.data.length) {
    market = 'TWSE'
    name = twseName(tw.title, key)
    for (const r of tw.data as unknown[][]) {
      const c = rowToCandle(r, 1)
      if (c) collected.set(c.time, c)
    }
  } else {
    const tp = await tpexMonth(key, probe.y, probe.m)
    if (tp.candles.length) {
      market = 'TPEx'
      name = tp.name
      for (const c of tp.candles) collected.set(c.time, c)
    }
  }
  // 月初剛開盤、本月還沒有資料時探測會落空——退一個月再試一次，避免整檔誤判成查無此代號
  if (!market && months.length > 1) {
    const prev = months[months.length - 2]
    const tw2 = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${prev.y}${String(prev.m).padStart(2, '0')}01&stockNo=${key}&response=json`)
    if (tw2?.stat === 'OK' && Array.isArray(tw2.data) && tw2.data.length) {
      market = 'TWSE'
      name = twseName(tw2.title, key)
      for (const r of tw2.data as unknown[][]) {
        const c = rowToCandle(r, 1)
        if (c) collected.set(c.time, c)
      }
    } else {
      const tp2 = await tpexMonth(key, prev.y, prev.m)
      if (tp2.candles.length) {
        market = 'TPEx'
        name = tp2.name
        for (const c of tp2.candles) collected.set(c.time, c)
      }
    }
  }
  if (!market) {
    cache.set(key, { at: Date.now(), data: null }) // 確實查無此代號，也快取避免反覆重打
    return null
  }

  // 步驟二：其餘月份平行補齊（併發閘門會自動排隊）
  const rest = months.slice(0, months.length - 1)
  const chunks = await Promise.all(
    rest.map(async ({ y, m }) =>
      market === 'TWSE' ? await twseMonth(key, y, m) : (await tpexMonth(key, y, m)).candles
    )
  )
  for (const chunk of chunks) for (const c of chunk) collected.set(c.time, c)

  const candles = [...collected.values()].sort((a, b) => a.time - b.time)
  const data: TwOhlc = { candles, name, market }
  cache.set(key, { at: Date.now(), data })
  return data
}

// 加權指數日 K（TWSE 官方），取代 Yahoo 的 ^TWII
export async function fetchTaiexCandles(): Promise<Candle[]> {
  const key = '__TAIEX__'
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data?.candles ?? []

  const collected = new Map<number, Candle>()
  const chunks = await Promise.all(
    recentMonths(HISTORY_MONTHS).map(async ({ y, m }) => {
      const j = await getJson(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${y}${String(m).padStart(2, '0')}01&response=json`)
      if (!j || j.stat !== 'OK' || !Array.isArray(j.data)) return []
      // 指數表只有 日期/開/高/低/收（無成交量），欄位位移與個股不同
      return (j.data as unknown[][])
        .map((r) => {
          const time = rocToEpoch(String(r[0]))
          const open = num(r[1]), high = num(r[2]), low = num(r[3]), close = num(r[4])
          if (time == null || open == null || high == null || low == null || close == null) return null
          return { time, open, high, low, close, volume: 0 }
        })
        .filter((c): c is Candle => c !== null)
    })
  )
  for (const chunk of chunks) for (const c of chunk) collected.set(c.time, c)

  const candles = [...collected.values()].sort((a, b) => a.time - b.time)
  cache.set(key, { at: Date.now(), data: { candles, market: 'TWSE' } })
  return candles
}
