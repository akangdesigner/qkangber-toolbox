import { NextRequest, NextResponse } from 'next/server'
import { analyzeStock, type StockHealth } from '@/lib/stock'
import { logSnapshot } from '@/lib/signal-log'

export const dynamic = 'force-dynamic'

// GET /api/watch?symbols=2330,0050,6488
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('symbols') || ''
  const symbols = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 30) // 上限 30 檔，避免一次打太多

  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: '請提供 symbols（例如 ?symbols=2330,0050）' }, { status: 400 })
  }

  try {
    const results = await Promise.all(symbols.map((s) => analyzeStock(s)))
    // 開頁被動補記訊號日誌：排程沒跑到的日子，只要有開頁看盤當天就有紀錄（假日防呆在 logSnapshot 內）
    const healthy = results.filter((r): r is StockHealth => !('error' in r))
    await logSnapshot(healthy, null, 'page').catch(() => {})
    return NextResponse.json({ ok: true, results, asOf: new Date().toISOString() })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
