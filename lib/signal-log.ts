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

// 寫入訊號快照，回傳實際記錄的股票檔數。
// 每檔股票落到「它的資料日」檔案（dataDate.json），而不是執行當下的日期：
// 排程錯過 14:30、隔天凌晨補跑時抓到的是前一交易日的 K 線，也能正確補進那一天的檔案。
// 防呆：只收「今天往回 7 天內」的資料日，避免假日/資料源異常把陳舊資料寫成一天新紀錄。
// market-only 的呼叫（stocks 為空）只 merge 進已存在的當日檔，行為不變。
export async function logSnapshot(
  stocks: StockHealth[],
  market: MarketOverview | null,
  source: 'schedule' | 'page',
  opts?: { force?: boolean } // force：略過資料日防呆（測試用）
): Promise<number> {
  const today = taipeiToday()
  const fresh = opts?.force
    ? stocks
    : stocks.filter((s) => {
        if (!s.dataDate || s.dataDate > today) return false
        const ageDays = (Date.parse(today) - Date.parse(s.dataDate)) / 86400000
        return ageDays <= 7
      })

  // 按資料日分組；market 概況只掛到最新的那一天（補跑時抓到的大盤值屬於最近的交易日）
  const byDate = new Map<string, StockHealth[]>()
  for (const s of fresh) {
    const d = opts?.force ? (s.dataDate ?? today) : s.dataDate!
    byDate.set(d, [...(byDate.get(d) ?? []), s])
  }
  if (!byDate.size) byDate.set(today, []) // market-only：維持舊行為，merge 進當日檔
  const newestDate = [...byDate.keys()].sort().at(-1)!

  let written = 0
  await fs.mkdir(LOG_DIR, { recursive: true })
  for (const [date, group] of byDate) {
    const file = path.join(LOG_DIR, `${date}.json`)
    let prev: SignalSnapshot | null = null
    try {
      prev = JSON.parse(await fs.readFile(file, 'utf8')) as SignalSnapshot
    } catch {} // 檔案不存在/壞掉都當沒有
    if (!group.length && !prev) continue

    const bySym = new Map<string, StockLogEntry>()
    for (const s of prev?.stocks ?? []) bySym.set(s.symbol, s)
    for (const s of group) {
      const { series: _series, ...rest } = s
      bySym.set(s.symbol, rest)
    }

    const snap: SignalSnapshot = {
      date,
      asOf: new Date().toISOString(),
      source,
      market: (date === newestDate ? market : null) ?? prev?.market ?? null,
      stocks: [...bySym.values()],
    }
    await fs.writeFile(file, JSON.stringify(snap, null, 1), 'utf8')
    written += group.length
  }
  return written
}
