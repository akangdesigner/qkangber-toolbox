import { NextRequest, NextResponse } from 'next/server'
import { postToThreads } from '@/lib/threads'

export const dynamic = 'force-dynamic'

// 發文：發到 Threads。發文紀錄（Sheet）2026-10-29 拿掉了，不再記。
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { text = '', 圖片連結 = '', 配圖 = '否' } = body as { text?: string; 圖片連結?: string; 配圖?: string }
    if (!text.trim()) return NextResponse.json({ ok: false, error: '貼文內容是空的' }, { status: 400 })

    const useImg = 配圖 === '是' && !!圖片連結
    const result = await postToThreads({ text, imageUrl: useImg ? 圖片連結 : undefined })
    return NextResponse.json({ ok: true, permalink: result.permalink })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
