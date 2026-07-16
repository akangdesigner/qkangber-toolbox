import { NextResponse } from 'next/server'
import { getIdeas, updateIdeaStatus, IDEA_STATUSES } from '@/lib/ideas'

// 時事點子庫：讀 n8n「點子雷達」每天寫入的點子；POST 改狀態（要做/放生/未讀）

export async function GET() {
  try {
    const ideas = await getIdeas()
    return NextResponse.json({ success: true, ideas })
  } catch (err) {
    const message = err instanceof Error ? err.message : '讀取失敗'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const row = Number(body.row)
    const link = String(body.link || '')
    const status = String(body.status || '')
    if (!row || row < 2 || !link) {
      return NextResponse.json({ error: '參數不完整' }, { status: 400 })
    }
    if (!(IDEA_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: '不支援的狀態' }, { status: 400 })
    }
    await updateIdeaStatus(row, link, status)
    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : '更新失敗'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
