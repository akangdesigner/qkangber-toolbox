// 台股自選股健檢：抓免費盤後日K（Yahoo Finance chart API），算均線/KD/MACD/多空排列/紅綠燈
// 資料來源說明：Yahoo chart 一次給一整年日K，含上市(.TW)與上櫃(.TWO)；今天的訊號看最後一個收盤判斷。

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }

export type StockHealth = {
  symbol: string // 使用者輸入的代號，如 2330
  resolved: string // 實際抓到的 Yahoo 代號，如 2330.TW
  name: string
  price: number
  prevClose: number
  changePct: number // 當日漲跌幅 %
  dataDate: string // 最後一根日K的台北日期 YYYY-MM-DD（資料新鮮度；訊號日誌用它判斷是否為今日交易資料）
  ma5: number
  ma20: number
  ma60: number
  aboveMa60: boolean // 是否站上季線
  distMa60Pct: number // 距季線 %（正=在季線之上，負=已跌破，可當停損參考）
  arrange: '多頭排列' | '空頭排列' | '糾結盤整' // 均線排列
  k: number
  d: number
  kdCross: '黃金交叉' | '死亡交叉' | '無' // 最新一日 KD 交叉
  kdZone: '超買' | '超賣' | '中性'
  macdHist: number // MACD 柱狀體(OSC) = DIF - MACD
  macdTrend: '多方動能' | '空方動能' // 柱>0 / 柱<0
  dif: number
  signal: 'green' | 'yellow' | 'red' // 紅綠燈
  entry: '帶量突破' | '接近買點' | '強勢偏貴' | '盤整觀望' | '轉弱避開' // 用 SOP 判讀現在的進場時機（帶量突破＝糾結末端爆量起漲）
  // ---- 量價（成交量配合）----
  vol: number | null // 最新成交量（張＝股數/1000）
  volRatio: number | null // 量比＝今量 ÷ 近 5 日均量（>1 放量、<1 縮量）
  volTag: '爆量' | '量增' | '量平' | '量縮' | '窒息量' | '—' // 量能標籤
  volNote: string // 量價配合解讀（漲量增=健康、漲量縮=背離…）
  pe: number | null // 本益比（估值貴不貴，越高越貴；虧損/ETF 無值）
  pb: number | null // 股價淨值比
  dividendYield: number | null // 殖利率 %
  // ---- 波動度（風險：這檔會跳多大）----
  volatilityPct: number // 近60日「平均每日漲跌幅絕對值」%，越大越會跳
  range60Pct: number // 近60日收盤高低振幅 %（最高比最低高多少）
  volLabel: '低波' | '中波' | '高波' // 波動分級：日均<1.5%低、1.5~3%中、>3%高
  stopPct: number // 建議停損距離 %（3.5×日均波動，夾 5~15；回測近2年：固定-6%停損連隨機進場都有約48%機率被雜訊掃出場，停損距離必須隨波動放大）
  stopPrice: number // 建議停損價 = 現價 ×(1 − stopPct/100)，進場前先寫下來
  verdict: string // 一句話結論（技術面）
  // ---- 基本盤（體質）判定：成長(月營收YoY) + 估值(PE/PB/殖利率) ----
  revYoY: number | null // 單月營收年增率 %（最新公布月份；ETF/無資料為 null）
  revYoYCum: number | null // 累計營收年增率 %
  revMonth: string | null // 營收資料月份，如 2026/05
  revMomentum: number | null // 營收動能 = 單月YoY − 累計YoY（>0 成長加速、<0 減速；領先 EPS）
  fundScore: number | null // 基本面體質分數 0~100（中性 50；ETF/無營收資料為 null）
  fundSignal: 'green' | 'yellow' | 'red' | 'na' // 基本面紅綠燈（na=資料不足不適用，如 ETF）
  fundVerdict: string // 一句話基本面結論
  // ---- 籌碼面（領先指標）：三大法人最近交易日買賣超，單位：張 ----
  chipForeign: number | null // 外資買賣超（張，正=買超）
  chipTrust: number | null // 投信買賣超（張，投信連買領先性最強）
  chipTotal: number | null // 三大法人合計買賣超（張）
  chipDate: string | null // 籌碼資料日期，如 2026/06/23
  chipForeignStreak: number // 外資連續買/賣超天數（正=連買、負=連賣、0=無）
  chipTrustStreak: number // 投信連續買/賣超天數（正=連買、負=連賣、0=無）
  chipBothBuy: boolean // 三大法人「同買」：外資與投信最近交易日同步買超（極強短線領先訊號）
  chipSignal: 'buy' | 'sell' | 'neutral' | 'na' // 籌碼方向（na=查無資料）
  chipText: string // 一句話籌碼說明
  // ---- 綜合評分：技術 / 基本 / 籌碼 三柱各 0~100，加權成總分 ----
  techScore: number // 技術面分數 0~100
  chipScore: number | null // 籌碼面分數 0~100（na 為 null）
  overallScore: number // 總分 0~100（依有資料的柱子加權）
  overallVerdict: string // 總分結論＋各柱原因
  series: { close: number[]; open: number[]; high: number[]; low: number[]; ma20: (number | null)[]; ma60: (number | null)[]; k: number[]; d: number[] } // 畫圖用（含 K 棒 OHLC），最近約 120 個交易日
}

// ---------- 指標計算 ----------

function sma(values: number[], period: number): number {
  if (values.length < period) return NaN
  const slice = values.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

// 完整 SMA 序列（資料不足的位置給 null），給畫圖用
function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}

// 完整 EMA 序列
function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}

// KD（9,3,3）：回傳完整 K、D 序列
function kdSeries(candles: Candle[], n = 9): { k: number[]; d: number[] } {
  const k: number[] = []
  const d: number[] = []
  let prevK = 50
  let prevD = 50
  for (let i = 0; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - n + 1), i + 1)
    const high = Math.max(...window.map((c) => c.high))
    const low = Math.min(...window.map((c) => c.low))
    const rsv = high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100
    const curK = prevK * (2 / 3) + rsv * (1 / 3)
    const curD = prevD * (2 / 3) + curK * (1 / 3)
    k.push(curK)
    d.push(curD)
    prevK = curK
    prevD = curD
  }
  return { k, d }
}

