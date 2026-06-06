import { NextResponse } from 'next/server'
import { getGroqClient, GROQ_MODEL } from '@/lib/groq'

// 自用工具箱：路由已由 middleware 保護，不需 rate limit / api key

const SYSTEM_PROMPT = `你是一個會在 Threads 隨手分享工作日常的台灣人，不是在寫文章、不是在教學、不是行銷。

語氣要求：
- 像在傳訊息給朋友，不是在發佈聲明
- 可以碎念、可以嘆氣、可以說「我也不確定」
- 不要「這提醒我們」「值得我們深思」「這正是」「其實」這類說教腔
- 不要條列式、不要小標題、不要粗體重點
- 不要「今天想跟大家分享」「希望對你有幫助」這種開場白結語

任務：把長文裡的內容，用自己親身碰過的口吻重新說一遍（主貼文 + 第一則留言）。

主貼文：
- 開頭直接從一個具體的情況或感受說起，不要鋪陳
- 把文章裡 2–3 個有趣的點，用自己的話說出來，可以帶點個人反應
- 結尾自然收，可以是感嘆、疑問、或沒有強迫感的互動句
- 不超過 200 字，不放 hashtag

第一則留言：
- 補一兩個文章細節或自己的小補充，語氣繼續輕鬆
- 倒數第二行固定放這句 CTA（原文照抄）：詳細工具請參考官網部落格 https://aiqkangber.com/blog
- 最後放 8–10 個 hashtag（繁體中文 + 英文混搭）

只輸出 JSON，不要包含任何其他文字或 markdown：
{"post_content":"主貼文內容","first_comment":"第一則留言內容（含 hashtag）"}`

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export async function POST(request: Request) {
  let body: { html?: string; platform?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: '無效的請求格式' }, { status: 400 })
  }

  const { html, platform = 'Threads' } = body
  if (!html || html.trim().length < 20) {
    return NextResponse.json({ error: '請貼上文章內容' }, { status: 400 })
  }

  const plainText = stripHtml(html).slice(0, 4000)

  try {
    const client = getGroqClient()
    const completion = await client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `平台：${platform}\n\n以下是文章內容：\n\n${plainText}` },
      ],
    })

    const raw = completion.choices[0]?.message?.content ?? ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('AI 回傳格式錯誤')

    const data = JSON.parse(jsonMatch[0]) as { post_content: string; first_comment: string }
    return NextResponse.json({ success: true, data })
  } catch (err) {
    const message = err instanceof Error ? err.message : '產生失敗，請稍後再試'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
