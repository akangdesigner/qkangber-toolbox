// 每日訊號快照：讀 data/watchlist.json 的自選清單，逐檔健檢＋大盤概況，寫入 data/signal-log/YYYY-MM-DD.json
// 用法：npx tsx scripts/snapshot.ts [--force]（--force 略過交易日防呆，測試用）
// 由 Windows 工作排程器（工作名 qkangber-signal-log）每個平日 14:30 收盤後執行，不需要 dev server 在跑
import { promises as fs } from 'fs'
import path from 'path'
import { analyzeStock, getMarketOverview, type StockHealth } from '../lib/stock'
import { logSnapshot, taipeiToday } from '../lib/signal-log'

const DEFAULT_LIST = ['2330', '0050', '2412']
const force = process.argv.includes('--force')

async function main() {
  let symbols = DEFAULT_LIST
  try {
    const raw = JSON.parse(await fs.readFile(path.join(process.cwd(), 'data', 'watchlist.json'), 'utf8'))
    if (Array.isArray(raw.symbols) && raw.symbols.length) symbols = raw.symbols.slice(0, 30)
  } catch {} // 沒同步過清單就用預設

  console.log(`[snapshot] ${taipeiToday()} 清單 ${symbols.length} 檔：${symbols.join(',')}${force ? '（--force）' : ''}`)
  const [results, market] = await Promise.all([
    Promise.all(symbols.map((s) => analyzeStock(s))),
    getMarketOverview().catch(() => null),
  ])
  const ok = results.filter((r): r is StockHealth => !('error' in r))
  for (const r of results) if ('error' in r) console.warn(`[snapshot] ${r.symbol} 分析失敗：${r.error}`)

  const n = await logSnapshot(ok, market, 'schedule', { force })
  if (n === 0) console.log('[snapshot] 今天沒有新交易資料（假日或未收盤），未寫入。')
  else console.log(`[snapshot] 已記錄 ${n} 檔＋大盤 → data/signal-log/${taipeiToday()}.json`)
}

main().catch((e) => {
  console.error('[snapshot] 執行失敗：', e)
  process.exit(1)
})