// MACD（12,26,9）：回傳 DIF、signal、hist 的最後值
function macd(closes: number[]): { dif: number; signal: number; hist: number } {
  const ema12 = emaSeries(closes, 12)
  const ema26 = emaSeries(closes, 26)
  const dif = closes.map((_, i) => ema12[i] - ema26[i])
  const signal = emaSeries(dif, 9)
  const last = closes.length - 1
  return { dif: dif[last], signal: signal[last], hist: dif[last] - signal[last] }
}

// ---------- 抓資料 ----------

type YahooMeta = { symbol: string; regularMarketPrice?: number; shortName?: string; longName?: string; chartPreviousClose?: number }
type YahooChart = {
  chart: {
    result?: Array<{
      meta: YahooMeta
      timestamp?: number[]
      indicators: { quote?: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> }
    }>
    error?: { code: string; description: string } | null
  }
}

async function fetchYahoo(ySymbol: string): Promise<{ candles: Candle[]; meta: YahooMeta } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?range=1y&interval=1d`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' })
  if (!res.ok) return null
  const json = (await res.json()) as YahooChart
  const result = json.chart?.result?.[0]
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) return null
  const q = result.indicators.quote[0]
  const candles: Candle[] = []
  for (let i = 0; i < result.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i]
    if (o == null || h == null || l == null || c == null) continue // 假日/缺值
    candles.push({ time: result.timestamp[i], open: o, high: h, low: l, close: c, volume: v ?? 0 })
  }
  return { candles, meta: result.meta }
}

// 中文名稱對照表：TWSE（上市含 ETF）+ TPEx（上櫃），整批抓一次快取 12 小時
// full=兩個來源都抓到 → 快取 12 小時；殘缺（某來源失敗）只快取 30 分鐘，逼下次補抓，
// 避免「只有上櫃名單」被長快取、害上市股票全顯示英文。
const NAME_TTL_FULL = 12 * 3600 * 1000
const NAME_TTL_PARTIAL = 30 * 60 * 1000
let nameCache: { map: Record<string, string>; at: number; full: boolean } | null = null
let nameInflight: Promise<Record<string, string>> | null = null
async function getNameMap(): Promise<Record<string, string>> {
  if (nameCache && Date.now() - nameCache.at < (nameCache.full ? NAME_TTL_FULL : NAME_TTL_PARTIAL)) return nameCache.map
  if (nameInflight) return nameInflight // single-flight：避免掃描時 12 路並發同時打表被限流 → 退英文名
  nameInflight = (async () => {
  // 以舊名單為底合併：單一來源這次掛掉，也不會弄丟先前已抓到的名稱
  const map: Record<string, string> = { ...(nameCache?.map ?? {}) }
  try {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' as const }
    const [twse, tpex] = await Promise.all([
      fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', opts).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', opts).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ])
    const tw = twse as Array<{ Code?: string; Name?: string }>
    const tp = tpex as Array<{ SecuritiesCompanyCode?: string; CompanyName?: string }>
    for (const it of tw) if (it.Code && it.Name) map[it.Code.trim()] = it.Name.trim()
    for (const it of tp) if (it.SecuritiesCompanyCode && it.CompanyName) map[it.SecuritiesCompanyCode.trim()] = it.CompanyName.trim()
    const full = tw.length > 0 && tp.length > 0 // 兩份都有資料才算完整
    if (Object.keys(map).length) nameCache = { map, at: Date.now(), full }
  } catch {
    if (nameCache) return nameCache.map
  }
  return nameCache?.map ?? map
  })()
  try { return await nameInflight } finally { nameInflight = null }
}

// 估值對照表：TWSE BWIBBU_ALL（上市）+ TPEx 本益比分析（上櫃），快取 12 小時
type Valuation = { pe: number | null; pb: number | null; yield: number | null }
let valCache: { map: Record<string, Valuation>; at: number } | null = null
let valInflight: Promise<Record<string, Valuation>> | null = null
async function getValuationMap(): Promise<Record<string, Valuation>> {
  if (valCache && Date.now() - valCache.at < 12 * 3600 * 1000) return valCache.map
  if (valInflight) return valInflight // single-flight
  valInflight = (async () => {
  const map: Record<string, Valuation> = {}
  const num = (v: unknown) => {
    const n = Number(String(v ?? '').replace(/,/g, ''))
    return isFinite(n) && n !== 0 ? n : null // 空字串/0 視為無值
  }
  try {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' as const }
    const [twse, tpex] = await Promise.all([
      fetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL', opts).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis', opts).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ])
    for (const it of twse as Array<{ Code?: string; PEratio?: string; PBratio?: string; DividendYield?: string }>)
      if (it.Code) map[it.Code.trim()] = { pe: num(it.PEratio), pb: num(it.PBratio), yield: num(it.DividendYield) }
    for (const it of tpex as Array<{ SecuritiesCompanyCode?: string; PriceEarningRatio?: string; PriceBookRatio?: string; YieldRatio?: string }>)
      if (it.SecuritiesCompanyCode) map[it.SecuritiesCompanyCode.trim()] = { pe: num(it.PriceEarningRatio), pb: num(it.PriceBookRatio), yield: num(it.YieldRatio) }
    if (Object.keys(map).length) valCache = { map, at: Date.now() }
  } catch {
    if (valCache) return valCache.map
  }
  return valCache?.map ?? map
  })()
  try { return await valInflight } finally { valInflight = null }
}

// 月營收對照表：TWSE t187ap05_L（上市）+ TPEx mopsfin_t187ap05_O（上櫃），快取 12 小時
// 每月 10 號前各家公布上月營收，是台股最即時的免費基本面成長訊號
type Revenue = { yoy: number | null; yoyCum: number | null; month: string | null }
let revCache: { map: Record<string, Revenue>; at: number } | null = null
let revInflight: Promise<Record<string, Revenue>> | null = null
async function getRevenueMap(): Promise<Record<string, Revenue>> {
  if (revCache && Date.now() - revCache.at < 12 * 3600 * 1000) return revCache.map
  if (revInflight) return revInflight // single-flight
  revInflight = (async () => {
  const map: Record<string, Revenue> = {}
  const num = (v: unknown) => {
    const n = Number(String(v ?? '').replace(/,/g, ''))
    return isFinite(n) ? Math.round(n * 10) / 10 : null // 年增率取到小數 1 位即可
  }
  // 資料年月 民國 yyyymm（如 11505）→ 西元 2026/05
  const rocMonth = (v: unknown): string | null => {
    const s = String(v ?? '').trim()
    if (!/^\d{5,6}$/.test(s)) return null
    const m = s.slice(-2)
    const y = Number(s.slice(0, -2)) + 1911
    return `${y}/${m}`
  }
  type Row = { 公司代號?: string; '營業收入-去年同月增減(%)'?: string; '累計營業收入-前期比較增減(%)'?: string; 資料年月?: string }
  try {
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' as const }
    const [twse, tpex] = await Promise.all([
      fetch('https://openapi.twse.com.tw/v1/opendata/t187ap05_L', opts).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O', opts).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    ])
    for (const it of [...(twse as Row[]), ...(tpex as Row[])]) {
      const code = it.公司代號?.trim()
      if (!code) continue
      map[code] = {
        yoy: num(it['營業收入-去年同月增減(%)']),
        yoyCum: num(it['累計營業收入-前期比較增減(%)']),
        month: rocMonth(it.資料年月),
      }
    }
    if (Object.keys(map).length) revCache = { map, at: Date.now() }
  } catch {
    if (revCache) return revCache.map
  }
  return revCache?.map ?? map
  })()
  try { return await revInflight } finally { revInflight = null }
}

// 法人籌碼對照表（領先指標）：抓最近 6 個交易日三大法人買賣超，算當日值＋連買/連賣天數。
// 單位轉「張」(股數/1000)。上市 TWSE RWD T86、上櫃 TPEx 帶日期端點，都用陣列位置取值。快取 6 小時。
type ChipDay = { foreign: number | null; trust: number | null; total: number | null }
type Chip = ChipDay & { date: string | null; foreignStreak: number; trustStreak: number }
const DAYS_BACK = 6
let chipCache: { map: Record<string, Chip>; at: number } | null = null

function lotsOf(v: unknown): number | null {
  const n = Number(String(v ?? '').replace(/,/g, ''))
  return isFinite(n) ? Math.round(n / 1000) : null // 股 → 張
}
// 連續同方向天數：陣列 [0]=最近日；正=連買、負=連賣、0=最近日非買賣超或無資料
function streakOf(vals: (number | null)[]): number {
  if (!vals.length || vals[0] == null || vals[0] === 0) return 0
  const sign = vals[0] > 0 ? 1 : -1
  let c = 0
  for (const v of vals) {
    if (v != null && Math.sign(v) === sign) c++
    else break
  }
  return sign * c
}

let chipInflight: Promise<Record<string, Chip>> | null = null
async function getChipMap(): Promise<Record<string, Chip>> {
  if (chipCache && Date.now() - chipCache.at < 6 * 3600 * 1000) return chipCache.map
  if (chipInflight) return chipInflight // single-flight：籌碼要爬 6 個交易日，更不能 12 路重複爬
  chipInflight = (async () => {
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' as const }
  // 收集最近 N 個交易日，每日一張 code → {foreign,trust,total}；[0] 為最近日
  const days: { date: string; map: Record<string, ChipDay> }[] = []

  for (let i = 0; i < 14 && days.length < DAYS_BACK; i++) {
    const dt = new Date(Date.now() - i * 86400000)
    const y = dt.getFullYear(), mm = String(dt.getMonth() + 1).padStart(2, '0'), dd = String(dt.getDate()).padStart(2, '0')
    const ymd = `${y}${mm}${dd}`
    // 上市 T86：[0]代號 [4]外資 [10]投信 [18]三大法人合計
    const tw = await fetch(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=ALLBUT0999&response=json`, opts)
      .then((x) => (x.ok ? x.json() : null)).catch(() => null)
    if (!tw || tw.stat !== 'OK' || !Array.isArray(tw.data)) continue // 非交易日/未出表
    const dayMap: Record<string, ChipDay> = {}
    for (const row of tw.data as string[][]) {
      const code = String(row[0]).trim()
      if (code) dayMap[code] = { foreign: lotsOf(row[4]), trust: lotsOf(row[10]), total: lotsOf(row[18]) }
    }
    // 上櫃同日（民國 yyy/MM/dd）：此端點才會「依日期」回傳；[4]外資 [13]投信 [23]三大法人合計
    const roc = `${y - 1911}/${mm}/${dd}`
    const tp = await fetch(`https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&se=EW&t=D&d=${roc}&response=json`, opts)
      .then((x) => (x.ok ? x.json() : null)).catch(() => null)
    const rows = tp?.tables?.[0]?.data as string[][] | undefined
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const code = String(row[0]).trim()
        if (code) dayMap[code] = { foreign: lotsOf(row[4]), trust: lotsOf(row[13]), total: lotsOf(row[23]) }
      }
    }
    days.push({ date: `${y}/${mm}/${dd}`, map: dayMap })
  }

  const map: Record<string, Chip> = {}
  if (days.length) {
    const latest = days[0]
    for (const code of Object.keys(latest.map)) {
      const fSeries = days.map((d) => d.map[code]?.foreign ?? null)
      const tSeries = days.map((d) => d.map[code]?.trust ?? null)
      const c = latest.map[code]
      map[code] = {
        foreign: c.foreign, trust: c.trust, total: c.total, date: latest.date,
        foreignStreak: streakOf(fSeries), trustStreak: streakOf(tSeries),
      }
    }
    chipCache = { map, at: Date.now() }
  }
  return chipCache?.map ?? map
  })()
  try { return await chipInflight } finally { chipInflight = null }
}

