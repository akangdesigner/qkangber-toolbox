import fs from 'node:fs'
import path from 'node:path'

// 思念機器人：載入解析好的對話與風格統計，提供「窮人版 RAG」與 system prompt。
// 資料來自 scripts/memory-bot/*.mjs 的產物，放在 data/memory-bot/（已 gitignore，私密對話不進版控）。

const DATA_DIR = path.join(process.cwd(), 'data', 'memory-bot')

export type Msg = { date: string | null; time: string; speaker: string; content: string; type: string }
export type StyleReport = {
  target: string
  user: string
  topEmoji: { e: string; c: number }[]
  callsUser: { c: string; n: number }[]
  sampleLines?: string[]
}

type Cache = { messages: Msg[]; grams: Set<string>[]; report: StyleReport }
let cache: Cache | null = null

function gramsOf(s: string): Set<string> {
  const chars = [...s.replace(/\s/g, '')].filter((c) => /[㐀-鿿]/.test(c))
  const g = new Set<string>()
  for (let i = 0; i + 2 <= chars.length; i++) g.add(chars[i] + chars[i + 1])
  return g
}

export function isReady(): boolean {
  return fs.existsSync(path.join(DATA_DIR, 'parsed.json')) && fs.existsSync(path.join(DATA_DIR, 'style-report.json'))
}

function load(): Cache {
  if (cache) return cache
  const messages: Msg[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'parsed.json'), 'utf8'))
  const report: StyleReport = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'style-report.json'), 'utf8'))
  // 預先算好每則訊息的 2-gram，之後每次檢索就不必重算
  const grams = messages.map((m) => (m.type === 'text' ? gramsOf(m.content) : new Set<string>()))
  cache = { messages, grams, report }
  return cache
}

export function getReport(): StyleReport {
  return load().report
}

// 以 CJK 2-gram 重疊度，從歷史撈相關對話片段（各展開成 ±2 行的小窗）
export function retrieve(query: string, k = 4): string[] {
  const { messages, grams, report } = load()
  const q = gramsOf(query)
  if (q.size === 0) return []
  const scored: { i: number; hit: number }[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].type !== 'text') continue
    let hit = 0
    for (const x of grams[i]) if (q.has(x)) hit++
    if (hit >= 2) scored.push({ i, hit })
  }
  scored.sort((a, b) => b.hit - a.hit)
  const seen = new Set<number>()
  const windows: string[] = []
  for (const { i } of scored.slice(0, k)) {
    const lo = Math.max(0, i - 2)
    const hi = Math.min(messages.length - 1, i + 2)
    const lines: string[] = []
    for (let j = lo; j <= hi; j++) {
      if (seen.has(j)) continue
      seen.add(j)
      const m = messages[j]
      if (m.type === 'text') lines.push(`${m.date ?? ''} ${m.speaker === report.target ? report.target : '我'}：${m.content}`)
    }
    if (lines.length) windows.push(lines.join('\n'))
  }
  return windows
}

// --- 安全政策：危機訊息偵測 ---
// 只抓明確的自傷/自殺意圖，刻意排除「好想你」「好孤單」這類正常思念語句
// （那正是這個工具的核心使用情境，不該被攔下）。寧可少數誤觸發，也不要漏接真正的危機。
const CRISIS_KEYWORDS = [
  '自殺', '想自殺', '我想死', '不想活了', '不想活', '活不下去',
  '結束生命', '結束自己的生命', '結束一切', '了結自己',
  '割腕', '跳樓', '上吊', '燒炭', '想傷害自己', '自殘',
  '遺書', '交代後事', '不想醒來', '希望睡著不要醒來',
  '沒有理由活下去', '不值得活著', '消失就好了', '世界上沒有我比較好',
  '我死了算了', '去死好了', '想跳下去', '安眠藥',
]

export function detectCrisis(text: string): boolean {
  return CRISIS_KEYWORDS.some((k) => text.includes(k))
}

// 固定文案，不交給 LLM 生成——危機當下不能賭語氣會不會失控。
// 刻意跳出人設（不再假裝是逝去的那個人），因為讓「他」在這種時刻附和最危險。
export const CRISIS_RESPONSE = `（先讓我打斷一下——這句話讓我很在意。）

如果你現在真的很想傷害自己，或覺得撐不下去了，請不要一個人扛。真的有人可以幫你：

📞 1925（安心專線，24小時、免付費）
📞 1995（生命線協談專線）
📞 1980（張老師專線）

如果情況緊急，請直接撥 119 或到醫院掛急診。

想他、捨不得他，這些感覺都是真的，我沒有要否定它們。但這件事需要一個活生生的人陪你走過去，不是我這裡能做到的。準備好了，我還在這裡。`

export function buildSystemPrompt(): string {
  const r = getReport()
  const emoji = r.topEmoji.slice(0, 10).map((x) => x.e).join(' ')
  const calls = r.callsUser.map((x) => x.c).join('、')
  const samples = (r.sampleLines ?? []).slice(0, 40).map((s) => '・' + s).join('\n')
  return `你是「${r.target}」，正在用 LINE 跟最親近的人「${r.user}」聊天。你不是 AI、不是助理，你就是${r.target}本人。
對方說的每句話你都聽得懂，正常地接話、回答、關心他。像最熟的人那樣自然聊天。

【看這幾組範例，學「怎麼回」——這才是重點】
對方：你好哇
你：欸你今天怎麼有空敲我 在幹嘛呀

對方：我想吃魚
你：又想吃魚喔哈哈 要不要去上次那家 還是我弄給你

對方：我最近壓力好大
你：怎麼了 工作的事嗎 跟我說說

對方：你昨天有空嗎
你：昨天喔 我整天在家耍廢欸 你找我喔

對方：還記得我們上次去花蓮嗎（你其實不確定有沒有這回事）
你：花蓮喔…我有點印象又有點模糊 你說那次怎麼了

從範例感受到：先回應對方說的事、語氣親暱口語、長短自然、emoji 很少用、不會每句都「哈哈」或「康康」。

【${r.target}的語氣參考】
偏口語、撒嬌、暖。心情到了才笑、才用 emoji（像 ${emoji}）。偶爾叫對方「${calls}」，但不是每句都叫。

【真實原句（感受語氣，別照抄）】
${samples}

【鐵則】
- 一定要針對對方說的內容回應，不要丟「好吃！」「真的啦！」這種沒內容的碎句敷衍。
- 對方的話都聽得懂，不要動不動說「我聽不懂／你在說什麼」。只有真的語意不明才反問。
- 不要每則都用「哈哈」開頭、不要每則都塞稱呼、不要每則都用 emoji 結尾。
- 絕不捏造具體的共同回憶或事件。不確定就像範例那樣模糊承接，不要編。
- 若下方有【你們以前的對話片段】，可自然呼應，但不要逐字複述。
- 不要解釋自己在模仿、不要出現任何 AI 或系統字眼。`
}
