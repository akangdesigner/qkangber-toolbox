// 思念機器人 — LINE 匯出 .txt 解析器（v0）
//
// 用法：
//   node scripts/memory-bot/parse-line.mjs "C:/path/[LINE]張.txt" > data/memory-bot/parsed.json
//   node scripts/memory-bot/parse-line.mjs "<txt>" --stats   # 只看統計、不輸出 JSON
//
// 把 LINE 匯出的純文字解析成結構化訊息陣列。
// 已對齊的真實格式（見 [LINE]張.txt）：
//   日期標頭：  2025.10.06 星期一
//   訊息：      HH:MM <發話者> <內容>
//   多行訊息：  續行不帶 HH:MM，接回上一則
//   收回訊息：  HH:MM 張已收回訊息（無內容）→ type=recalled
//   媒體佔位：  貼圖 / 圖片 / 照片 / 影片 / 檔案 / 語音訊息 / 未接來電 / (emoji) ...

import fs from 'node:fs'

const DATE_RE = /^(\d{4})\.(\d{2})\.(\d{2})\s+星期(.)\s*$/
const TIME_RE = /^(\d{2}:\d{2})\s+(.+)$/
const RECALL_RE = /已收回訊息\s*$/

// 純媒體 / 系統佔位的內容，標記為非文字語料
const MEDIA_EXACT = new Set([
  '貼圖', '圖片', '照片', '影片', '檔案', '語音訊息',
  '未接來電', '已取消通話', '(emoji)',
])

function classify(content) {
  if (RECALL_RE.test(content)) return 'recalled'
  if (MEDIA_EXACT.has(content)) return 'media'
  if (/^\(.+\)$/.test(content)) return 'sticker'        // (laugh)(cheers) 之類英文貼圖說明
  if (/^https?:\/\/\S+$/.test(content)) return 'link'
  if (/^通話時間\s/.test(content)) return 'media'
  return 'text'
}

// 第一階段：找出發話者名單（取「時間後第一個 token」中高頻者）
function detectSpeakers(lines) {
  const tally = new Map()
  for (const raw of lines) {
    const m = raw.match(TIME_RE)
    if (!m) continue
    const first = m[2].split(/\s/)[0]
    tally.set(first, (tally.get(first) || 0) + 1)
  }
  // 高頻者才算發話者（過濾掉「張已收回訊息」這種一次性 token）
  return [...tally.entries()]
    .filter(([, c]) => c > 50)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
}

export function parseLineExport(text) {
  const lines = text.split(/\r?\n/)
  const speakers = detectSpeakers(lines)
  // 由長到短比對，避免短名是長名的前綴時誤判
  const bySpecificity = [...speakers].sort((a, b) => b.length - a.length)

  const messages = []
  let curDate = null
  let last = null

  for (const raw of lines) {
    const d = raw.match(DATE_RE)
    if (d) {
      curDate = `${d[1]}-${d[2]}-${d[3]}`
      last = null
      continue
    }
    const t = raw.match(TIME_RE)
    // 只有「時間後緊接已知發話者」才算新訊息；否則是續行
    //（修掉行程清單 "HH:MM 地點" 被誤判成發話者的雜訊）
    if (t && bySpecificity.some((s) => t[2].startsWith(s))) {
      const time = t[1]
      let rest = t[2]
      let speaker = bySpecificity.find((s) => rest.startsWith(s)) || rest.split(/\s/)[0]
      let content = rest.slice(speaker.length).replace(/^\s+/, '')
      // 收回訊息：HH:MM 張已收回訊息（speaker 後直接黏著「已收回訊息」）
      if (content === '' && RECALL_RE.test(rest)) {
        const s2 = bySpecificity.find((s) => rest.startsWith(s) && rest.length > s.length)
        if (s2) { speaker = s2; content = rest.slice(s2.length) }
      }
      const msg = { date: curDate, time, speaker, content, type: classify(content) }
      messages.push(msg)
      last = msg
      continue
    }
    // 續行：接回上一則（保留換行）
    if (last && raw.trim() !== '') {
      last.content += '\n' + raw
      if (last.type !== 'recalled') last.type = classify(last.content)
    }
  }
  return { speakers, messages }
}

function stats(parsed) {
  const { speakers, messages } = parsed
  const byType = {}
  const bySpeaker = {}
  for (const m of messages) {
    byType[m.type] = (byType[m.type] || 0) + 1
    bySpeaker[m.speaker] = bySpeaker[m.speaker] || {}
    bySpeaker[m.speaker][m.type] = (bySpeaker[m.speaker][m.type] || 0) + 1
  }
  const dates = messages.map((m) => m.date).filter(Boolean)
  return {
    speakers,
    total: messages.length,
    range: [dates[0], dates[dates.length - 1]],
    byType,
    bySpeaker,
  }
}

// CLI
const file = process.argv[2]
if (file) {
  const text = fs.readFileSync(file, 'utf8')
  const parsed = parseLineExport(text)
  if (process.argv.includes('--stats')) {
    console.error(JSON.stringify(stats(parsed), null, 2))
  } else {
    console.error(JSON.stringify(stats(parsed), null, 2)) // 統計走 stderr
    process.stdout.write(JSON.stringify(parsed.messages))  // 資料走 stdout
  }
}