// 籌碼方向判定：投信領先性最強，外資量大；合計買超為多、賣超為空；連買/連賣加註
function judgeChip(chip: Chip): { signal: StockHealth['chipSignal']; text: string } {
  if (chip.total == null) return { signal: 'na', text: '查無法人籌碼資料。' }
  const f = chip.foreign ?? 0
  const t = chip.trust ?? 0
  const fmt = (n: number) => (n >= 0 ? '買超 ' : '賣超 ') + Math.abs(n).toLocaleString() + ' 張'
  const parts = [`外資${fmt(f)}`, `投信${fmt(t)}`]
  let signal: StockHealth['chipSignal'] = 'neutral'
  if (chip.total > 0) signal = 'buy'
  else if (chip.total < 0) signal = 'sell'
  // 三大法人同買（外資＋投信同步買超）：強短線領先訊號，優先標註
  const bothBuy = f > 0 && t > 0
  if (bothBuy) parts.push('外資投信同買')
  // 連買/連賣補述（投信連買 = 波段起點訊號）
  const streaks: string[] = []
  if (chip.trustStreak >= 2) streaks.push(`投信連買 ${chip.trustStreak} 天`)
  else if (chip.trustStreak <= -2) streaks.push(`投信連賣 ${-chip.trustStreak} 天`)
  if (chip.foreignStreak >= 2) streaks.push(`外資連買 ${chip.foreignStreak} 天`)
  else if (chip.foreignStreak <= -2) streaks.push(`外資連賣 ${-chip.foreignStreak} 天`)
  const tail = streaks.length ? `（${streaks.join('、')}）` : ''
  return { signal, text: parts.join('、') + tail }
}

