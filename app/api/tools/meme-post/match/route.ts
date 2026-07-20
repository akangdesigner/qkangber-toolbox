import { NextRequest, NextResponse } from 'next/server'
import { getGroqClient, GROQ_MODEL } from '@/lib/groq'
import { fetchNewsHeadlines, getBlogPosts } from '@/lib/memes'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Groq 上支援看圖的模型（可用環境變數覆蓋）
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct'

export type MatchTarget = {
  種類: '官網文章' | '新聞'
  標題: string
  摘要: string
  連結: string
  來源: string
}

export type MatchResult = {
  分數: number
  理由: string
  目標: MatchTarget
}

// 1) 看圖解讀梗圖 → 2) 跟官網文章＋當日新聞標題配對，回前 5 名
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { 圖片連結?: string; imageBase64?: string; 標題?: string }
    const imageUrl = body.imageBase64 || body.圖片連結
    if (!imageUrl) return NextResponse.json({ ok: false, error: '缺少梗圖（圖片連結或上傳圖）' }, { status: 400 })

    const client = getGroqClient()

    // 梗圖標題現在跟著列表一起從 RSS 來（上傳的圖沒有），不必再多打一次詳細頁
    const titleHint = (body.標題 ?? '').trim()
    const [posts, news] = await Promise.all([getBlogPosts(), fetchNewsHeadlines()])

    // 看圖：圖中文字 + 情境情緒。看圖失敗就退回只用標題硬配。
    let 梗圖解讀 = ''
    try {
      const vres = await client.chat.completions.create({
        model: VISION_MODEL,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `這是一張台灣網路梗圖${titleHint ? `，標題是「${titleHint}」` : ''}。請用繁體中文描述：1. 圖中出現的文字（逐字抄下來）2. 畫面裡的人物/表情/場景 3. 這張梗圖在表達什麼情緒或情境、通常用來吐槽什麼。直接描述，不要開場白。`,
              },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      })
      梗圖解讀 = vres.choices[0]?.message?.content?.trim() ?? ''
    } catch {
      if (!titleHint) throw new Error('看圖模型失敗，且沒有梗圖標題可用，無法配對')
      梗圖解讀 = `（看圖失敗，只知道梗圖標題：「${titleHint}」）`
    }

    // 候選清單編號給文字模型挑
    const targets: MatchTarget[] = [
      ...posts.map((p) => ({
        種類: '官網文章' as const,
        標題: p.標題,
        摘要: p.摘要,
        連結: p.連結,
        來源: 'aiqkangber.com',
      })),
      ...news.map((n) => ({ 種類: '新聞' as const, 標題: n.標題, 摘要: n.摘要, 連結: n.連結, 來源: n.來源 })),
    ]
    if (targets.length === 0) return NextResponse.json({ ok: false, error: '沒有可配對的文章或新聞' }, { status: 500 })

    const list = targets
      .map((t, i) => `${i}. [${t.種類}] ${t.標題}${t.摘要 ? `｜${t.摘要.slice(0, 80)}` : ''}`)
      .join('\n')

    const mres = await client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 800,
      messages: [
        {
          role: 'system',
          content: `你在幫一個台灣的自動化/AI 工程師經營 Threads。他選了一張梗圖，你要從他的官網文章和今天的科技新聞裡，挑出「配上這張梗圖發文最有梗、最不硬湊」的內容。

評分標準（0-10）：梗圖的情緒/情境跟內容主題真的對得上、放在一起會讓人會心一笑的給高分；只是關鍵字沾邊、其實氣氛完全不搭的給低分。寧可全部低分，也不要硬湊。

只回 JSON：{"配對":[{"編號":數字,"分數":0到10,"理由":"一句話說為什麼搭（或哪裡妙）"}]}，取最好的 5 個，分數高到低排。理由用繁體中文。`,
        },
        { role: 'user', content: `梗圖解讀：\n${梗圖解讀}\n\n候選清單：\n${list}` },
      ],
    })

    const raw = mres.choices[0]?.message?.content ?? ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('AI 配對回傳格式錯誤')
    const parsed = JSON.parse(jsonMatch[0]) as { 配對: { 編號: number; 分數: number; 理由: string }[] }

    const matches: MatchResult[] = (parsed.配對 ?? [])
      .filter((m) => targets[m.編號])
      .map((m) => ({ 分數: Math.max(0, Math.min(10, Math.round(m.分數))), 理由: m.理由 ?? '', 目標: targets[m.編號] }))

    return NextResponse.json({ ok: true, 梗圖解讀, matches, 掃描: { 官網文章: posts.length, 新聞: news.length } })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
