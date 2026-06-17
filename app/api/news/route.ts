import { NextRequest, NextResponse } from 'next/server'
import { appendPostedLog, getPostedLog, twNow } from '@/lib/news'
import { postToThreads } from '@/lib/threads'

export const dynamic = 'force-dynamic'

// 發文紀錄（給前端顯示歷史）
export async function GET() {
  try {
    const log = await getPostedLog()
    return NextResponse.json({ ok: true, log })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}

// 發文：發到 Threads → 成功才記一筆
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { text = '', 圖片連結 = '', 配圖 = '否', 類型 = '', 標題 = '', 來源 = '', 原文連結 = '' } = body as {
      text?: string
      圖片連結?: string
      配圖?: string
      類型?: string
      標題?: string
      來源?: string
      原文連結?: string
    }
    if (!text.trim()) return NextResponse.json({ ok: false, error: '貼文內容是空的' }, { status: 400 })

    const useImg = 配圖 === '是' && !!圖片連結
    const result = await postToThreads({ text, imageUrl: useImg ? 圖片連結 : undefined })
    await appendPostedLog({
      發文時間: twNow(),
      類型,
      標題,
      來源,
      原文連結,
      發文內容: text,
      Threads連結: result.permalink || '',
    })
    return NextResponse.json({ ok: true, permalink: result.permalink })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
