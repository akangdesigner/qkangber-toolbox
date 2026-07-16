// 訊號日誌：把每天的健檢結果存成 data/signal-log/YYYY-MM-DD.json，累積「當天訊號 vs 後續走勢」的對帳資料
// 寫入方有兩路：scripts/snapshot.ts 的每日排程快照（schedule）與 /api 的開頁被動補記（page）
// 同一天的檔案依 symbol 合併（後寫覆蓋同檔股票、market 有新值就更新），兩路互不打架
import { promises as fs } from 'fs'
import path from 'path'
import type { StockHealth, MarketOverview } from './stock'

export type StockLogEntry = Omit<StockHealth, 'series'> // 日誌不存畫圖序列，檔案瘦身
export type SignalSnapshot = {
  date: string // 台北日期 YYYY-MM-DD
  asOf: string // 最後寫入時間 ISO
  source: 'schedule' | 'page' // 最後一次寫入來源
  market: MarketOverview | null
  stocks: StockLogEntry[]
}

const LOG_DIR = path.join(process.cwd(), 'data', 'signal-log')

export function taipeiToday(): string {
  return new Date().toLocaleDateString('sv', { timeZone: 'Asia/Taipei' }) // sv locale = YYYY-MM-DD
}

// 寫入當日訊號快照，回傳實際記錄的股票檔數。
// 交易日防呆：只記「最後一根日K就是今天」的股票，避免假日/盤前把昨天的資料重複記一份；
// 全部都不是今天、且當日檔案不存在 → 不寫檔（回傳 0）。market-only 的呼叫只會 merge 進已存在的當日檔。
export async function logSnapshot(
  stocks: StockHealth[],
  market: MarketOverview | null,
  source: 'schedule' | 'page',
  opts?: { force?: boolean } // force：略過交易日防呆（測試用）
): Promise<number> {
  const today = taipeiToday()
  const fresh = opts?.force ? stocks : stocks.filter((s) => s.dataDate === today)

  const file = path.join(LOG_DIR, `${today}.json`)
  let prev: SignalSnapshot | null = null
  try {
    prev = JSON.parse(await fs.readFile(file, 'utf8')) as SignalSnapshot
  } catch {} // 檔案不存在/壞掉都當沒有
  if (!fresh.length && !prev) return 0

  const bySym = new Map<string, StockLogEntry>()
  for (const s of prev?.stocks ?? []) bySym.set(s.symbol, s)
  for (const s of fresh) {
    const { series: _series, ...rest } = s
    bySym.set(s.symbol, rest)
  }

  const snap: SignalSnapshot = {
    date: today,
    asOf: new Date().toISOString(),
    source,
    market: market ?? prev?.market ?? null,
    stocks: [...bySym.values()],
  }
  await fs.mkdir(LOG_DIR, { recursive: true })
  await fs.writeFile(file, JSON.stringify(snap, null, 1), 'utf8')
  return fresh.length
}
