// LINE Messaging API 推播（推給自己）。
// LINE Notify 已在 2025-03-31 停止服務，只能走 Messaging API：要一個 LINE 官方帳號＋Messaging API channel。
//   LINE_CHANNEL_ACCESS_TOKEN：LINE Developers → 你的 channel → Messaging API 分頁 → Channel access token (long-lived)
//   LINE_USER_ID：同一個 channel 的 Basic settings 分頁最下面「Your user ID」（U 開頭 33 字），而且要先加這個官方帳號好友
// 免費方案每月 200 則。計算單位是「一次 push × 收件人數」，一次最多塞 5 個訊息泡泡也只算 1 則，所以要合併送。
const PUSH_URL = 'https://api.line.me/v2/bot/message/push'

export type LineMessage = { type: 'text'; text: string }

// 另一條路：推到使用者自己的 n8n workflow（Webhook 觸發），由 n8n 轉發到 LINE。
// 設了 NEWS_PUSH_WEBHOOK_URL 就走這條，不用自己申請 LINE 官方帳號。
// 送出去的 JSON：{ "messages": [{ "type": "text", "text": "…" }], "text": "全部訊息用空行接起來" }
// n8n 那邊要單則就讀 messages，要一整段就讀 text。
export function lineConfigured(): boolean {
  return !!(process.env.NEWS_PUSH_WEBHOOK_URL || (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_USER_ID))
}

async function pushWebhook(url: string, messages: LineMessage[]): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, text: messages.map((m) => m.text).join('\n\n———\n\n') }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`推到 n8n 失敗（${res.status}）：${(await res.text()).slice(0, 240)}`)
}

export async function pushLine(messages: LineMessage[]): Promise<void> {
  const hook = process.env.NEWS_PUSH_WEBHOOK_URL
  if (hook) return pushWebhook(hook, messages)
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  const to = process.env.LINE_USER_ID
  if (!token || !to) throw new Error('缺少 NEWS_PUSH_WEBHOOK_URL，或 LINE_CHANNEL_ACCESS_TOKEN＋LINE_USER_ID')
  // 一次最多 5 個泡泡；單一文字泡泡上限 5000 字
  for (let i = 0; i < messages.length; i += 5) {
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, messages: messages.slice(i, i + 5).map((m) => ({ ...m, text: m.text.slice(0, 5000) })) }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`LINE 推播失敗（${res.status}）：${(await res.text()).slice(0, 240)}`)
  }
}
