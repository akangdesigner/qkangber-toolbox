import { NextResponse } from 'next/server'
import { getGroqClient, GROQ_MODEL } from '@/lib/groq'
import { isReady, getReport, retrieve, buildSystemPrompt, detectCrisis, CRISIS_RESPONSE } from '@/lib/memory-bot'

// 思念機器人聊天 API：用真實對話統計出的人格 + 窮人版 RAG，讓 AI 用「那個人」的口氣回。

type ChatMsg = { role: 'user' | 'assistant'; content: string }

export async function GET() {
  // 給前端開頁時取對象資訊（名字 / emoji），順便確認資料是否就緒
  if (!isReady()) {
    return NextResponse.json({ ready: false, error: '尚未匯入對話資料（請先跑 parse + build-persona）' })
  }
  const r = getReport()
  return NextResponse.json({ ready: true, target: r.target, user: r.user })
}

export async function POST(request: Request) {
  if (!isReady()) {
    return NextResponse.json({ error: '尚未匯入對話資料' }, { status: 400 })
  }

  let body: { messages?: ChatMsg[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: '無效的請求格式' }, { status: 400 })
  }

  const history = (body.messages ?? []).filter((m) => m?.content?.trim()).slice(-20)
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  if (!lastUser) {
    return NextResponse.json({ error: '沒有訊息內容' }, { status: 400 })
  }

  // 安全政策：偵測到危機訊息就不進 LLM，直接回固定文案（不能讓「人設」在這種時刻附和）
  if (detectCrisis(lastUser.content)) {
    return NextResponse.json({ success: true, reply: CRISIS_RESPONSE, crisis: true })
  }

  const ctx = retrieve(lastUser.content)
  const ctxBlock = ctx.length
    ? `\n\n【你們以前的對話片段（背景參考，別逐字複述）】\n${ctx.join('\n---\n')}`
    : ''

  try {
    const client = getGroqClient()
    const completion = await client.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.85,
      max_tokens: 300,
      messages: [
        { role: 'system', content: buildSystemPrompt() + ctxBlock },
        ...history,
      ],
    })
    const reply = completion.choices[0]?.message?.content?.trim() ?? ''
    return NextResponse.json({ success: true, reply })
  } catch (err) {
    const message = err instanceof Error ? err.message : '回覆失敗，請稍後再試'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