// 技術面分數 0~100：季線/排列/MACD/KD/買點 加總，與紅綠燈同邏輯但量化
function scoreTechnical(s: Pick<StockHealth, 'aboveMa60' | 'arrange' | 'macdHist' | 'kdCross' | 'kdZone' | 'entry'>): number {
  let t = 50
  t += s.aboveMa60 ? 10 : -10
  t += s.arrange === '多頭排列' ? 15 : s.arrange === '空頭排列' ? -15 : 0
  t += s.macdHist >= 0 ? 5 : -5
  if (s.kdCross === '黃金交叉') t += 5
  else if (s.kdCross === '死亡交叉') t -= 5
  if (s.kdZone === '超賣') t += 3
  else if (s.kdZone === '超買') t -= 3
  if (s.entry === '帶量突破') t += 12 // 糾結末端爆量起漲，最強進場訊號
  else if (s.entry === '接近買點') t += 8
  else if (s.entry === '轉弱避開') t -= 8
  else if (s.entry === '盤整觀望') t -= 3
  return Math.max(0, Math.min(100, t))
}

// 籌碼面分數 0~100：當日買賣超方向＋投信權重＋連買/連賣天數
// 方向分數依「買賣超佔當日成交量比重」加權：買超 300 張對日成交上萬張的股票是雜訊，
// 不該拿到跟大買 5% 成交量一樣的分數（≥2% 全額、0.5~2% 減半、<0.5% 幾乎不計）
function scoreChip(chip: Chip, dayVolLots: number | null): number | null {
  if (chip.total == null) return null
  const sig = dayVolLots && dayVolLots > 0 ? Math.abs(chip.total) / dayVolLots : null
  const w = sig == null ? 1 : sig >= 0.02 ? 1 : sig >= 0.005 ? 0.5 : 0.15
  let c = 50
  c += (chip.total > 0 ? 10 : chip.total < 0 ? -10 : 0) * w
  const t = chip.trust ?? 0, f = chip.foreign ?? 0
  c += (t > 0 ? 8 : t < 0 ? -4 : 0) * w // 投信買超權重高
  c += (f > 0 ? 5 : f < 0 ? -5 : 0) * w
  if (f > 0 && t > 0) c += 6 * w // 外資投信同買：綜效加分（極強領先）
  if (chip.trustStreak >= 3) c += 8
  else if (chip.trustStreak >= 2) c += 4
  else if (chip.trustStreak <= -3) c -= 6
  if (chip.foreignStreak >= 3) c += 5
  else if (chip.foreignStreak <= -3) c -= 5
  return Math.round(Math.max(0, Math.min(100, c)))
}

// 總分：技術 0.4 / 基本 0.4 / 籌碼 0.2，只對有資料的柱子加權正規化
function scoreOverall(tech: number, fund: number | null, chip: number | null): { score: number; verdict: string } {
  const pillars: { w: number; v: number; name: string }[] = [{ w: 0.4, v: tech, name: '技術' }]
  if (fund != null) pillars.push({ w: 0.4, v: fund, name: '基本' })
  if (chip != null) pillars.push({ w: 0.2, v: chip, name: '籌碼' })
  const wsum = pillars.reduce((a, p) => a + p.w, 0)
  const score = Math.round(pillars.reduce((a, p) => a + p.v * p.w, 0) / wsum)
  const band = score >= 70 ? '整體偏強' : score >= 55 ? '中性偏多' : score >= 45 ? '中性' : '整體偏弱'
  const detail = pillars.map((p) => `${p.name} ${p.v}`).join('／')
  const verdict = `${band}（總分 ${score}）。三柱：${detail}（技術看時機、基本看體質、籌碼看主力動向；缺資料的柱子不計分）。`
  return { score, verdict }
}

