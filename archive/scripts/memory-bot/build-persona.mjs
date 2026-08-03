// 思念機器人 — 人格萃取（v0）
//
// 用法：
//   node scripts/memory-bot/build-persona.mjs --target 張 --user 康🍺
//
// 讀 data/memory-bot/parsed.json，對「思念對象（target）」的文字訊息做確定性風格分析，
// 抽出代表原句，再交給 Groq 寫一份繁中「人格說明書」。
// 產出：
//   data/memory-bot/style-report.json   ← 確定性統計（給人看 / 給 prompt 用）
//   data/memory-bot/persona.md           ← LLM 寫的人格說明書

import fs from 'node:fs'
import path from 'node:path'
import Groq from 'groq-sdk'

const DATA_DIR = 'data/memory-bot'
const MODEL = 'llama-3.3-70b-versatile'

// --- 簡易讀 .env.local（repo 沒裝 dotenv）---
function loadEnv() {
  try {
    const txt = fs.readFileSync('.env.local', 'utf8')
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  } catch {}
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

// --- 風格分析（確定性，不靠 AI）---
const EMOJI_RE = /\p{Extended_Pictographic}/gu
const BOPOMOFO_RE = /[㄀-ㄯㆠ-ㆿ]/u

function analyze(messages, target, user) {
  const mine = messages.filter((m) => m.speaker === target && m.type === 'text')
  const texts = mine.map((m) => m.content)

  // emoji 頻率
  const emoji = new Map()
  for (const t of texts) for (const e of t.match(EMOJI_RE) || []) emoji.set(e, (emoji.get(e) || 0) + 1)

  // 笑法：連續「哈」的長度分布
  const hahaLens = []
  for (const t of texts) for (const m of t.match(/哈+/g) || []) hahaLens.push(m.length)

  // 注音文比例
  const bopomofo = texts.filter((t) => BOPOMOFO_RE.test(t)).length

  // 句長分布
  const lens = texts.map((t) => [...t].length).sort((a, b) => a - b)
  const pct = (p) => lens[Math.floor(lens.length * p)] || 0

  // 怎麼稱呼 user：抓含 user 去掉 emoji 後核心字的詞
  const userCore = user.replace(EMOJI_RE, '') // 康🍺 -> 康
  const callMap = new Map()
  const callRe = new RegExp(`${userCore}{1,4}`, 'g')
  for (const t of texts) for (const c of t.match(callRe) || []) callMap.set(c, (callMap.get(c) || 0) + 1)

  // 高頻 2~3 字組（粗略口頭禪偵測；去掉純標點/空白）
  const grams = new Map()
  for (const t of texts) {
    const clean = t.replace(/\s/g, '')
    const chars = [...clean].filter((c) => /[㐀-鿿㄀-ㄯ]/.test(c))
    for (let n = 2; n <= 3; n++)
      for (let i = 0; i + n <= chars.length; i++) {
        const g = chars.slice(i, i + n).join('')
        grams.set(g, (grams.get(g) || 0) + 1)
      }
  }

  // 標點 / 語尾習慣
  const tics = {
    '…/...': texts.filter((t) => /…|\.\.\./.test(t)).length,
    '！': texts.filter((t) => /！/.test(t)).length,
    '波浪~': texts.filter((t) => /[~～]/.test(t)).length,
    '問號？': texts.filter((t) => /？/.test(t)).length,
  }

  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)

  return {
    target, user,
    textCount: mine.length,
    lenP: { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), p99: pct(0.99) },
    topEmoji: top(emoji, 15).map(([e, c]) => ({ e, c })),
    haha: {
      count: hahaLens.length,
      avgLen: +(hahaLens.reduce((a, b) => a + b, 0) / (hahaLens.length || 1)).toFixed(1),
      maxLen: Math.max(0, ...hahaLens),
    },
    bopomofoRatio: +(bopomofo / texts.length).toFixed(3),
    callsUser: top(callMap, 8).map(([c, n]) => ({ c, n })),
    topGrams: top(grams, 40).map(([g, c]) => ({ g, c })),
    tics,
  }
}

// 抽代表原句：分層取樣（短反應 / 中等 / 長心情），偏好含 emoji 或稱呼對方者
function sampleLines(messages, target, n = 50) {
  const mine = messages
    .filter((m) => m.speaker === target && m.type === 'text')
    .map((m) => m.content.replace(/\n/g, ' ').trim())
    .filter((t) => t.length >= 4 && t.length <= 60 && !/^https?:/.test(t))
  const uniq = [...new Set(mine)]
  // 簡單分層
  const short = uniq.filter((t) => [...t].length <= 10)
  const mid = uniq.filter((t) => [...t].length > 10 && [...t].length <= 25)
  const long = uniq.filter((t) => [...t].length > 25)
  const pick = (arr, k) => {
    const out = []
    const step = Math.max(1, Math.floor(arr.length / k))
    for (let i = 0; i < arr.length && out.length < k; i += step) out.push(arr[i])
    return out
  }
  return [...pick(short, Math.floor(n * 0.4)), ...pick(mid, Math.floor(n * 0.4)), ...pick(long, Math.floor(n * 0.2))]
}

async function writePersona(report, samples) {
  loadEnv()
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY 未設定（.env.local）')
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

  const sys = `你是一位語言學側寫專家。我會給你「${report.target}」這個人在 LINE 上的說話統計與真實原句。
請寫一份繁體中文「人格說明書」，目的是讓另一個 AI 能精準模仿「${report.target}」對「${report.user}」說話。
只根據資料，不要編造背景故事或關係細節。聚焦在「怎麼說話」：
1. 語氣與個性（從用字、emoji、笑法、注音文判斷）
2. 口頭禪與高頻說法
3. 怎麼稱呼對方
4. 標點 / 語尾 / emoji 使用習慣
5. 訊息節奏（句長、是否連發短句）
6. 三條「模仿守則」（要做 / 不要做）
用條列、精簡、可直接放進 system prompt。不要客套開場白。`

  const user = `【統計】\n${JSON.stringify(report, null, 1)}\n\n【真實原句範例】\n${samples.map((s) => '・' + s).join('\n')}`

  const res = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.4,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
  })
  return res.choices[0].message.content
}

// --- main ---
const target = arg('target', '張')
const user = arg('user', '康🍺')
const messages = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'parsed.json'), 'utf8'))

const report = analyze(messages, target, user)
const samples = sampleLines(messages, target)
report.sampleLines = samples

fs.writeFileSync(path.join(DATA_DIR, 'style-report.json'), JSON.stringify(report, null, 2))
console.error('✓ style-report.json 已寫出')
console.error(JSON.stringify({ ...report, topGrams: report.topGrams.slice(0, 12), sampleLines: `(${samples.length} 條)` }, null, 2))

const md = await writePersona(report, samples)
fs.writeFileSync(path.join(DATA_DIR, 'persona.md'), md)
console.error('\n✓ persona.md 已寫出\n')
console.error(md)
