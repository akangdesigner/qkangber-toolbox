// 單則新聞 → 一種風格的 Threads 草稿。前端點了風格才呼叫，不預先生。
// 走 chatJSON：有 OPENROUTER_API_KEY 就用 OpenRouter（沒有每日上限），否則退回 Groq。
import { chatJSON } from '@/lib/llm-json'

export const STYLES = ['感性', '技術', '討論'] as const
export type Style = (typeof STYLES)[number]

const STYLE_RULE: Record<Style, string> = {
  感性:
    '第一人稱，從一個具體的私人錨點切入（自己的一段經驗、當下的一個感受、曾經的一個想法），再連到這則新聞，最後收一個誠實、不喊口號的體悟，像範例二那種真實的轉折感。',
  技術:
    '挑這則新聞背後的一個技術點或名詞，用白話講給不懂的人聽，講清楚「它在解決什麼問題」而不是堆規格；帶一句自己的判斷（這招高明在哪／哪裡其實沒那麼神）。短而有料，看完真的學到一個概念。',
  討論:
    '拋出一個有立場的看法或一個真實的兩難，引導讀者留言，結尾用一個具體的開放式問句（不要「你怎麼看？」這種空問句，要問得具體）。',
}

// 只講一種風格，不再把三種規則一起送（省下的就是重複的 prompt token）
function systemPrompt(style: Style): string {
  return `你是 Q kangber（n8n 自動化接案 + AI 應用實踐者）本人在發 Threads。我會給你一則科技新聞，請寫一則貼文。

【要寫得像一個有想法的真人在發文，不是新聞小編在交差。三個鐵則】
1. 一定要有具體的錨點：一個明確的角度、一個真實的數字或細節、一段自己的經驗。不要空泛地講「這很重要」「值得關注」。
2. 一定要有自己的立場：敢講真話、敢吐槽、敢承認自己也不確定，不要中立到像維基百科。
3. 白話到底：像在跟朋友講話，術語一律翻成人話。

下面是「語氣」（不是主題）的示範，請學這種真實、有觀點、不做作的口吻，但內容必須扣住我給你的這則新聞：
範例一（條列知識的口吻——直、白話、敢講不討喜的真話）：「29歲的初級大人給社會新鮮人的建議：1. 防曬一定要擦 2. 一定要用牙線 …… 8. 不要神化任何人，之後你會發現大部分的成功人士其實都蠻混蛋的」
範例二（感性的口吻——從一個具體的私人錨點切入，帶出真實的時間轉折與體悟）：「幾年前拜讀張西的書，那時候特別喜歡一句話……以前覺得這行字只適用於無疾而終的人際關係。沒想到多年後，自己在做 AI 的時候，這句話會重新在腦海裡放大……」

共同規則：繁體中文、150 到 400 字、提到 AI 時用「它」、貼文內文不要放任何網址或連結。排版符合 Threads 閱讀習慣：分成 2 到 4 個短段落、段落間空一行；emoji 整篇 0 到 2 個就好，別硬塞。

這次要寫的風格是「${style}」：${STYLE_RULE[style]}

嚴禁：業配腔、AI 腔、做作的比喻、硬湊的排比、為了正能量而正能量的結尾、把新聞重講一遍卻沒有自己的觀點，以及「在這個＿＿的時代」「不禁讓人深思」「值得我們關注」這類空話。

只回 JSON：{"內容":"貼文全文"}`
}

export type DraftInput = {
  標題: string
  來源: string
  類型: string
  摘要: string
  原文連結: string
}

// 400 字的中文貼文約 600 token，抓 800 當上限；max_tokens 也會被計進 Groq 額度，別開太大
const MAX_TOKENS = 800

export async function generateDraft(n: DraftInput, style: Style): Promise<string> {
  const raw = await chatJSON(
    systemPrompt(style),
    `標題:${n.標題}\n來源:${n.來源}\n分類:${n.類型}\n重點:${n.摘要}\n原文連結:${n.原文連結}`,
    MAX_TOKENS,
    0.75 // 比評分高一點，草稿要有個性
  )
  try {
    const r = JSON.parse(raw) as { 內容?: string }
    return String(r.內容 ?? '').trim()
  } catch {
    return ''
  }
}
