// 訊號對帳（收割）：把 data/signal-log/*.json 累積的「當天訊號」對上後來真實走勢，
// 回答「這套紅綠燈／進場判讀／總分，到底有沒有預測力」。
//
// 做法：每筆 (資料日, 股票) 紀錄，用 TWSE/TPEx 官方日K 找到資料日收盤，再往後數 N 個交易日算報酬；
// 依 紅綠燈 / 進場判讀 / 總分帶 / 籌碼方向 / 大盤氣氛 分組，統計筆數、勝率、平均與中位數報酬。
// 和 scripts/backtest.ts 的差別：backtest 只能重放技術面；這裡對的是當時「三柱齊全」的實際輸出，
// 包含營收、法人這些沒有歷史 API 的欄位——所以日誌累積得越久，這份對帳越有價值。
//
// 資料來源兩種，會合併（同一「資料日＋代號」以後讀到的為準）：
//   1) data/signal-log/YYYY-MM-DD.json（本機排程／開頁寫的日誌）
//   2) data/signal-log/sheet-export.tsv（線上版寫進 Google Sheet 的訊號紀錄，整個分頁貼下來即可；
//      欄位：記錄日 資料日 代號 名稱 價格 漲跌% 總分 技術 基本 籌碼 進場 燈 距季線% 停損價 大盤氣氛）
//
// 用法：npx tsx scripts/reconcile.ts [持有天數清單=5,10,20] [--detail]
//   --detail：額外列出每一筆紀錄的逐筆結果（樣本少時看個股比看統計實在）
import { promises as fs } from 'fs'
import path from 'path'
import type { SignalSnapshot, StockLogEntry } from '../lib/signal-log'

const LOG_DIR = path.join(process.cwd(), 'data', 'signal-log')
const args = process.argv.slice(2)
const detail = args.includes('--detail')
const horizons = (args.find((a) => /^[\d,]+$/.test(a)) ?? '5,10,20').split(',').map(Number).filter((n) => n > 0)

// 一筆訊號的扁平欄位（JSON 日誌與 Sheet 匯出都收斂成這個形狀）
type Sig = {
  date: string // 資料日
  symbol: string
  name: string
  signal: 'green' | 'yellow' | 'red'
  entry: string
  overall: number
  tech: number
  fund: number | null
  chip: number | null
  distMa60: number
  mood: string
}
type Row = Sig & {
  // 各持有天數的報酬 %；還沒走完 N 個交易日的為 null
  ret: Record<number, number | null>
}

function toDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString('sv', { timeZone: 'Asia/Taipei' })
}

async function loadSignals(): Promise<Sig[]> {
  const bySym = new Map<string, Sig>() // key = date|symbol，後讀到的覆蓋
  const put = (s: Sig) => bySym.set(`${s.date}|${s.symbol}`, s)

  let files: string[] = []
  try {
    files = (await fs.readdir(LOG_DIR)).sort()
  } catch {
    return []
  }
  for (const f of files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
    try {
      const snap = JSON.parse(await fs.readFile(path.join(LOG_DIR, f), 'utf8')) as SignalSnapshot
      for (const e of snap.stocks as StockLogEntry[]) {
        put({
          date: snap.date, symbol: e.symbol, name: e.name, signal: e.signal, entry: e.entry,
          overall: e.overallScore, tech: e.techScore, fund: e.fundScore, chip: e.chipScore,
          distMa60: e.distMa60Pct, mood: snap.market?.moodLabel ?? '（無大盤）',
        })
      }
    } catch (e) {
      console.warn(`[reconcile] 略過壞掉的日誌 ${f}：${e}`)
    }
  }
  // Sheet 匯出：每行 15 欄，分隔可能是 tab 或連續空白（從 Google Sheet 直接貼的會變 4 個空白）
  const tsv = path.join(LOG_DIR, 'sheet-export.tsv')
  try {
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    let n = 0
    for (const line of (await fs.readFile(tsv, 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue
      const c = line.split(/\t| {4}/).map((v) => v.trim()) // 貼上時一個 tab 會變 4 個空白，空欄就是 8 個空白
      if (c.length < 15 || !/^\d{4}-\d{2}-\d{2}$/.test(c[1])) continue
      put({
        date: c[1], symbol: c[2], name: c[3], signal: c[11] as Sig['signal'], entry: c[10],
        overall: Number(c[6]), tech: Number(c[7]), fund: num(c[8]), chip: num(c[9]),
        distMa60: Number(c[12]), mood: c[14],
      })
      n++
    }
    console.log(`[reconcile] 讀入 Sheet 匯出 ${n} 行`)
  } catch {} // 沒有匯出檔就只用 JSON
  return [...bySym.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol))
}

// ---------- 日K（慢速、有磁碟快取）----------
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }
const OHLC_CACHE = path.join(LOG_DIR, 'ohlc-cache')
const REQUEST_GAP_MS = 2_500 // TWSE 大約每 5 秒只容許幾個請求，保守一點
const RATE_LIMIT_BACKOFF_MS = 60_000

