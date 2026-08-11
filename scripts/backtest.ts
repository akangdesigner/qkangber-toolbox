// 技術面訊號回測：用 Yahoo 一年日K，逐根重放 lib/stock.ts 的 entry / techScore 判定，
// 統計各「進場狀態」與各「技術分數帶」對未來 5 日 / 20 日的勝率與平均報酬。
//
// 只重建「技術面」——基本面(營收)與籌碼(法人)的免費 API 沒有歷史，無法回放，故不含 overallScore。
// 樣本：台股成交金額前 N 大個股（排除 ETF/權證），與工具的選股池一致。
//
// 用法：npx tsx scripts/backtest.ts [樣本數=120] [持有天數清單=5,20]
// 例： npx tsx scripts/backtest.ts 150 5,10,20

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }

// ---------- 指標（與 lib/stock.ts 同邏輯，全部因果可重放）----------

function sma(values: number[], period: number, end: number): number {
  if (end + 1 < period) return NaN
  let s = 0
  for (let i = end - period + 1; i <= end; i++) s += values[i]
  return s / period
}

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

// KD(9,3,3) 完整序列——每個 k[i] 只依賴 candles[0..i]，故整段算一次＝逐根截斷重算
function kdSeries(candles: Candle[], n = 9): { k: number[]; d: number[] } {
  const k: number[] = [], d: number[] = []
  let prevK = 50, prevD = 50
  for (let i = 0; i < candles.length; i++) {
    const lo0 = Math.max(0, i - n + 1)
    let high = -Infinity, low = Infinity
    for (let j = lo0; j <= i; j++) { if (candles[j].high > high) high = candles[j].high; if (candles[j].low < low) low = candles[j].low }
    const rsv = high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100
    const curK = prevK * (2 / 3) + rsv * (1 / 3)
    const curD = prevD * (2 / 3) + curK * (1 / 3)
    k.push(curK); d.push(curD); prevK = curK; prevD = curD
  }
  return { k, d }
}

// MACD(12,26,9)：整段 DIF / signal 序列（EMA 因果），hist[i]=dif[i]-signal[i]
function macdHistSeries(closes: number[]): number[] {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26)
  const dif = closes.map((_, i) => e12[i] - e26[i])
  const sig = emaSeries(dif, 9)
  return dif.map((v, i) => v - sig[i])
}

// 技術面分數（同 lib/stock.ts scoreTechnical + volAdj + 過熱扣分）
function scoreTechnical(a: { aboveMa60: boolean; arrange: string; macdHist: number; kdCross: string; kdZone: string; entry: string }): number {
  let t = 50
  t += a.aboveMa60 ? 10 : -10
  t += a.arrange === '多頭排列' ? 15 : a.arrange === '空頭排列' ? -15 : 0
  t += a.macdHist >= 0 ? 5 : -5
  if (a.kdCross === '黃金交叉') t += 5
  else if (a.kdCross === '死亡交叉') t -= 5
  if (a.kdZone === '超賣') t += 3
  else if (a.kdZone === '超買') t -= 3
  if (a.entry === '帶量突破') t += 12
  else if (a.entry === '接近買點') t += 8
  else if (a.entry === '轉弱避開') t -= 8
  else if (a.entry === '盤整觀望') t -= 3
  return Math.max(0, Math.min(100, t))
}

// ---------- 抓一年日K ----------

