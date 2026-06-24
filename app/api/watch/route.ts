import { NextRequest, NextResponse } from 'next/server'
import { analyzeStock } from '@/lib/stock'

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
    return NextResponse.json({ ok: true, results, asOf: new Date().toISOString() })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
