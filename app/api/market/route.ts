import { NextResponse } from 'next/server'
import { getMarketOverview } from '@/lib/stock'
import { logSnapshot } from '@/lib/signal-log'

export const dynamic = 'force-dynamic'

// GET /api/market — 大盤環境（加權/費半/標普/VIX）＋偏多偏空總結
export async function GET() {
  try {
    const data = await getMarketOverview()
    // 把大盤概況 merge 進當日訊號日誌（只在當日檔已存在時生效，避免假日產生只有大盤的空檔）
    await logSnapshot([], data, 'page').catch(() => {})
    return NextResponse.json({ ok: true, ...data })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
