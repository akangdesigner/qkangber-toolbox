import { NextRequest, NextResponse } from 'next/server'
import { getGroqClient, GROQ_MODEL } from '@/lib/groq'
import { fetchMemes, type Meme } from '@/lib/memes'
import { fetchTemplates, type Template } from '@/lib/imgflip'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export type Suggestion = {
  梗圖: Meme
  分數: number
  理由: string
}

// 空白模板的建議：AI 挑格式並把每一格的中文字寫好，人再自己合成
export type TemplateSuggestion = {
  模板: Template
  分數: number
  理由: string
  文字: string[]
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

    // 兩種素材：memes.tw 的現成本土梗（有就最好），Imgflip 的經典空白格式（永遠都在，
    // 冷門主題如 AI/工程靠它撐）。任一邊掛掉不影響另一邊。
    const [memesResult, templatesResult] = await Promise.allSettled([fetchMemes(), fetchTemplates()])
    const memes = memesResult.status === 'fulfilled' ? memesResult.value : []
    const templates = templatesResult.status === 'fulfilled' ? templatesResult.value : []
    if (memes.length === 0 && templates.length === 0) throw new Error('兩邊素材都抓不到')

    // 標題是圖上已經配好的字，拿來判斷調性夠用了，不必對 50 張都跑看圖模型
    const list = memes.map((m, i) => `${i}. ${m.標題}`).join('\n')
    const templateList = templates.map((t, i) => `${i}. ${t.name}（${t.box_count} 格字）`).join('\n')

    const client = getGroqClient()
    const res = await client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `你幫一個台灣的自動化/AI 工程師挑梗圖發 Threads。他會給你一個主題，你要給他兩種素材建議。

【A. 現成梗圖】清單上每一項是一張別人已經配好字的梗圖，文字就是圖上的字。他直接拿圖來發，不能改圖上的字。

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

寧可只給 2 張高分的，也不要湊滿 5 張爛的。真的都不搭就給空陣列——尤其他的主題是 AI、程式、工程這類，台灣梗圖圈很少做，通常就是沒有，這時候空的才是誠實的答案。

【B. 空白模板】這些是經典梗圖格式（空白的，字還沒寫）。挑 2–3 個最適合這個主題的格式，並且幫他把每一格的字寫好。

- 每一格的字用繁體中文，短、口語、有哏，一格最多 15 字
- 文字陣列的長度要剛好等於那個模板的格數
- 這是他的專業帳號，寫得聰明帶點自嘲，不要低級或人身攻擊
- 格式要真的對位：講「期待落空」用期待vs現實類、講「二選一的兩難」用 Two Buttons、講「捨棄舊的選新的」用 Drake

只回 JSON：
{"推薦":[{"編號":數字,"分數":0到10,"理由":"一句話"}],
 "模板":[{"編號":數字,"分數":0到10,"理由":"一句話","文字":["第一格","第二格"]}]}
推薦最多 5 個、模板最多 3 個，都照分數高到低。全部用繁體中文。`,
        },
        {
          role: 'user',
          content: `主題：${主題}\n\n【A. 現成梗圖清單】\n${list || '（這次抓不到）'}\n\n【B. 空白模板清單】\n${templateList || '（這次抓不到）'}`,
        },
      ],
    })

    const raw = res.choices[0]?.message?.content ?? '{}'
    let picked: { 編號: number; 分數: number; 理由: string }[] = []
    let pickedTemplates: { 編號: number; 分數: number; 理由: string; 文字: string[] }[] = []
    try {
      const parsed = JSON.parse(raw) as {
        推薦?: typeof picked
        模板?: typeof pickedTemplates
      }
      picked = parsed.推薦 ?? []
      pickedTemplates = parsed.模板 ?? []
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

    const templateSuggestions: TemplateSuggestion[] = pickedTemplates
      .filter((p) => templates[p.編號])
      .map((p) => {
        const 模板 = templates[p.編號]
        // AI 有時會給錯格數，補足或截斷到模板實際的格數，前端才好照格顯示
        const 文字 = Array.from({ length: 模板.box_count }, (_, i) => String(p.文字?.[i] ?? '').trim())
        return {
          模板,
          分數: Math.max(0, Math.min(10, Math.round(p.分數))),
          理由: p.理由 ?? '',
          文字,
        }
      })
      .filter((t) => t.文字.some(Boolean))

    return NextResponse.json({
      ok: true,
      suggestions,
      templateSuggestions,
      掃描: { 現成梗圖: memes.length, 模板: templates.length },
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
