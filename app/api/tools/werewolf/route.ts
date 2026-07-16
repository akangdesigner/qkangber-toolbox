import { NextResponse } from 'next/server'
import { transcribeAudio, transcribeWithTone, judge, reflect, takeNotes } from '@/lib/werewolf'

// 狼人殺筆記後端：無狀態，只做三件 AI 事。金鑰留在 .env（GROQ_API_KEY）。
// - action=transcribe：multipart form-data，欄位 audio（音檔）→ 回逐字稿
// - action=judge：JSON { board, transcript, lessons } → 回判狼結果
// - action=reflect：JSON { board, transcript, prediction, truth, result } → 回教訓

export const maxDuration = 120 // 雙世界並行分析＋裁判需要較長時間

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? ''

  try {
    // ---- 轉錄：走 multipart ----
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData()
      const audio = form.get('audio')
      if (!(audio instanceof File)) {
        return NextResponse.json({ error: '沒有收到音檔' }, { status: 400 })
      }
      if (audio.size === 0) {
        return NextResponse.json({ error: '音檔是空的' }, { status: 400 })
      }
      // mode=tone → Gemini 聽音檔並標語氣；否則走 whisper 純文字
      // （GROQ_API_KEY 沒設定時，純文字模式也自動退到 Gemini）
      const mode = form.get('mode')
      const useTone = mode === 'tone' || !process.env.GROQ_API_KEY
      const text = useTone ? await transcribeWithTone(audio) : await transcribeAudio(audio)
      return NextResponse.json({ success: true, text })
    }

    // ---- 判狼 / 復盤：走 JSON ----
    const body = await request.json()
    const action = body.action as string

    if (action === 'judge') {
      if (!body.board || !body.transcript) {
        return NextResponse.json({ error: '缺少板子或逐字稿' }, { status: 400 })
      }
      const result = await judge({
        board: body.board,
        transcript: body.transcript,
        lessons: Array.isArray(body.lessons) ? body.lessons : [],
        events: Array.isArray(body.events) ? body.events : [],
        notes: Array.isArray(body.notes) ? body.notes : [],
      })
      return NextResponse.json({ success: true, judgement: result })
    }

    if (action === 'notes') {
      // 即時筆記：從新轉錄段落萃取所有有用資訊
      if (!body.segment || !Array.isArray(body.seats)) {
        return NextResponse.json({ error: '缺少發言片段或座位' }, { status: 400 })
      }
      const notes = await takeNotes({
        segment: body.segment,
        seats: body.seats,
        existingNotes: Array.isArray(body.existingNotes) ? body.existingNotes : [],
      })
      return NextResponse.json({ success: true, notes })
    }

    if (action === 'reflect') {
      if (!body.board || !Array.isArray(body.truth)) {
        return NextResponse.json({ error: '缺少板子或真相' }, { status: 400 })
      }
      const result = await reflect({
        board: body.board,
        transcript: body.transcript ?? '',
        prediction: body.prediction ?? null,
        truth: body.truth,
        result: body.result,
        events: Array.isArray(body.events) ? body.events : [],
      })
      return NextResponse.json({ success: true, ...result })
    }

    return NextResponse.json({ error: '未知的 action' }, { status: 400 })
  } catch (err) {
    const message = err instanceof Error ? err.message : '處理失敗，請稍後再試'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
