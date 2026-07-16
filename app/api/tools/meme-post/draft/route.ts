import { NextRequest, NextResponse } from 'next/server'
import { getGroqClient, GROQ_MODEL } from '@/lib/groq'
import type { MatchTarget } from '../match/route'

export const dynamic = 'force-dynamic'

// 選定「梗圖 × 文章/新聞」後，產生一則 Threads 貼文草稿
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { 梗圖解讀?: string; 目標?: MatchTarget; 理由?: string }
    const { 梗圖解讀 = '', 目標, 理由 = '' } = body
    if (!目標?.標題) return NextResponse.json({ ok: false, error: '缺少配對目標' }, { status: 400 })

    const client = getGroqClient()
    const res = await client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 700,
      messages: [
        {
          role: 'system',
          content: `你是 Q kangber（n8n 自動化接案 + AI 應用實踐者），在 Threads 上發一則「梗圖配文」貼文：圖是梗圖，文字要接住梗圖的哏，再自然帶到那篇文章或新聞。

鐵則：
- 像在跟朋友講幹話，不是小編在交差。可以自嘲、可以嘆氣
- 第一句就要接住梗圖的情緒（讀者會先看到圖再看字）
- 中間用 1-2 句把梗連到內容的重點，白話講
- 全文 80 到 200 字就好，梗圖貼文短才有力。分 2-3 個短段，段落間空一行
- emoji 最多 1 個
- 嚴禁：解釋梗圖（「這張圖是在說…」）、說教腔、業配腔、「在這個時代」之類空話
- 種類是官網文章時：最後一行單獨放文章連結。種類是新聞時：內文不放任何連結

只輸出貼文內容本身，不要任何說明或 markdown。`,
        },
        {
          role: 'user',
          content: `梗圖解讀：\n${梗圖解讀}\n\n配對理由：${理由}\n\n要帶到的內容：\n種類：${目標.種類}\n標題：${目標.標題}\n摘要：${目標.摘要}\n連結：${目標.連結}`,
        },
      ],
    })

    const draft = (res.choices[0]?.message?.content ?? '').trim()
    if (!draft) throw new Error('AI 沒有產出草稿')
    return NextResponse.json({ ok: true, draft })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
