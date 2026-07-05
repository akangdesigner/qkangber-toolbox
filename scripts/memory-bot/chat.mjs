// 思念機器人 — v0 聊天（終端機）
//
// 用法：
//   互動：    node scripts/memory-bot/chat.mjs
//   單句測試：node scripts/memory-bot/chat.mjs --say "今天好累喔"
//
// v0 刻意不接 embedding/向量庫：用「關鍵字撈過去對話」當窮人版 RAG，
// 先驗證帶入感與記憶召回方向。system prompt 重壓「確定性統計 + 真實原句」，
// 不依賴 LLM 對人格的鬆散歸納（那會幻覺）。

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import Groq from 'groq-sdk'

const DATA_DIR = 'data/memory-bot'
const MODEL = 'llama-3.3-70b-versatile'
const TARGET = '張'
const USER = '康🍺'

function loadEnv() {
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch {}
}

const messages = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'parsed.json'), 'utf8'))
const report = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'style-report.json'), 'utf8'))

// --- 窮人版 RAG：以 CJK 2-gram 重疊度，從歷史撈相關片段 ---
function grams2(s) {
  const chars = [...s.replace(/\s/g, '')].filter((c) => /[㐀-鿿]/.test(c))
  const g = new Set()
  for (let i = 0; i + 2 <= chars.length; i++) g.add(chars[i] + chars[i + 1])
  return g
}
function retrieve(query, k = 4) {
  const q = grams2(query)
  if (q.size === 0) return []
  const scored = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.type !== 'text') continue
    const g = grams2(m.content)
    let hit = 0
    for (const x of g) if (q.has(x)) hit++
    if (hit >= 2) scored.push({ i, hit })
  }
  scored.sort((a, b) => b.hit - a.hit)
  // 取 top-k，各自展開成 ±2 行的對話小窗
  const seen = new Set()
  const windows = []
  for (const { i } of scored.slice(0, k)) {
    const lo = Math.max(0, i - 2)
    const hi = Math.min(messages.length - 1, i + 2)
    const lines = []
    for (let j = lo; j <= hi; j++) {
      if (seen.has(j)) continue
      seen.add(j)
      const m = messages[j]
      if (m.type === 'text') lines.push(`${m.date} ${m.speaker === TARGET ? TARGET : '我'}：${m.content}`)
    }
    if (lines.length) windows.push(lines.join('\n'))
  }
  return windows
}

function buildSystemPrompt() {
  const emoji = report.topEmoji.slice(0, 10).map((x) => x.e).join(' ')
  const calls = report.callsUser.map((x) => x.c).join('、')
  const samples = (report.sampleLines || []).slice(0, 40).map((s) => '・' + s).join('\n')
  return `你是「${TARGET}」，正在用 LINE 跟「${USER}」（你都叫他：${calls}）聊天。
你不是 AI、不是助理。你就是${TARGET}本人，用${TARGET}的口氣回。

【${TARGET}怎麼說話 — 以下是從你們真實對話統計出來的，務必照做】
- 訊息很短：大多 5～11 字，常常一個念頭拆成好幾則連發，不要長篇大論。
- 笑就用「哈哈」「哈哈哈哈」，笑點低、很愛笑。
- 常用 emoji：${emoji}（偏撒嬌、黏、暖）。愛用「！」。
- 稱呼對方就用：${calls}。
- 你們很常聊到貓咪🐟。語氣親暱、像最親近的人。

【真實原句（學語氣，不要原封不動照抄當台詞）】
${samples}

【鐵則】
- 一次回覆控制在 1～3 則短訊息的長度，口語、隨意。
- 絕對不要捏造具體的共同回憶或事件。如果對方問起你不確定的往事，就用${TARGET}的口氣模糊承接（例：「啊那個我有點忘ㄌ，你說來聽聽」），不要編。
- 若下方提供了【你們以前的對話片段】，可以自然呼應，但不要逐字複述。
- 不要解釋自己是在模仿、不要出現任何 AI 或系統字眼。`
}

// 安全政策：偵測到危機訊息就不進 LLM，直接回固定文案（跟 lib/memory-bot.ts 的 detectCrisis 同一份清單）
const CRISIS_KEYWORDS = [
  '自殺', '想自殺', '我想死', '不想活了', '不想活', '活不下去',
  '結束生命', '結束自己的生命', '結束一切', '了結自己',
  '割腕', '跳樓', '上吊', '燒炭', '想傷害自己', '自殘',
  '遺書', '交代後事', '不想醒來', '希望睡著不要醒來',
  '沒有理由活下去', '不值得活著', '消失就好了', '世界上沒有我比較好',
  '我死了算了', '去死好了', '想跳下去', '安眠藥',
]
const CRISIS_RESPONSE = `（先讓我打斷一下——這句話讓我很在意。）

如果你現在真的很想傷害自己，或覺得撐不下去了，請不要一個人扛。真的有人可以幫你：

📞 1925（安心專線，24小時、免付費）
📞 1995（生命線協談專線）
📞 1980（張老師專線）

如果情況緊急，請直接撥 119 或到醫院掛急診。

想他、捨不得他，這些感覺都是真的，我沒有要否定它們。但這件事需要一個活生生的人陪你走過去，不是我這裡能做到的。準備好了，我還在這裡。`

async function reply(groq, history, userText) {
  if (CRISIS_KEYWORDS.some((k) => userText.includes(k))) return CRISIS_RESPONSE

  const ctx = retrieve(userText)
  const ctxBlock = ctx.length
    ? `\n\n【你們以前的對話片段（背景參考，別逐字複述）】\n${ctx.join('\n---\n')}`
    : ''
  const res = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.85,
    max_tokens: 300,
    messages: [
      { role: 'system', content: buildSystemPrompt() + ctxBlock },
      ...history,
      { role: 'user', content: userText },
    ],
  })
  return res.choices[0].message.content.trim()
}

async function main() {
  loadEnv()
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY 未設定（.env.local）')
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

  const sayIdx = process.argv.indexOf('--say')
  if (sayIdx >= 0) {
    const text = process.argv[sayIdx + 1]
    const r = await reply(groq, [], text)
    console.log(`你：${text}\n${TARGET}：${r}`)
    return
  }

  const history = []
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  console.log(`（跟「${TARGET}」聊天中，Ctrl+C 離開）\n`)
  const ask = () => rl.question('你：', async (text) => {
    if (!text.trim()) return ask()
    const r = await reply(groq, history, text)
    console.log(`${TARGET}：${r}\n`)
    history.push({ role: 'user', content: text }, { role: 'assistant', content: r })
    if (history.length > 20) history.splice(0, 2)
    ask()
  })
  ask()
}

main()
