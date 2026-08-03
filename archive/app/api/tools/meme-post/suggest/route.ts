import { NextRequest, NextResponse } from 'next/server'
import { chatJSON } from '@/lib/llm-json'
import { fetchTemplates, type Template } from '@/lib/imgflip'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 空白模板的建議：AI 挑格式並把每一格的中文字寫好，人再自己合成
export type TemplateSuggestion = {
  模板: Template
  分數: number
  理由: string
  文字: string[]
}

// 輸入主題（例：嘲諷 Gemini 很笨）→ 挑經典梗圖格式，並把每一格的中文字寫好。
// 合成交給前端的編輯器做（瀏覽器有系統中文字型，不會變豆腐方塊）。
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { 主題?: string }
    const 主題 = (body.主題 ?? '').trim().slice(0, 200)
    if (!主題) return NextResponse.json({ ok: false, error: '請先輸入主題' }, { status: 400 })

    // 只用 Imgflip 的經典空白格式。memes.tw 的現成梗圖是別人配好字的成品，
    // 改不了字、冷門主題也幾乎抽不到，所以不列入推薦。
    const templates = await fetchTemplates()
    const templateList = templates
      .map((t, i) => `${i}. ${t.name}（${t.box_count} 格）${t.用法 ? `｜用法：${t.用法}` : ''}`)
      .join('\n')

    const raw = await chatJSON(
      `你幫一個台灣的自動化/AI 工程師挑梗圖發 Threads。他會給你一個主題，你要從經典梗圖格式裡挑出最適合的，並且把每一格的字寫好。

清單上是空白的經典梗圖格式（字還沒寫）。挑 6–8 個最適合這個主題的，幫他把每一格的字寫好。給多一點選擇，格式盡量分散、不要都同一類。

有附「用法」的格式，寫字之前先看懂它，每一格要照用法放對應的東西。用法說「1 跟 3 要講同一句話」就真的要一樣，說「合起來要是通順的一句話」就真的要接得起來。沒照用法寫，那張圖就廢了。
沒附用法的格式也可以選，但只有在你很確定那個梗實際上怎麼用的時候才選；不確定就挑有附用法的。

- 每一格的字用繁體中文，短、口語、有哏，一格最多 15 字
- 文字陣列的長度要剛好等於那個模板的格數，每一格都要有字，不要留空
- 寫的是「要印在圖上的台詞」，不是在描述畫面。像「驚訝皮卡丘臉」「他一臉無奈」這種是描述，不合格；那一格該寫的是那個表情底下會配的話
- 產品和公司名稱拼對：Gemini、Claude、ChatGPT、OpenAI、n8n。拼錯就整張作廢
- 光把主題複述一遍不算哏。要有轉折、有落差、或有自嘲，讀的人會笑出來才算
- 這是他的專業帳號，寫得聰明帶點自嘲，不要低級、不要人身攻擊、不要政治
- 格式要真的對位：講「期待落空」用期待vs現實類、講「二選一的兩難」用 Two Buttons、講「捨棄舊的選新的」用 Drake、講「三個東西比較而其中一個很爛」用 Three-headed Dragon

評分 0-10：格式跟主題的結構真的對上、字寫得有哏的給高分；格式硬套或字只是複述主題的給低分。
理由要具體講「這個格式的什麼結構搭得上這個主題」，不要寫「很適合」「很有趣」這種空話。

只回 JSON：
{"模板":[{"編號":數字,"分數":0到10,"理由":"一句話","文字":["第一格","第二格"]}]}
最多 8 個，照分數高到低。全部用繁體中文。`,
      `主題：${主題}\n\n【空白模板清單】\n${templateList}`,
      2500
    )

    let pickedTemplates: { 編號: number; 分數: number; 理由: string; 文字: string[] }[] = []
    try {
      pickedTemplates = (JSON.parse(raw) as { 模板?: typeof pickedTemplates }).模板 ?? []
    } catch {
      throw new Error('AI 推薦回傳格式錯誤')
    }

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
      templateSuggestions,
      掃描: { 模板: templates.length },
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
