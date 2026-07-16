import { google } from 'googleapis'

const SHEET_ID = process.env.GOOGLE_SHEET_ID || ''
const TAB = '點子庫'

// n8n「點子雷達」每天寫入的時事點子
// A日期 B類別 C新聞標題 D來源 E新聞連結 F工具分數 G工具點子 H資料集 I使用者輸入 J商機分數 K商機點子 L重複 M狀態
export type RadarIdea = {
  row: number
  日期: string
  類別: string
  新聞標題: string
  來源: string
  新聞連結: string
  工具分數: number
  工具點子: string
  資料集: string
  使用者輸入: string
  商機分數: number
  商機點子: string
  重複: string
  狀態: string
}

export const IDEA_STATUSES = ['未讀', '要做', '放生'] as const

function getSheets() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('缺少 GOOGLE_SERVICE_ACCOUNT_JSON')
  const sa = JSON.parse(raw)
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: (sa.private_key || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

// 讀點子庫（新到舊）
export async function getIdeas(): Promise<RadarIdea[]> {
  const sheets = getSheets()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A2:M` })
  const rows = res.data.values ?? []
  return rows
    .map((r, i) => ({
      row: i + 2,
      日期: r[0] ?? '',
      類別: r[1] ?? '',
      新聞標題: r[2] ?? '',
      來源: r[3] ?? '',
      新聞連結: r[4] ?? '',
      工具分數: Number(r[5] || 0),
      工具點子: r[6] ?? '',
      資料集: r[7] ?? '',
      使用者輸入: r[8] ?? '',
      商機分數: Number(r[9] || 0),
      商機點子: r[10] ?? '',
      重複: r[11] ?? '',
      狀態: r[12] || '未讀',
    }))
    .filter((r) => r.新聞連結)
    .reverse()
}

// 改狀態：先驗 E 欄連結對得上該列才寫，避免列位移誤改到別列
export async function updateIdeaStatus(row: number, link: string, status: string) {
  const sheets = getSheets()
  const check = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!E${row}` })
  const cur = check.data.values?.[0]?.[0] ?? ''
  if (cur !== link) throw new Error('資料列已位移，請重新整理後再試')
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!M${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] },
  })
}
