import { NextResponse } from 'next/server'
import { fetchMemes } from '@/lib/memes'

export const dynamic = 'force-dynamic'

// 讀 memes.tw 官方 RSS 的最新梗圖（沒有搜尋和翻頁，原因見 lib/memes.ts）
export async function GET() {
  try {
    const memes = await fetchMemes()
    return NextResponse.json({ ok: true, memes })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
