import { google } from 'googleapis'

const SHEET_ID = process.env.GOOGLE_SHEET_ID || ''
const TAB = process.env.HAIXUN_SHEET_NAME || '海巡候選'

// 欄位順序（與 n8n 海巡 A 寫入一致）
// A日期 B類型 C分數 D作者 E貼文ID F貼文連結 G貼文內容 H AI回覆草稿 I狀態
export type Candidate = {
  rowNumber: number
  日期: string
  類型: string
  分數: string
  作者: string
  貼文ID: string
  貼文連結: string
  貼文內容: string
  AI回覆草稿: string
  狀態: string
}

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

export async function getCandidates(): Promise<Candidate[]> {
  const sheets = getSheets()
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A2:I`,
  })
  const rows = res.data.values ?? []
  return rows.map((r, i) => ({
    rowNumber: i + 2,
    日期: r[0] ?? '',
    類型: r[1] ?? '',
    分數: r[2] ?? '',
    作者: r[3] ?? '',
    貼文ID: r[4] ?? '',
    貼文連結: r[5] ?? '',
    貼文內容: r[6] ?? '',
    AI回覆草稿: r[7] ?? '',
    狀態: r[8] ?? '',
  }))
}

// 更新某列的草稿(H)與狀態(I)
export async function updateCandidate(rowNumber: number, 草稿: string, 狀態: string) {
  const sheets = getSheets()
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!H${rowNumber}:I${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[草稿, 狀態]] },
  })
}