// ---------- 基本盤（體質）判定 ----------
// 成長(月營收YoY) 為主、估值(PE/PB/殖利率) 為輔，算 0~100 分 → 紅綠燈
// 邏輯刻意保守、可解釋：營收年增是體質核心，本益比/殖利率調整估值貴不貴
function judgeFundamental(rev: Revenue, pe: number | null, pb: number | null, yield_: number | null): {
  score: number | null
  signal: StockHealth['fundSignal']
  verdict: string
} {
  const g = rev.yoy ?? rev.yoyCum // 單月優先，沒值退回累計
  // 完全沒有營收也沒有估值 → ETF/控股/資料不足，不做基本面判定
  if (g == null && pe == null && pb == null && yield_ == null) {
    return { score: null, signal: 'na', verdict: '無營收/估值資料（可能是 ETF），基本面判定不適用。' }
  }

  let score = 50 // 中性起點
  const reasons: string[] = []

  // 成長：營收年增率（最重要）
  if (g != null) {
    if (g >= 20) { score += 25; reasons.push(`營收年增 +${g.toFixed(1)}%（高成長）`) }
    else if (g >= 5) { score += 15; reasons.push(`營收年增 +${g.toFixed(1)}%（成長中）`) }
    else if (g >= -5) { reasons.push(`營收年增 ${g >= 0 ? '+' : ''}${g.toFixed(1)}%（大致持平）`) }
    else if (g >= -20) { score -= 15; reasons.push(`營收年減 ${g.toFixed(1)}%（衰退）`) }
    else { score -= 25; reasons.push(`營收年減 ${g.toFixed(1)}%（明顯衰退）`) }
  }

  // 營收動能（領先）：單月 YoY 比累計 YoY 高 → 近月成長在加速（領先 EPS）
  if (rev.yoy != null && rev.yoyCum != null) {
    const accel = rev.yoy - rev.yoyCum
    if (accel >= 3) { score += 5; reasons.push('近月動能加速') }
    else if (accel <= -3) { score -= 5; reasons.push('近月動能轉弱') }
  }

  // 估值：本益比（虧損股 pe 為 null，不加減）
  if (pe != null) {
    if (pe <= 15) { score += 10; reasons.push(`本益比 ${pe} 倍（不貴）`) }
    else if (pe <= 25) { score += 5 }
    else if (pe <= 40) { score -= 5 }
    else { score -= 15; reasons.push(`本益比 ${pe} 倍（偏貴）`) }
  } else if (g != null && g < -5) {
    // 衰退又查不到本益比，多半是虧損，再扣一點
    score -= 5
  }

  // 殖利率：高殖利率代表穩定配息、有撐
  if (yield_ != null) {
    if (yield_ >= 5) { score += 10; reasons.push(`殖利率 ${yield_}%（配息佳）`) }
    else if (yield_ >= 3) { score += 5 }
  }

  // 股價淨值比過高小幅扣分
  if (pb != null && pb > 5) score -= 5

  score = Math.max(0, Math.min(100, score))
  const signal: StockHealth['fundSignal'] = score >= 65 ? 'green' : score <= 40 ? 'red' : 'yellow'
  const head = signal === 'green' ? '體質佳' : signal === 'red' ? '體質偏弱' : '體質中性'
  const verdict = `${head}：${reasons.slice(0, 3).join('、')}。`
  return { score, signal, verdict }
}

// 代號解析：先試上市 .TW，失敗再試上櫃 .TWO；已含後綴則直接用
async function resolve(symbol: string) {
  const s = symbol.trim().toUpperCase()
  if (s.includes('.')) {
    const r = await fetchYahoo(s)
    return r ? { ...r, resolved: s } : null
  }
  for (const suffix of ['.TW', '.TWO']) {
    const r = await fetchYahoo(s + suffix)
    if (r && r.candles.length > 60) return { ...r, resolved: s + suffix }
  }
  return null
}

// ---------- 健檢主流程 ----------

