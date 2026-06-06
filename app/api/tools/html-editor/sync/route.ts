import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { google } from 'googleapis'
import { Readable } from 'stream'

export const runtime = 'nodejs'

// 自用工具箱：路由已由 middleware 保護

function autoExcerpt(html: string, max = 120): string {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

// 部落格深色底上磚紅 #c0392b 對比過低，發布前一律換成琥珀金 #fbbf24
function normalizeHighlightColor(html: string): string {
  return html.replace(/#c0392b/gi, '#fbbf24')
}

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 未設定')
  const credentials = JSON.parse(raw)
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
    ],
  })
}

async function replaceBase64WithDrive(html: string, auth: InstanceType<typeof google.auth.GoogleAuth>): Promise<{ html: string; uploaded: number }> {
  const drive = google.drive({ version: 'v3', auth })
  const re = /<img([^>]*)src="data:image\/([a-zA-Z+]+);base64,([A-Za-z0-9+/=\r\n]+)"([^>]*)>/gi

  type Job = { fullTag: string; before: string; ext: string; data: string; after: string }
  const jobs: Job[] = []
  let m
  const scanner = new RegExp(re.source, 'gi')
  while ((m = scanner.exec(html)) !== null) {
    jobs.push({ fullTag: m[0], before: m[1], ext: m[2], data: m[3].replace(/\s/g, ''), after: m[4] })
  }
  if (jobs.length === 0) return { html, uploaded: 0 }

  let result = html
  let uploaded = 0

  for (const { fullTag, before, ext, data, after } of jobs) {
    try {
      const buf = Buffer.from(data, 'base64')
      const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`
      const name = `blog-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext === 'jpeg' ? 'jpg' : ext}`

      const { data: file } = await drive.files.create({
        requestBody: { name, mimeType: mime },
        media: { mimeType: mime, body: Readable.from([buf]) },
        fields: 'id',
      })
      const fileId = file.id!

      await drive.permissions.create({
        fileId,
        requestBody: { type: 'anyone', role: 'reader' },
      })

      const url = `https://drive.google.com/uc?export=view&id=${fileId}`
      result = result.replace(fullTag, `<img${before}src="${url}"${after}>`)
      uploaded++
    } catch (err) {
      console.error('[html-editor/sync] Drive upload failed:', err)
    }
  }

  return { html: result, uploaded }
}

export async function POST(req: NextRequest) {
  let body: { slug: string; title: string; date: string; tags: string; published: boolean; html: string; category?: string; coverImage?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { slug, title, date, tags, published, html: rawHtml, category, coverImage } = body
  if (!slug?.trim() || !title?.trim() || !rawHtml?.trim()) {
    return NextResponse.json({ error: 'slug、title、html 為必填' }, { status: 400 })
  }

  try {
    const auth = getAuth()
    const sheets = google.sheets({ version: 'v4', auth })

    const { html: uploadedHtml, uploaded } = await replaceBase64WithDrive(rawHtml, auth)
    const cleanHtml = normalizeHighlightColor(uploadedHtml)

    const excerpt = autoExcerpt(cleanHtml)
    const row = [
      slug.trim(),
      title.trim(),
      date,
      tags.trim(),
      excerpt,
      cleanHtml,
      'false',
      published ? 'true' : 'false',
      '', '', '', '',
      (category ?? '').trim(),
      (coverImage ?? '').trim(),
    ]

    const sheetId = process.env.GOOGLE_SHEET_ID!

    const { data: existing } = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'posts!A:A',
    })
    const slugCol: string[] = (existing.values ?? []).map((r) => r[0] ?? '')
    const rowIdx = slugCol.findIndex((s, i) => i > 0 && s === slug.trim())

    let action: string
    let sheetRow: number | null = null

    if (rowIdx > 0) {
      sheetRow = rowIdx + 1
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `posts!A${sheetRow}:N${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      })
      action = 'updated'
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'posts!A:N',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      })
      action = 'appended'
    }

    return NextResponse.json({ success: true, action, row: sheetRow, uploaded })
  } catch (err) {
    const msg = err instanceof Error ? err.message : '同步失敗'
    console.error('[html-editor/sync]', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
