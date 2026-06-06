import { NextRequest, NextResponse } from 'next/server'
import { getCandidates, updateCandidate } from '@/lib/sheets'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const all = await getCandidates()
    return NextResponse.json({ ok: true, candidates: all })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { rowNumber, 草稿, 狀態 } = await req.json()
    if (!rowNumber || !狀態) {
      return NextResponse.json({ ok: false, error: '缺少 rowNumber 或狀態' }, { status: 400 })
    }
    await updateCandidate(Number(rowNumber), 草稿 ?? '', 狀態)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
