// 每日訊號快照：讀 data/watchlist.json 的自選清單，逐檔健檢＋大盤概況，寫入 data/signal-log/YYYY-MM-DD.json
// 用法：npx tsx scripts/snapshot.ts [--force]（--force 略過交易日防呆，測試用）
// 由 Windows 工作排程器（工作名 qkangber-signal-log）每個平日 14:30 收盤後執行，不需要 dev server 在跑
import { promises as fs } from 'fs'
import path from 'path'
import { analyzeStock, getMarketOverview, type MarketOverview, type StockHealth } from '../lib/stock'
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

  // 逐輪重試：14:30 排程或凌晨補跑常遇到網路剛醒/瞬斷，一次 fetch failed 不該賠掉一整天的紀錄
  const RETRIES = 3, RETRY_GAP_MS = 20_000
  const ok = new Map<string, StockHealth>()
  let market: MarketOverview | null = null
  let lastErrors: string[] = []
  for (let round = 1; round <= RETRIES; round++) {
    const pending = symbols.filter((s) => !ok.has(s))
    if (!pending.length && market) break
    if (round > 1) {
      console.log(`[snapshot] 第 ${round} 次嘗試（待重試 ${pending.length} 檔${market ? '' : '＋大盤'}），等 ${RETRY_GAP_MS / 1000}s…`)
      await new Promise((r) => setTimeout(r, RETRY_GAP_MS))
    }
    // 先標好型別再丟進 Promise.all：不然 mkt 的推論會繞回上一輪指派的 market，TS 判成循環（TS7022）
    const marketPromise: Promise<MarketOverview | null> = market
      ? Promise.resolve(market)
      : getMarketOverview().catch(() => null)
    const [results, mkt] = await Promise.all([
      Promise.all(pending.map((s) => analyzeStock(s))),
      marketPromise,
    ])
    market = mkt
    lastErrors = []
    for (const r of results) {
      if ('error' in r) lastErrors.push(`${r.symbol}：${r.error}`)
      else ok.set(r.symbol, r)
    }
  }
  for (const e of lastErrors) console.warn(`[snapshot] 分析失敗（已重試 ${RETRIES} 次）：${e}`)

  if (!ok.size) {
    console.error('[snapshot] 全部標的抓取失敗，本次未寫入——以非零結束讓排程器重跑。')
    process.exit(1)
  }
  const n = await logSnapshot([...ok.values()], market, 'schedule', { force })
  if (n === 0) console.log('[snapshot] 沒有 7 天內的新交易資料（假日連休？），未寫入。')
  else console.log(`[snapshot] 已記錄 ${n} 檔＋大盤（依資料日落檔）`)
}

main().catch((e) => {
  console.error('[snapshot] 執行失敗：', e)
  process.exit(1)
})
