// 一次性：在 master 試算表建立「新聞候選」分頁＋表頭（用 service account，免手動開）
import { readFileSync } from 'node:fs'
import { google } from 'googleapis'

// 讀 .env.local（KEY=VALUE，只切第一個 =）
const env = {}
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const t = line.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i === -1) continue
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim()
}

const SHEET_ID = env.GOOGLE_SHEET_ID
const TAB = env.NEWS_SHEET_NAME || '新聞發文紀錄'
const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: (sa.private_key || '').replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
})
const sheets = google.sheets({ version: 'v4', auth })

const HEADERS = ['發文時間', '類型', '標題', '來源', '原文連結', '發文內容', 'Threads連結']

const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
const exists = meta.data.sheets.some((s) => s.properties.title === TAB)

if (!exists) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
  })
  console.log(`已建立分頁「${TAB}」`)
} else {
  console.log(`分頁「${TAB}」已存在，只補表頭`)
}

await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID,
  range: `${TAB}!A1:G1`,
  valueInputOption: 'RAW',
  requestBody: { values: [HEADERS] },
})
console.log('表頭已寫入：', HEADERS.join(' | '))
console.log('完成。試算表：', `https://docs.google.com/spreadsheets/d/${SHEET_ID}`)
