import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export const runtime = 'nodejs'

// 自用工具箱：路由已由 middleware 保護

type ImageJob = {
  fullTag: string
  before: string
  ext: string
  data: string
  after: string
}

const IMG_RE = /<img([^>]*)src="data:image\/([^;]+);base64,([^"]+)"([^>]*)>/gi

function parseImages(html: string): ImageJob[] {
  const jobs: ImageJob[] = []
  const re = new RegExp(IMG_RE.source, 'gi')
  let m
  while ((m = re.exec(html)) !== null) {
    jobs.push({
      fullTag: m[0],
      before: m[1],
      ext: m[2] === 'jpeg' ? 'jpg' : m[2],
      data: m[3].replace(/\s/g, ''),
      after: m[4],
    })
  }
  return jobs
}

async function uploadToImgbb(data: string, apiKey: string): Promise<string> {
  const body = new URLSearchParams({ key: apiKey, image: data })
  const res = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`imgbb 上傳失敗: ${text}`)
  }
  const json = await res.json()
  if (!json.success) throw new Error(`imgbb 回傳錯誤: ${JSON.stringify(json)}`)
  return json.data.url as string
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.IMGBB_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: '請在環境變數設定 IMGBB_API_KEY' }, { status: 500 })
  }

  let body: { html: string }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const { html } = body
  if (!html?.trim()) return NextResponse.json({ error: 'html 為必填' }, { status: 400 })

  const jobs = parseImages(html)
  if (jobs.length === 0) return NextResponse.json({ html, uploaded: 0 })

  let result = html
  let uploaded = 0
  const errors: string[] = []

  for (const job of jobs) {
    try {
      const url = await uploadToImgbb(job.data, apiKey)
      result = result.replace(job.fullTag, `<img${job.before}src="${url}"${job.after}>`)
      uploaded++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(msg)
      console.error('[upload-images]', msg)
    }
  }

  if (uploaded === 0 && errors.length > 0) {
    return NextResponse.json({ error: errors[0] }, { status: 500 })
  }

  return NextResponse.json({ html: result, uploaded, errors })
}
