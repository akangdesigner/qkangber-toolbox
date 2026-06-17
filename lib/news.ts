import { google } from 'googleapis'

const SHEET_ID = process.env.GOOGLE_SHEET_ID || ''
const TAB = process.env.NEWS_SHEET_NAME || '新聞發文紀錄'

// 這個分頁只記「真的有發出去」的貼文（候選不寫表，留在前端）
// A發文時間 B類型 C標題 D來源 E原文連結 F發文內容 G Threads連結
export type PostedLog = {
  發文時間: string
  類型: string
  標題: string
  來源: string
  原文連結: string
  發文內容: string
  Threads連結: string
}

// 台灣時間（精確到分，含小時）
export function twNow(): string {
  return twTime(new Date())
}
export function twTime(d: Date): string {
  const tw = new Date(d.getTime() + 8 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${tw.getUTCFullYear()}/${p(tw.getUTCMonth() + 1)}/${p(tw.getUTCDate())} ${p(tw.getUTCHours())}:${p(tw.getUTCMinutes())}`
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

// 讀發文紀錄（新到舊）
export async function getPostedLog(): Promise<PostedLog[]> {
  const sheets = getSheets()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!A2:G` })
  const rows = res.data.values ?? []
  return rows
    .map((r) => ({
      發文時間: r[0] ?? '',
      類型: r[1] ?? '',
      標題: r[2] ?? '',
      來源: r[3] ?? '',
      原文連結: r[4] ?? '',
      發文內容: r[5] ?? '',
      Threads連結: r[6] ?? '',
    }))
    .reverse()
}

// 發出去後記一筆
export async function appendPostedLog(e: PostedLog) {
  const sheets = getSheets()
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A:G`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[e.發文時間, e.類型, e.標題, e.來源, e.原文連結, e.發文內容, e.Threads連結]] },
  })
}
