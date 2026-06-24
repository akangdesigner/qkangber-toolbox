import { NextResponse } from 'next/server'
import { getMarketOverview } from '@/lib/stock'

export const dynamic = 'force-dynamic'

// GET /api/market — 大盤環境（加權/費半/標普/VIX）＋偏多偏空總結
export async function GET() {
  try {
    const data = await getMarketOverview()
    return NextResponse.json({ ok: true, ...data })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
