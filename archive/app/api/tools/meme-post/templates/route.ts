import { NextResponse } from 'next/server'
import { fetchTemplates } from '@/lib/imgflip'

export const dynamic = 'force-dynamic'

// 全部經典格式，給前端自己瀏覽挑（不經過 AI 篩選）
export async function GET() {
  try {
    const templates = await fetchTemplates()
    return NextResponse.json({ ok: true, templates })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