async function fetchYahoo(ySymbol: string): Promise<Candle[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?range=1y&interval=1d`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' })
    if (!res.ok) return null
    const json: any = await res.json()
    const r = json.chart?.result?.[0]
    if (!r?.timestamp || !r.indicators?.quote?.[0]) return null
    const q = r.indicators.quote[0]
    const out: Candle[] = []
    for (let i = 0; i < r.timestamp.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i]
      if (o == null || h == null || l == null || c == null) continue
      out.push({ time: r.timestamp[i], open: o, high: h, low: l, close: c, volume: v ?? 0 })
    }
    return out
  } catch { return null }
}

async function resolve(code: string): Promise<Candle[] | null> {
  for (const suf of ['.TW', '.TWO']) {
    const c = await fetchYahoo(code + suf)
    if (c && c.length > 80) return c
  }
  return null
}

async function topUniverse(n: number): Promise<string[]> {
  const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' })
  const data = (await res.json()) as Array<{ Code: string; Name: string; TradeValue: string }>
  return data
    .filter((d) => /^[1-9]\d{3}$/.test(d.Code))
    .map((d) => ({ code: d.Code, value: Number(String(d.TradeValue).replace(/,/g, '')) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n)
    .map((s) => s.code)
}

// ---------- 逐根重放單檔，收集 (entry, techScore, 未來報酬) ----------

type Obs = { entry: string; techScore: number; fwd: Record<number, number | null>; exc: Record<number, number | null> }

// 台北日期字串（對齊大盤用）
function tpeDate(t: number): string {
  return new Date(t * 1000).toLocaleDateString('sv', { timeZone: 'Asia/Taipei' })
}

function replay(candles: Candle[], horizons: number[], mkt: { pos: Record<string, number>; closes: number[] } | null): Obs[] {
  const closes = candles.map((c) => c.close)
  const vols = candles.map((c) => c.volume)
  const { k, d } = kdSeries(candles)
  const hist = macdHistSeries(closes)
  const obs: Obs[] = []
  const maxH = Math.max(...horizons)

  // i 從 60（季線可算）到 len-1；未來報酬看得到幾天就記幾天
  for (let i = 60; i < candles.length; i++) {
    const price = closes[i], prevClose = closes[i - 1]
    const ma5 = sma(closes, 5, i), ma20 = sma(closes, 20, i), ma60 = sma(closes, 60, i)
    if (!isFinite(ma60)) continue
    const aboveMa60 = price > ma60
    const distMa60Pct = ((price - ma60) / ma60) * 100

    let arrange = '糾結盤整'
    if (ma5 > ma20 && ma20 > ma60) arrange = '多頭排列'
    else if (ma5 < ma20 && ma20 < ma60) arrange = '空頭排列'

    let kdCross = '無'
    if (k[i - 1] <= d[i - 1] && k[i] > d[i]) kdCross = '黃金交叉'
    else if (k[i - 1] >= d[i - 1] && k[i] < d[i]) kdCross = '死亡交叉'
    const kdZone = k[i] >= 80 ? '超買' : k[i] <= 20 ? '超賣' : '中性'

    const volNow = vols[i], volMa5 = sma(vols, 5, i)
    const volRatio = volMa5 > 0 ? volNow / volMa5 : null
    const dayUp = price >= prevClose
    let volAdj = 0
    if (volRatio != null) {
      const heavy = volRatio >= 1.3, light = volRatio < 0.7
      if (dayUp && heavy) volAdj = 4
      else if (dayUp && light) volAdj = -3
      else if (!dayUp && volRatio >= 2) volAdj = -4
      else if (!dayUp && light) volAdj = 2
    }

    const breakout = volRatio != null && volRatio >= 1.3 && dayUp && price > ma5 && price > ma20
    let entry: string
    if (!aboveMa60 || arrange === '空頭排列') entry = '轉弱避開'
    else if (arrange === '多頭排列' && distMa60Pct <= 12 && k[i] <= 50) entry = '接近買點'
    else if (arrange === '多頭排列') entry = '強勢偏貴'
    else if (arrange === '糾結盤整' && breakout) entry = '帶量突破'
    else entry = '盤整觀望'

    // 綠燈過熱降級只影響 signal，techScore 的過熱扣分條件是 signal===green && distMa60Pct>12
    const greenBase = aboveMa60 && arrange === '多頭排列' && hist[i] >= 0
    const overheat = greenBase && distMa60Pct > 12
    const techScore = Math.max(0, Math.min(100, scoreTechnical({ aboveMa60, arrange, macdHist: hist[i], kdCross, kdZone, entry }) + volAdj + (overheat ? -6 : 0)))

    const fwd: Record<number, number | null> = {}
    const exc: Record<number, number | null> = {}
    // 大盤同期報酬：以台北日期對齊加權指數，超額 = 個股報酬 − 大盤報酬（扣掉 beta）
    const mp = mkt ? mkt.pos[tpeDate(candles[i].time)] : undefined
    for (const h of horizons) {
      if (i + h < candles.length) {
        const stockR = ((closes[i + h] - price) / price) * 100
        fwd[h] = stockR
        if (mp != null && mp + h < mkt!.closes.length) {
          const mktR = ((mkt!.closes[mp + h] - mkt!.closes[mp]) / mkt!.closes[mp]) * 100
          exc[h] = stockR - mktR
        } else exc[h] = null
      } else { fwd[h] = null; exc[h] = null }
    }
    // 至少要有最短持有期的未來資料才算一筆有效觀察（最長期沒到就記 null）
    if (i + Math.min(...horizons) < candles.length) obs.push({ entry, techScore, fwd, exc })
    void maxH
  }
  return obs
}

// ---------- 統計 ----------

// wins/ret 為原始報酬；ewins/eret 為「超額」(扣大盤)；ecnt 為有大盤對齊的樣本數
type Bucket = { n: number; wins: Record<number, number>; ret: Record<number, number>; cnt: Record<number, number>; ewins: Record<number, number>; eret: Record<number, number>; ecnt: Record<number, number> }
function newBucket(hs: number[]): Bucket {
  const b: Bucket = { n: 0, wins: {}, ret: {}, cnt: {}, ewins: {}, eret: {}, ecnt: {} }
  for (const h of hs) { b.wins[h] = 0; b.ret[h] = 0; b.cnt[h] = 0; b.ewins[h] = 0; b.eret[h] = 0; b.ecnt[h] = 0 }
  return b
}
function add(b: Bucket, o: Obs, hs: number[]) {
  b.n++
  for (const h of hs) {
    const r = o.fwd[h]
    if (r != null) { b.cnt[h]++; b.ret[h] += r; if (r > 0) b.wins[h]++ }
    const e = o.exc[h]
    if (e != null) { b.ecnt[h]++; b.eret[h] += e; if (e > 0) b.ewins[h]++ }
  }
}

function pct(x: number): string { return (x * 100).toFixed(1) + '%' }
function signed(x: number): string { return (x >= 0 ? '+' : '') + x.toFixed(2) + '%' }

async function main() {
  const N = Number(process.argv[2]) || 120
  const horizons = (process.argv[3] || '5,20').split(',').map(Number).filter((x) => x > 0)
  console.log(`\n台股技術面訊號回測 · 樣本前 ${N} 大成交值 · 持有 ${horizons.join('/')} 交易日 · 近一年日K\n`)

  console.log('取選股池…')
  const codes = await topUniverse(N)
  console.log(`  取得 ${codes.length} 檔`)

  // 大盤基準（加權指數）：建台北日期 → 位置對照，供超額報酬對齊
  console.log('取大盤基準（加權指數）…')
  const twii = await fetchYahoo('^TWII')
  let mkt: { pos: Record<string, number>; closes: number[] } | null = null
  if (twii && twii.length > 80) {
    const pos: Record<string, number> = {}
    twii.forEach((c, idx) => { pos[tpeDate(c.time)] = idx })
    mkt = { pos, closes: twii.map((c) => c.close) }
    console.log(`  加權 ${twii.length} 根日K，將計算超額報酬（扣大盤）\n`)
  } else console.log('  ⚠️ 加權指數抓取失敗，僅輸出原始報酬\n')

  const entryOrder = ['接近買點', '帶量突破', '強勢偏貴', '盤整觀望', '轉弱避開']
  const byEntry: Record<string, Bucket> = {}
  for (const e of entryOrder) byEntry[e] = newBucket(horizons)
  const scoreBands = [[0, 45], [45, 55], [55, 65], [65, 75], [75, 101]]
  const byScore: Record<string, Bucket> = {}
  for (const [lo, hi] of scoreBands) byScore[`${lo}-${hi === 101 ? 100 : hi - 1}`] = newBucket(horizons)
  const all = newBucket(horizons)

  let done = 0, ok = 0, totalObs = 0
  // 分批並行抓，避免一次打爆 Yahoo
  const BATCH = 8
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH)
    const results = await Promise.all(batch.map((c) => resolve(c)))
    for (let j = 0; j < batch.length; j++) {
      done++
      const candles = results[j]
      if (!candles || candles.length < 80) continue
      ok++
      const obs = replay(candles, horizons, mkt)
      totalObs += obs.length
      for (const o of obs) {
        add(all, o, horizons)
        add(byEntry[o.entry], o, horizons)
        for (const [lo, hi] of scoreBands) {
          if (o.techScore >= lo && o.techScore < hi) { add(byScore[`${lo}-${hi === 101 ? 100 : hi - 1}`], o, horizons); break }
        }
      }
    }
    process.stdout.write(`\r  回放中 ${done}/${codes.length}（成功 ${ok}）`)
  }
  console.log(`\n  有效觀察 ${totalObs.toLocaleString()} 筆\n`)

  // 原始報酬（含大盤 beta）
  const rawLine = (label: string, b: Bucket) => {
    const parts = horizons.map((h) => b.cnt[h] === 0 ? `${h}日 —` : `${h}日 勝率 ${pct(b.wins[h] / b.cnt[h])}／均報 ${signed(b.ret[h] / b.cnt[h])}`)
    console.log(`  ${label.padEnd(6, '　')} 樣本 ${String(b.n).padStart(6)}　${parts.join('　｜　')}`)
  }
  // 超額報酬（扣掉大盤同期）——訊號有沒有價值看這個
  const excLine = (label: string, b: Bucket) => {
    const parts = horizons.map((h) => b.ecnt[h] === 0 ? `${h}日 —` : `${h}日 贏大盤 ${pct(b.ewins[h] / b.ecnt[h])}／超額 ${signed(b.eret[h] / b.ecnt[h])}`)
    console.log(`  ${label.padEnd(6, '　')} 樣本 ${String(b.n).padStart(6)}　${parts.join('　｜　')}`)
  }

  console.log('════════ 原始報酬（含大盤 beta，會被多頭市況灌水）════════')
  console.log('── 全體基準（隨機任一天進場）──')
  rawLine('全部', all)
  console.log('\n── 依進場狀態 ──')
  for (const e of entryOrder) if (byEntry[e].n) rawLine(e, byEntry[e])
  console.log('\n── 依技術分數帶 ──')
  for (const k of Object.keys(byScore)) if (byScore[k].n) rawLine(k + '分', byScore[k])

  if (mkt) {
    console.log('\n════════ 超額報酬（扣大盤同期，才是訊號真正的預測力）════════')
    console.log('── 全體基準（≈0＝跟大盤同步，無 alpha）──')
    excLine('全部', all)
    console.log('\n── 依進場狀態 ──')
    for (const e of entryOrder) if (byEntry[e].n) excLine(e, byEntry[e])
    console.log('\n── 依技術分數帶 ──')
    for (const k of Object.keys(byScore)) if (byScore[k].n) excLine(k + '分', byScore[k])
  }

  console.log('\n註：原始報酬＝訊號日收盤 → N 交易日後收盤漲跌幅，勝率＝報酬>0 比例。')
  console.log('　　超額報酬＝個股報酬 − 加權指數同期報酬（扣掉大盤 beta）；「贏大盤」＝超額>0 比例。')
  console.log('　　只含技術面，未計基本面/籌碼（免費 API 無歷史）。樣本近一年、單一市況，僅供文章佐證、非未來保證。\n')
}

main().catch((e) => { console.error(e); process.exit(1) })