function monthsFrom(date: string): string[] {
  const out: string[] = []
  let y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7))
  const cur = taipeiToday()
  const cy = Number(cur.slice(0, 4)), cm = Number(cur.slice(5, 7))
  while (y < cy || (y === cy && m <= cm)) {
    out.push(`${y}${String(m).padStart(2, '0')}`)
    if (++m === 13) { m = 1; y++ }
  }
  return out
}
function taipeiToday(): string {
  return new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' })
}
function rocToEpoch(roc: string): number | null {
  const m = String(roc).trim().match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/)
  return m ? Date.UTC(Number(m[1]) + 1911, Number(m[2]) - 1, Number(m[3])) / 1000 : null
}
function rowToCandle(row: unknown[], volMul: number): Candle | null {
  const n = (v: unknown) => { const x = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(x) ? x : null }
  const time = rocToEpoch(String(row[0])), open = n(row[3]), high = n(row[4]), low = n(row[5]), close = n(row[6])
  if (time == null || open == null || high == null || low == null || close == null) return null
  return { time, open, high, low, close, volume: (n(row[1]) ?? 0) * volMul }
}

let lastRequestAt = 0
// 排隊打一個官方端點：間隔 REQUEST_GAP_MS；428（限流）就睡一分鐘再試，最多 5 次
async function getJsonSlow(url: string): Promise<any | null> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = lastRequestAt + REQUEST_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastRequestAt = Date.now()
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) })
      if (res.status === 428 || res.status === 429) {
        console.log(`[reconcile] 被限流（${res.status}），休息 ${RATE_LIMIT_BACKOFF_MS / 1000}s…`)
        await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS))
        continue
      }
      if (!res.ok) return null
      return await res.json()
    } catch {
      await new Promise((r) => setTimeout(r, 5_000))
    }
  }
  return null
}

