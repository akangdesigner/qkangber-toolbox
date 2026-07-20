import { getGroqClient, GROQ_MODEL } from '@/lib/groq'

// 要 JSON 回應的共用入口：有 OpenRouter 就優先用，否則退 Groq。
//
// 挑梗圖格式這種事對模型的「常識」要求很高——Groq 的 llama-3.3-70b 認得
// Always Has Been 這個名字，卻不知道它是「等等，X 一直都是 Y？／一直都是」
// 的問答結構，寫出來的字用不到梗。OpenRouter 那邊的模型明顯寫得對。
// werewolf 也是同樣的優先順序，這裡沿用。
export async function chatJSON(
  system: string,
  user: string,
  maxTokens: number,
  temperature = 0.7
): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (key) {
    const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini'
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'Q Kangber Meme Post',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    })
    if (!res.ok) {
      throw new Error(`OpenRouter 失敗（${res.status}）：${(await res.text()).slice(0, 240)}`)
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return json.choices?.[0]?.message?.content?.trim() ?? '{}'
  }

  const client = getGroqClient()
  const completion = await client.chat.completions.create({
    model: GROQ_MODEL,
    max_tokens: maxTokens,
    temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  return completion.choices[0]?.message?.content ?? '{}'
}
