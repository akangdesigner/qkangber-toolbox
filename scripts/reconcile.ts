// 訊號對帳（收割）：把 data/signal-log/*.json 累積的「當天訊號」對上後來真實走勢，
// 回答「這套紅綠燈／進場判讀／總分，到底有沒有預測力」。
//
// 做法：每筆 (資料日, 股票) 紀錄，用 TWSE/TPEx 官方日K 找到資料日收盤，再往後數 N 個交易日算報酬；
// 依 紅綠燈 / 進場判讀 / 總分帶 / 籌碼方向 / 大盤氣氛 分組，統計筆數、勝率、平均與中位數報酬。
// 和 scripts/backtest.ts 的差別：backtest 只能重放技術面；這裡對的是當時「三柱齊全」的實際輸出，
// 包含營收、法人這些沒有歷史 API 的欄位——所以日誌累積得越久，這份對帳越有價值。
//
// 用法：npx tsx scripts/reconcile.ts [持有天數清單=5,10,20] [--detail]
//   --detail：額外列出每一筆紀錄的逐筆結果（樣本少時看個股比看統計實在）
import { promises as fs } from 'fs'
import path from 'path'
import { fetchTwCandles } from '../lib/tw-ohlc'
import type { SignalSnapshot, StockLogEntry } from '../lib/signal-log'

const LOG_DIR = path.join(process.cwd(), 'data', 'signal-log')
const args = process.argv.slice(2)
const detail = args.includes('--detail')
const horizons = (args.find((a) => /^[\d,]+$/.test(a)) ?? '5,10,20').split(',').map(Number).filter((n) => n > 0)

type Row = {
  date: string
  symbol: string
  name: string
  entry: StockLogEntry
  mood: string
  // 各持有天數的報酬 %；還沒走完 N 個交易日的為 null
  ret: Record<number, number | null>
}

function toDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString('sv', { timeZone: 'Asia/Taipei' })
}

async function loadSnapshots(): Promise<SignalSnapshot[]> {
  let files: string[] = []
  try {
    files = (await fs.readdir(LOG_DIR)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  } catch {
    return []
  }
  const out: SignalSnapshot[] = []
  for (const f of files) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(LOG_DIR, f), 'utf8')) as SignalSnapshot)
    } catch (e) {
      console.warn(`[reconcile] 略過壞掉的日誌 ${f}：${e}`)
    }
  }
  return out
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
  const snaps = await loadSnapshots()
  if (!snaps.length) {
    console.error(`[reconcile] ${LOG_DIR} 沒有日誌可對帳。排程跑在哪台機器，就把那台的 data/signal-log/ 複製過來，或直接在那台跑這支腳本。`)
    process.exit(1)
  }
  const dates = snaps.map((s) => s.date)
  const total = snaps.reduce((n, s) => n + s.stocks.length, 0)
  console.log(`[reconcile] 日誌 ${snaps.length} 天（${dates[0]} ～ ${dates.at(-1)}），共 ${total} 筆訊號，持有天數 ${horizons.join('/')}`)

  // 每檔股票只抓一次日K（fetchTwCandles 內建併發閘門與快取）
  const symbols = [...new Set(snaps.flatMap((s) => s.stocks.map((x) => x.symbol)))]
  const candlesBy = new Map<string, { dates: string[]; closes: number[] }>()
  await Promise.all(
    symbols.map(async (sym) => {
      const ohlc = await fetchTwCandles(sym).catch(() => null)
      if (!ohlc?.candles.length) {
        console.warn(`[reconcile] ${sym} 抓不到日K，該檔略過`)
        return
      }
      candlesBy.set(sym, { dates: ohlc.candles.map((c) => toDate(c.time)), closes: ohlc.candles.map((c) => c.close) })
    })
  )

  const rows: Row[] = []
  let skipped = 0
  for (const snap of snaps) {
    for (const e of snap.stocks) {
      const c = candlesBy.get(e.symbol)
      const i0 = c?.dates.indexOf(snap.date) ?? -1
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
      rows.push({ date: snap.date, symbol: e.symbol, name: e.name, entry: e, mood: snap.market?.moodLabel ?? '（無大盤）', ret })
    }
  }
  if (skipped) console.log(`[reconcile] ${skipped} 筆對不到日K（超過 7 個月或抓取失敗），已略過`)
  if (!rows.length) {
    console.error('[reconcile] 沒有任何一筆對得上日K，無法統計。')
    process.exit(1)
  }

  const trendLabel = { green: '🟢 綠燈', yellow: '🟡 黃燈', red: '🔴 紅燈' } as const
  printTable('技術面紅綠燈', rows, (r) => trendLabel[r.entry.signal], ['🟢 綠燈', '🟡 黃燈', '🔴 紅燈'])
  printTable('進場判讀', rows, (r) => r.entry.entry, ['帶量突破', '接近買點', '強勢偏貴', '盤整觀望', '轉弱避開'])
  printTable('總分帶（技術＋基本＋籌碼）', rows, (r) => scoreBand(r.entry.overallScore), ['≥75 強', '60~74 偏多', '40~59 中性', '<40 弱'])
  printTable('籌碼方向', rows, (r) => ({ buy: '法人買超', sell: '法人賣超', neutral: '中性', na: '無資料' })[r.entry.chipSignal], ['法人買超', '中性', '法人賣超', '無資料'])
  printTable('法人同買（外資＋投信）', rows, (r) => (r.entry.chipBothBuy ? '同買' : '非同買'), ['同買', '非同買'])
  printTable('大盤氣氛', rows, (r) => r.mood)
  printTable('全部訊號（基準線）', rows, () => '全部')

  if (detail) {
    console.log('\n### 逐筆明細')
    const head = ['資料日', '代號', '名稱', '燈', '進場', '總分', '籌碼', ...horizons.map((h) => `${h}日`)]
    console.log('| ' + head.join(' | ') + ' |')
    console.log('|' + head.map(() => '---').join('|') + '|')
    for (const r of rows) {
      console.log('| ' + [r.date, r.symbol, r.name, r.entry.signal, r.entry.entry, String(r.entry.overallScore), r.entry.chipSignal, ...horizons.map((h) => (r.ret[h] == null ? '未到期' : pct(r.ret[h]!)))].join(' | ') + ' |')
    }
  }
  const undone = horizons.map((h) => `${h}日：${rows.filter((r) => r.ret[h] == null).length} 筆未到期`).join('；')
  console.log(`\n[reconcile] 共 ${rows.length} 筆進入統計（${undone}）。勝率＝N 日後收盤高於訊號日收盤的比例；未到期的不算。`)
}

main().catch((e) => {
  console.error('[reconcile] 執行失敗：', e)
  process.exit(1)
})