type MonthFile = { market: 'TWSE' | 'TPEx' | 'none'; fetchedAt: string; candles: Candle[] }
// 抓一檔的指定月份：先看磁碟快取（過去月份永久有效、本月 12 小時內有效），沒有才打端點。
// 交易所判定：第一個月先試 TWSE，stat 不是 OK 再試 TPEx，之後沿用。
async function fetchMonths(sym: string, months: string[]): Promise<Candle[]> {
  await fs.mkdir(OHLC_CACHE, { recursive: true })
  const cur = taipeiToday().slice(0, 7).replace('-', '')
  let market: MonthFile['market'] | null = null
  const all: Candle[] = []
  for (const ym of months) {
    const file = path.join(OHLC_CACHE, `${sym}-${ym}.json`)
    let mf: MonthFile | null = null
    try {
      const cached = JSON.parse(await fs.readFile(file, 'utf8')) as MonthFile
      if (ym !== cur || Date.now() - Date.parse(cached.fetchedAt) < 12 * 3600 * 1000) mf = cached
    } catch {}
    if (!mf) {
      const y = ym.slice(0, 4), m = ym.slice(4, 6)
      let candles: Candle[] = []
      let mk: MonthFile['market'] = 'none'
      if (market !== 'TPEx') {
        const j = await getJsonSlow(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${y}${m}01&stockNo=${sym}&response=json`)
        if (j?.stat === 'OK' && Array.isArray(j.data)) {
          mk = 'TWSE'
          candles = (j.data as unknown[][]).map((r) => rowToCandle(r, 1)).filter((c): c is Candle => !!c)
        }
      }
      if (mk === 'none' && market !== 'TWSE') {
        const j = await getJsonSlow(`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${sym}&date=${y}/${m}/01&id=&response=json`)
        const t = j?.tables?.[0]
        if (t && Array.isArray(t.data) && t.data.length) {
          mk = 'TPEx'
          candles = (t.data as unknown[][]).map((r) => rowToCandle(r, 1000)).filter((c): c is Candle => !!c)
        }
      }
      mf = { market: mk, fetchedAt: new Date().toISOString(), candles }
      if (mk !== 'none') await fs.writeFile(file, JSON.stringify(mf), 'utf8') // 抓失敗（限流／逾時）不快取，下次重跑再補
    }
    if (mf.market !== 'none') market = mf.market
    all.push(...mf.candles)
  }
  return all.sort((a, b) => a.time - b.time)
}

// ---------- 統計 ----------
type Stat = { n: number; done: number; win: number; sum: number; rets: number[] }
function bucket(rows: Row[], key: (r: Row) => string, h: number): Map<string, Stat> {
  const m = new Map<string, Stat>()
  for (const r of rows) {
    const k = key(r)
    const s = m.get(k) ?? { n: 0, done: 0, win: 0, sum: 0, rets: [] }
    s.n++
    const v = r.ret[h]
    if (v != null) {
      s.done++
      if (v > 0) s.win++
      s.sum += v
      s.rets.push(v)
    }
    m.set(k, s)
  }
  return m
}
function median(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—')

function printTable(title: string, rows: Row[], key: (r: Row) => string, order?: string[]) {
  console.log(`\n### ${title}`)
  const head = ['分組', '筆數', ...horizons.flatMap((h) => [`${h}日勝率`, `${h}日均報酬`, `${h}日中位`])]
  console.log('| ' + head.join(' | ') + ' |')
  console.log('|' + head.map(() => '---').join('|') + '|')
  const groups = new Set(rows.map(key))
  const keys = order ? [...order.filter((k) => groups.has(k)), ...[...groups].filter((k) => !order.includes(k)).sort()] : [...groups].sort()
  for (const k of keys) {
    const cells = [k, String(rows.filter((r) => key(r) === k).length)]
    for (const h of horizons) {
      const s = bucket(rows, key, h).get(k)!
      if (!s.done) cells.push('尚未到期', '—', '—')
      else cells.push(`${((s.win / s.done) * 100).toFixed(0)}% (${s.done})`, pct(s.sum / s.done), pct(median(s.rets)))
    }
    console.log('| ' + cells.join(' | ') + ' |')
  }
}

const scoreBand = (v: number) => (v >= 75 ? '≥75 強' : v >= 60 ? '60~74 偏多' : v >= 40 ? '40~59 中性' : '<40 弱')

async function main() {
  const sigs = await loadSignals()
  if (!sigs.length) {
    console.error(`[reconcile] ${LOG_DIR} 沒有日誌可對帳。排程跑在哪台機器，就把那台的 data/signal-log/ 複製過來，或把線上 Sheet 的訊號分頁貼成 sheet-export.tsv。`)
    process.exit(1)
  }
  const dates = [...new Set(sigs.map((s) => s.date))].sort()
  console.log(`[reconcile] 日誌 ${dates.length} 天（${dates[0]} ～ ${dates.at(-1)}），共 ${sigs.length} 筆訊號（同日同檔已去重），持有天數 ${horizons.join('/')}`)

  // 日K 不走 lib/tw-ohlc（那是線上即時用、一檔抓 7 個月、6 路併發）：幾百檔這樣打，TWSE 回 428 限流，
  // 半數股票會靜悄悄缺月。這裡改成「只抓訊號起始月～本月」、一次一個請求、慢慢排隊、428 就退避重試，
  // 並把抓到的月份存進 data/signal-log/ohlc-cache/，過去的月份不會變，重跑不用再打一次。
  const symbols = [...new Set(sigs.map((s) => s.symbol))]
  const candlesBy = new Map<string, { dates: string[]; closes: number[] }>()
  let done = 0
  for (const sym of symbols) {
    const candles = await fetchMonths(sym, monthsFrom(dates[0]))
    const ds = candles.map((c) => toDate(c.time))
    if (candles.length && ds.every((d, i) => i === 0 || (Date.parse(d) - Date.parse(ds[i - 1])) / 86400000 <= 10)) {
      candlesBy.set(sym, { dates: ds, closes: candles.map((c) => c.close) })
    } else {
      console.warn(`[reconcile] ${sym} 日K 抓不到或有缺段，該檔略過`)
    }
    if (++done % 20 === 0) console.log(`[reconcile] 日K 進度 ${done}/${symbols.length}`)
  }

  const rows: Row[] = []
  let skipped = 0
  for (const s of sigs) {
    const c = candlesBy.get(s.symbol)
    const i0 = c?.dates.indexOf(s.date) ?? -1
    if (!c || i0 < 0) {
      skipped++ // 日誌日期不在日K裡（資料太舊超出 7 個月、或代號變更）
      continue
    }
    const base = c.closes[i0]
    const ret: Row['ret'] = {}
    for (const h of horizons) {
      const j = i0 + h
      ret[h] = j < c.closes.length ? ((c.closes[j] - base) / base) * 100 : null
    }
    rows.push({ ...s, ret })
  }
  if (skipped) console.log(`[reconcile] ${skipped} 筆對不到日K（超過 7 個月或抓取失敗），已略過`)
  if (!rows.length) {
    console.error('[reconcile] 沒有任何一筆對得上日K，無法統計。')
    process.exit(1)
  }

  const trendLabel = { green: '🟢 綠燈', yellow: '🟡 黃燈', red: '🔴 紅燈' } as const
  const bands = ['≥75 強', '60~74 偏多', '40~59 中性', '<40 弱']
  const naBand = (v: number | null) => (v == null ? '無資料' : scoreBand(v))
  const distBand = (d: number) => (d < 0 ? '季線之下' : d < 10 ? '0~10% 貼近季線' : d < 25 ? '10~25%' : '≥25% 乖離大')
  printTable('技術面紅綠燈', rows, (r) => trendLabel[r.signal], ['🟢 綠燈', '🟡 黃燈', '🔴 紅燈'])
  printTable('進場判讀', rows, (r) => r.entry, ['帶量突破', '接近買點', '強勢偏貴', '盤整觀望', '轉弱避開'])
  printTable('總分帶（技術＋基本＋籌碼）', rows, (r) => scoreBand(r.overall), bands)
  printTable('技術分帶', rows, (r) => scoreBand(r.tech), bands)
  printTable('基本面分帶', rows, (r) => naBand(r.fund), [...bands, '無資料'])
  printTable('籌碼分帶', rows, (r) => naBand(r.chip), [...bands, '無資料'])
  printTable('距季線乖離', rows, (r) => distBand(r.distMa60), ['季線之下', '0~10% 貼近季線', '10~25%', '≥25% 乖離大'])
  printTable('進場判讀 × 大盤氣氛', rows, (r) => `${r.mood}｜${r.entry}`)
  printTable('大盤氣氛', rows, (r) => r.mood)
  printTable('全部訊號（基準線）', rows, () => '全部')

  if (detail) {
    console.log('\n### 逐筆明細')
    const head = ['資料日', '代號', '名稱', '燈', '進場', '總分', '籌碼', ...horizons.map((h) => `${h}日`)]
    console.log('| ' + head.join(' | ') + ' |')
    console.log('|' + head.map(() => '---').join('|') + '|')
    for (const r of rows) {
      console.log('| ' + [r.date, r.symbol, r.name, r.signal, r.entry, String(r.overall), r.chip == null ? '—' : String(r.chip), ...horizons.map((h) => (r.ret[h] == null ? '未到期' : pct(r.ret[h]!)))].join(' | ') + ' |')
    }
  }
  const undone = horizons.map((h) => `${h}日：${rows.filter((r) => r.ret[h] == null).length} 筆未到期`).join('；')
  console.log(`\n[reconcile] 共 ${rows.length} 筆進入統計（${undone}）。勝率＝N 日後收盤高於訊號日收盤的比例；未到期的不算。`)
}

main().catch((e) => {
  console.error('[reconcile] 執行失敗：', e)
  process.exit(1)
})