export async function analyzeStock(symbol: string): Promise<StockHealth | { symbol: string; error: string }> {
  let data
  try {
    data = await resolve(symbol)
  } catch (e) {
    return { symbol, error: '抓取失敗：' + String(e) }
  }
  if (!data) return { symbol, error: '查無此代號（上市/上櫃都找不到），或資料不足' }
  const { candles, meta, resolved } = data
  if (candles.length < 60) return { symbol, error: '日K 不足 60 筆，無法算季線' }

  // 中文名稱（抓不到就退回 Yahoo 英文名）+ 估值 + 月營收
  const bareCode = symbol.trim().toUpperCase().split('.')[0]
  const [nameMap, valMap, revMap, chipMap] = await Promise.all([getNameMap(), getValuationMap(), getRevenueMap(), getChipMap()])
  const cnName = nameMap[bareCode]
  const val = valMap[bareCode] || { pe: null, pb: null, yield: null }
  const rev = revMap[bareCode] || { yoy: null, yoyCum: null, month: null }
  const fund = judgeFundamental(rev, val.pe, val.pb, val.yield)
  const chip: Chip = chipMap[bareCode] || { foreign: null, trust: null, total: null, date: null, foreignStreak: 0, trustStreak: 0 }
  const chipJudge = judgeChip(chip)
  const revMomentum = rev.yoy != null && rev.yoyCum != null ? Math.round((rev.yoy - rev.yoyCum) * 10) / 10 : null

  const closes = candles.map((c) => c.close)
  const last = candles.length - 1
  const price = meta.regularMarketPrice ?? closes[last]
  const prevClose = closes[last - 1]

  const ma5 = sma(closes, 5)
  const ma20 = sma(closes, 20)
  const ma60 = sma(closes, 60)
  const aboveMa60 = price > ma60
  const distMa60Pct = ((price - ma60) / ma60) * 100

  // 均線排列
  let arrange: StockHealth['arrange'] = '糾結盤整'
  if (ma5 > ma20 && ma20 > ma60) arrange = '多頭排列'
  else if (ma5 < ma20 && ma20 < ma60) arrange = '空頭排列'

  // KD
  const { k, d } = kdSeries(candles)
  const kNow = k[last], dNow = d[last], kPrev = k[last - 1], dPrev = d[last - 1]
  let kdCross: StockHealth['kdCross'] = '無'
  if (kPrev <= dPrev && kNow > dNow) kdCross = '黃金交叉'
  else if (kPrev >= dPrev && kNow < dNow) kdCross = '死亡交叉'
  const kdZone: StockHealth['kdZone'] = kNow >= 80 ? '超買' : kNow <= 20 ? '超賣' : '中性'

  // MACD
  const m = macd(closes)
  const macdTrend: StockHealth['macdTrend'] = m.hist >= 0 ? '多方動能' : '空方動能'

  // 量價：今量 vs 近 5 日均量，配合當日漲跌判斷量價是否健康
  const vols = candles.map((c) => c.volume)
  const volNow = vols[last]
  const volMa5 = sma(vols, 5)
  const volRatio = volMa5 > 0 ? volNow / volMa5 : null
  let volTag: StockHealth['volTag'] = '—'
  if (volRatio != null) {
    if (volRatio >= 2) volTag = '爆量'
    else if (volRatio >= 1.3) volTag = '量增'
    else if (volRatio >= 0.7) volTag = '量平'
    else if (volRatio >= 0.4) volTag = '量縮'
    else volTag = '窒息量'
  }
  const dayUp = price >= prevClose
  let volNote = '量價資料不足。'
  let volAdj = 0 // 給技術分數的量價加減
  if (volRatio != null) {
    const heavy = volRatio >= 1.3, light = volRatio < 0.7
    if (dayUp && heavy) { volNote = '價漲量增，買盤積極（健康）。'; volAdj = 4 }
    else if (dayUp && light) { volNote = '價漲量縮，追價意願偏弱（背離留意）。'; volAdj = -3 }
    else if (!dayUp && volRatio >= 2) { volNote = '價跌爆量，可能是出貨或恐慌殺盤。'; volAdj = -4 }
    else if (!dayUp && light) { volNote = '價跌量縮，賣壓減輕（可能止跌）。'; volAdj = 2 }
    else volNote = '量價大致持平。'
  }

  // 波動度（風險）：近 60 日平均每日漲跌幅絕對值 + 高低振幅。圖會自動縮放看不出大小，這裡量化出來。
  const recentCloses = closes.slice(-Math.min(60, closes.length))
  let dSum = 0, dN = 0
  for (let i = 1; i < recentCloses.length; i++) {
    if (recentCloses[i - 1] > 0) { dSum += Math.abs((recentCloses[i] - recentCloses[i - 1]) / recentCloses[i - 1]); dN++ }
  }
  const volatilityPct = dN ? round((dSum / dN) * 100, 2) : 0
  const rHi = Math.max(...recentCloses), rLo = Math.min(...recentCloses)
  const range60Pct = rLo > 0 ? round(((rHi - rLo) / rLo) * 100, 0) : 0
  const volLabel: StockHealth['volLabel'] = volatilityPct >= 3 ? '高波' : volatilityPct >= 1.5 ? '中波' : '低波'

  // 建議停損：距離隨波動放大（回測近2年：固定 -6% 連隨機進場都有 ~48% 機率被日常雜訊掃出場）
  const stopPct = round(Math.min(15, Math.max(5, 3.5 * volatilityPct)), 1)
  const stopPrice = round(price * (1 - stopPct / 100))

  // 籌碼分數要用「佔成交量比重」加權，所以在量能算完後才評分
  const chipScoreVal = scoreChip(chip, isFinite(volNow) ? volNow / 1000 : null)

  // 畫圖序列：最近約 120 個交易日的收盤＋月線(20)＋季線(60)
  const N = Math.min(120, candles.length)
  const start = candles.length - N
  const ma20s = smaSeries(closes, 20)
  const ma60s = smaSeries(closes, 60)
  const series = {
    close: closes.slice(start).map((v) => round(v)),
    open: candles.slice(start).map((c) => round(c.open)),
    high: candles.slice(start).map((c) => round(c.high)),
    low: candles.slice(start).map((c) => round(c.low)),
    ma20: ma20s.slice(start).map((v) => (v == null ? null : round(v))),
    ma60: ma60s.slice(start).map((v) => (v == null ? null : round(v))),
    k: k.slice(start).map((v) => round(v, 1)),
    d: d.slice(start).map((v) => round(v, 1)),
  }

  // 紅綠燈：站上季線 + 多頭 + 多方動能 = 綠；跌破季線 + 空頭 = 紅；其餘黃
  let signal: StockHealth['signal'] = 'yellow'
  let verdict = ''
  if (aboveMa60 && arrange === '多頭排列' && m.hist >= 0) {
    signal = 'green'
    verdict = '站上季線、均線多頭排列、MACD 動能偏多——順勢偏多，留意別追高。'
  } else if (!aboveMa60 && arrange === '空頭排列') {
    signal = 'red'
    verdict = '跌破季線且空頭排列——多頭結構轉弱，做多應避開或嚴設停損。'
  } else {
    signal = 'yellow'
    if (!aboveMa60) verdict = '已跌破季線，方向轉弱，觀望為宜，不宜逆勢做多。'
    else if (arrange === '糾結盤整') verdict = '站上季線但均線糾結，方向未明，盤整盤勿頻繁進出。'
    else verdict = '訊號不一致，建議再等更明確的方向。'
  }

  // 綠燈過熱降級（2026/06–07 回放：綠燈常亮在漲多高點，其中距季線>12% 的追進 5 日勝率僅約 26%）
  // 綠燈只代表「結構偏多」，漲太遠就不是買點——降黃燈，避免把綠燈當買進鍵
  const overheat = signal === 'green' && distMa60Pct > 12
  if (overheat) {
    signal = 'yellow'
    verdict = `偏多但過熱：距季線已 +${round(distMa60Pct, 1)}%，多頭結構仍在但這裡不是買點，等回檔靠近季線再說。`
  }

  // 進場時機判讀（照 SOP）：要做多就要「多頭 + 剛回檔沒噴太遠(距季線≤12%) + KD 降到低檔(≤50)」
  // 帶量突破：均線糾結末端，今日放量(量比≥1.3)收紅、且站上 5/20 短均 → 主力點火、起漲訊號
  const breakout = volRatio != null && volRatio >= 1.3 && dayUp && price > ma5 && price > ma20
  let entry: StockHealth['entry']
  if (!aboveMa60 || arrange === '空頭排列') entry = '轉弱避開'
  else if (arrange === '多頭排列' && distMa60Pct <= 12 && kNow <= 50) entry = '接近買點'
  else if (arrange === '多頭排列') entry = '強勢偏貴'
  else if (arrange === '糾結盤整' && breakout) entry = '帶量突破'
  else entry = '盤整觀望'

  // 大漲日追高警語（回測近2年：單日漲逾6%後追進，約五成機率20日內先回落6%以上——
  // 動能單常「先洗再噴」，不是不能做，是部位要小、停損要用波動化的建議價，新手最常死在這裡）
  const chgToday = round(((price - prevClose) / prevClose) * 100, 2)
  let verdictFinal = verdict
  if (chgToday >= 6) {
    verdictFinal += `⚠️ 今日已大漲 ${chgToday}%，隔日追進約五成機率先回落 6% 以上再說（回測統計）——要進場請縮小部位，停損放在建議價 ${stopPrice}（-${stopPct}%）。`
  }

  // 綜合評分：技術（含量價）+ 基本 + 籌碼；過熱（距季線>12%）扣 6 分
  const techScore = Math.max(0, Math.min(100, scoreTechnical({ aboveMa60, arrange, macdHist: m.hist, kdCross, kdZone, entry }) + volAdj + (overheat ? -6 : 0)))
  const overall = scoreOverall(techScore, fund.score, chipScoreVal)

  return {
    symbol: symbol.trim(),
    resolved,
    name: cnName || meta.shortName || meta.longName || resolved,
    price: round(price),
    prevClose: round(prevClose),
    changePct: chgToday,
    dataDate: new Date(candles[last].time * 1000).toLocaleDateString('sv', { timeZone: 'Asia/Taipei' }),
    ma5: round(ma5),
    ma20: round(ma20),
    ma60: round(ma60),
    aboveMa60,
    distMa60Pct: round(distMa60Pct, 2),
    arrange,
    k: round(kNow, 1),
    d: round(dNow, 1),
    kdCross,
    kdZone,
    macdHist: round(m.hist, 3),
    macdTrend,
    dif: round(m.dif, 3),
    signal,
    entry,
    vol: isFinite(volNow) ? Math.round(volNow / 1000) : null,
    volRatio: volRatio == null ? null : round(volRatio, 2),
    volTag,
    volNote,
    pe: val.pe,
    pb: val.pb,
    dividendYield: val.yield,
    volatilityPct,
    range60Pct,
    volLabel,
    stopPct,
    stopPrice,
    verdict: verdictFinal,
    revYoY: rev.yoy,
    revYoYCum: rev.yoyCum,
    revMonth: rev.month,
    revMomentum,
    fundScore: fund.score,
    fundSignal: fund.signal,
    fundVerdict: fund.verdict,
    chipForeign: chip.foreign,
    chipTrust: chip.trust,
    chipTotal: chip.total,
    chipDate: chip.date,
    chipForeignStreak: chip.foreignStreak,
    chipTrustStreak: chip.trustStreak,
    chipBothBuy: (chip.foreign ?? 0) > 0 && (chip.trust ?? 0) > 0,
    chipSignal: chipJudge.signal,
    chipText: chipJudge.text,
    techScore,
    chipScore: chipScoreVal,
    overallScore: overall.score,
    overallVerdict: overall.verdict,
    series,
  }
}

