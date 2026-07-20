import { NextRequest, NextResponse } from 'next/server'
import { getGroqClient, GROQ_MODEL } from '@/lib/groq'
import { fetchMemes, type Meme } from '@/lib/memes'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export type Suggestion = {
  梗圖: Meme
  分數: number
  理由: string
}

// 輸入主題（例：嘲諷台股）→ 從 memes.tw 最新梗圖裡挑調性搭得起來的幾張
//
// 重點：不是找「台股的梗圖」，而是找「嘲諷那個味道」的梗圖——主題由貼文文字負責，
// 梗圖只負責情緒。池子只有最新 50 張，硬要主題吻合幾乎都會落空。
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { 主題?: string }
    const 主題 = (body.主題 ?? '').trim().slice(0, 200)
    if (!主題) return NextResponse.json({ ok: false, error: '請先輸入主題' }, { status: 400 })

    const memes = await fetchMemes()
    // 標題是圖上已經配好的字，拿來判斷調性夠用了，不必對 50 張都跑看圖模型
    const list = memes.map((m, i) => `${i}. ${m.標題}`).join('\n')

    const client = getGroqClient()
    const res = await client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `你幫一個台灣的自動化/AI 工程師挑梗圖發 Threads。他會給你一個主題，你要從梗圖清單裡挑出「配上去發文最搭」的幾張。

清單上每一項是一張梗圖，文字是圖上已經寫好的字。

怎麼挑（重要）：
主題只是他想講的事，梗圖不需要也在講同一件事。要挑的是「情緒和情境對得上」的圖——他的主題如果是嘲諷，就找同樣在嘲諷、在無奈、在翻白眼的圖，主題的內容由他的貼文文字負責交代。硬要找字面上同主題的圖，反而會挑到很爛的結果。

評分 0-10：
- 8 以上：情緒完全對味，圖上的字換個情境就能直接套到這個主題
- 5-7：調性接近，貼文寫得好可以接起來
- 4 以下：氣氛不搭，或圖上的字太特定、綁死在別的事情上

絕對不要推薦的（這是專業帳號，推到就是幫他闖禍）：
- 情色、性暗示、身體部位的黃腔
- 攻擊特定政治人物或政黨、挑動族群對立
- 人身攻擊、歧視、嘲笑外貌或性向
- 看不出在講什麼的私人小圈圈梗（人名代號、遊戲工會內哏）
這幾類一律不列入，寧可少推幾張。

理由要具體講「這張的什麼情緒/情境搭得上這個主題」，不要寫「很適合」「很有趣」這種空話。

寧可只給 2 張高分的，也不要湊滿 5 張爛的。真的都不搭就回空陣列。

只回 JSON：{"推薦":[{"編號":數字,"分數":0到10,"理由":"一句話"}]}，最多 5 個，分數高到低。理由用繁體中文。`,
        },
        { role: 'user', content: `主題：${主題}\n\n梗圖清單：\n${list}` },
      ],
    })

    const raw = res.choices[0]?.message?.content ?? '{}'
    let picked: { 編號: number; 分數: number; 理由: string }[] = []
    try {
      picked = (JSON.parse(raw) as { 推薦?: typeof picked }).推薦 ?? []
    } catch {
      throw new Error('AI 推薦回傳格式錯誤')
    }

    const suggestions: Suggestion[] = picked
      .filter((p) => memes[p.編號])
      .map((p) => ({
        梗圖: memes[p.編號],
        分數: Math.max(0, Math.min(10, Math.round(p.分數))),
        理由: p.理由 ?? '',
      }))

    return NextResponse.json({ ok: true, suggestions, 掃描: memes.length })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
