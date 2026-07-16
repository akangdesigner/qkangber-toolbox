import { NextRequest, NextResponse } from 'next/server'
import { fetchMemes } from '@/lib/memes'

export const dynamic = 'force-dynamic'

// 瀏覽/搜尋 memes.tw 梗圖（q 留空＝熱門）
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? ''
  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page') ?? '1') || 1)
  try {
    const memes = await fetchMemes(q.trim(), page)
    return NextResponse.json({ ok: true, memes })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