function round(n: number, digits = 2): number {
  if (!isFinite(n)) return 0
  const f = 10 ** digits
  return Math.round(n * f) / f
}

// ---------- 大盤環境（看天氣）----------
// 抓加權指數、費城半導體、標普500、VIX，給「今天適不適合做多」的總結
export type IndexQuote = { key: string; name: string; price: number; changePct: number; aboveMa60: boolean | null; note?: string }
export type MarketOverview = {
  indices: IndexQuote[]
  mood: 'bullish' | 'neutral' | 'bearish'
  moodLabel: string // 環境偏多/中性/偏空
  moodText: string // 一句話總結
  soxCorr20: number | null // 近20組「費半當日→加權隔日」相關係數（<0.25 視為脫鉤，費半警訊自動降權）
  asOf: string
}

let marketCache: { data: MarketOverview; at: number } | null = null
export async function getMarketOverview(): Promise<MarketOverview> {
  if (marketCache && Date.now() - marketCache.at < 10 * 60 * 1000) return marketCache.data // 盤中會動，快取 10 分鐘
  // 加權需要算季線→要一年日K；其餘只要漲跌幅
  const defs = [
    { key: 'twii', name: '加權指數', ysym: '^TWII', ma: true },
    { key: 'sox', name: '費城半導體', ysym: '^SOX', ma: false },
    { key: 'gspc', name: '標普500', ysym: '^GSPC', ma: false },
    { key: 'vix', name: 'VIX 恐慌', ysym: '^VIX', ma: false },
  ]
  const indices: IndexQuote[] = []
  const rawCandles: Record<string, Candle[]> = {} // 留住日K，給費半↔台股連動度計算用
  await Promise.all(
    defs.map(async (d) => {
      const r = await fetchYahoo(d.ysym).catch(() => null)
      if (!r || r.candles.length < 2) return
      rawCandles[d.key] = r.candles
      const closes = r.candles.map((c) => c.close)
      const last = closes.length - 1
      const price = r.meta.regularMarketPrice ?? closes[last]
      // 當日漲跌幅要用「昨收」＝倒數第二根日K的收盤；chartPreviousClose 在 range=1y 是一年前的收盤，不能用
      const prev = closes[last - 1]
      const changePct = prev ? ((price - prev) / prev) * 100 : 0
      const aboveMa60 = d.ma && closes.length >= 60 ? price > sma(closes, 60) : null
      indices.push({ key: d.key, name: d.name, price: round(price, d.key === 'vix' ? 2 : 0), changePct: round(changePct, 2), aboveMa60 })
    })
  )
  // 排序固定順序
  indices.sort((a, b) => defs.findIndex((d) => d.key === a.key) - defs.findIndex((d) => d.key === b.key))

  const get = (k: string) => indices.find((i) => i.key === k)
  const twii = get('twii'), sox = get('sox'), gspc = get('gspc'), vix = get('vix')

  // 費半↔台股連動度：近 20 組「費半當日漲跌 → 加權下一交易日漲跌」的 Pearson 相關係數
  // 2026/06–07 回放：脫鉤期費半跌>3% 後電子隔日僅 50% 收黑（遠低於長期統計的 85%），
  // 所以費半規則不能寫死——連動度低（r<0.25）時警訊自動降權、強制 override 不啟動
  let soxCorr20: number | null = null
  const soxC = rawCandles['sox'], twiiC = rawCandles['twii']
  if (soxC && twiiC && soxC.length > 25 && twiiC.length > 25) {
    const xs: number[] = [], ys: number[] = []
    for (let i = soxC.length - 1; i >= 1 && xs.length < 20; i--) {
      const j = twiiC.findIndex((c) => c.time > soxC[i].time) // 費半該晚之後第一個台股交易日
      if (j < 1) continue
      xs.push(soxC[i].close / soxC[i - 1].close - 1)
      ys.push(twiiC[j].close / twiiC[j - 1].close - 1)
    }
    if (xs.length >= 10) {
      const n = xs.length
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n
      let sxy = 0, sxx = 0, syy = 0
      for (let t = 0; t < n; t++) { const dx = xs[t] - mx, dy = ys[t] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy }
      if (sxx > 0 && syy > 0) soxCorr20 = round(sxy / Math.sqrt(sxx * syy), 2)
    }
  }
  // 算不出連動度就當「有連動」（保守預設：寧可多警告，不要少警告）
  const soxDecoupled = soxCorr20 != null && soxCorr20 < 0.25
  const soxW = soxDecoupled ? 0.5 : 1

  let pts = 0
  if (twii) {
    pts += twii.aboveMa60 ? 2 : twii.aboveMa60 === false ? -2 : 0 // 趨勢：季線之上/之下
    // 今日漲跌「看幅度」：重挫日要扣得夠重，不能跟小跌一樣只扣 1（否則綠油油還喊偏多）
    const p = twii.changePct
    pts += p >= 1.5 ? 2 : p > 0.3 ? 1 : p >= -0.3 ? 0 : p > -1.5 ? -1.5 : p > -3 ? -2.5 : -3.5
  }
  // 費半對台股電子最關鍵，且要看「幅度」不能只看紅黑（回測近2年劑量效應明確：跌越深電子隔日越弱）
  // 但 2026/06–07 回放發現脫鉤期會失靈，故乘上連動度權重 soxW（脫鉤時減半）
  if (sox) {
    const sp = sox.changePct
    pts += (sp > 0 ? 1.5 : sp > -1.5 ? -1 : sp > -3 ? -2.5 : -3.5) * soxW
  }
  if (gspc) pts += gspc.changePct > 0 ? 0.5 : -0.5
  if (vix) {
    pts += vix.price < 16 ? 1 : vix.price > 25 ? -1.5 : 0 // 絕對水位
    pts += vix.changePct >= 15 ? -1.5 : vix.changePct >= 7 ? -1 : 0 // 跳升＝恐慌升溫，光看水位會漏掉
  }
  let mood: MarketOverview['mood'] = pts >= 2 ? 'bullish' : pts <= -2 ? 'bearish' : 'neutral'
  // 保護：大盤今天自己重挫，就絕不喊「順風積極」——在綠油油的崩盤日叫新手加碼最傷
  const dayDrop = twii ? twii.changePct : 0
  if (dayDrop <= -2 && mood === 'bullish') mood = 'neutral'
  if (dayDrop <= -3) mood = 'bearish'
  // 費半重挫日也不准喊順風（電子占台股權重太高）——但近期明顯脫鉤時不強制，避免一直誤擋
  if (sox && sox.changePct <= -3 && mood === 'bullish' && !soxDecoupled) mood = 'neutral'
  const moodLabel = mood === 'bullish' ? '環境偏多' : mood === 'bearish' ? '環境偏空' : '環境中性'
  const reasons: string[] = []
  if (twii) {
    reasons.push(twii.aboveMa60 ? '加權站上季線' : twii.aboveMa60 === false ? '加權跌破季線' : '加權方向不明')
    if (dayDrop <= -2) reasons.push(`加權今日重挫 ${Math.abs(twii.changePct)}%`)
    else if (twii.changePct >= 2) reasons.push(`加權今日大漲 ${twii.changePct}%`)
  }
  if (sox) {
    const corrNote = soxCorr20 == null ? '' : soxDecoupled ? `（近20日與台股連動偏低 r=${soxCorr20}，警訊參考就好）` : `（近20日連動度 r=${soxCorr20}）`
    if (sox.changePct <= -3) reasons.push(`費半重挫 ${Math.abs(sox.changePct)}%——${soxDecoupled ? '電子股留意' : '⚠️ 電子股今日保守（歷史上費半重挫後，電子隔日明顯偏弱）'}${corrNote}`)
    else if (sox.changePct <= -1.5) reasons.push(`費半大跌 ${Math.abs(sox.changePct)}%，電子股保守${corrNote}`)
    else reasons.push(sox.changePct >= 0 ? '費半收紅' : '費半收黑')
  }
  if (vix) reasons.push(vix.changePct >= 7 ? `VIX 跳升 ${vix.changePct}%` : vix.price < 16 ? 'VIX 平靜' : vix.price > 25 ? 'VIX 偏高' : 'VIX 中性')
  const moodText =
    (mood === 'bullish' ? '大環境順風，操作可積極些；' : mood === 'bearish' ? '大環境逆風，做多保守、控制部位、今天別追高；' : '大環境中性，個股表現為主，盤勢震盪別追高；') +
    reasons.join('、') + '。'

  const data: MarketOverview = { indices, mood, moodLabel, moodText, soxCorr20, asOf: new Date().toISOString() }
  if (indices.length) marketCache = { data, at: Date.now() }
  return data
}
