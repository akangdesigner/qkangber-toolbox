import { NextRequest, NextResponse } from 'next/server'
import { generateDraft, STYLES, type Style } from '@/lib/news-draft'
import { llmErrorMessage } from '@/lib/llm-json'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 前端點了某個風格才呼叫，一次只生一篇（一篇約 1.6k token）
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      風格?: string
      標題?: string
      來源?: string
      類型?: string
      摘要?: string
      原文連結?: string
    }
    const 風格 = body.風格 as Style
    if (!STYLES.includes(風格)) return NextResponse.json({ ok: false, error: '風格不合法' }, { status: 400 })
    if (!body.標題) return NextResponse.json({ ok: false, error: '缺少標題' }, { status: 400 })

    const 內容 = await generateDraft(
      {
        標題: body.標題,
        來源: body.來源 ?? '',
        類型: body.類型 ?? '',
        摘要: body.摘要 ?? '',
        原文連結: body.原文連結 ?? '',
      },
      風格
    )
    if (!內容) return NextResponse.json({ ok: false, error: 'AI 回傳格式壞掉，再按一次試試' }, { status: 502 })
    return NextResponse.json({ ok: true, 內容 })
  } catch (e) {
    return NextResponse.json({ ok: false, error: llmErrorMessage(e) }, { status: 500 })
  }
}
