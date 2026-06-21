import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// 把來源／標題清成安全檔名片段
function safe(s: string): string {
  return (
    (s || '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 40)
      .trim() || 'news'
  )
}

function extFromUrl(url: string, contentType: string): string {
  const fromType = (contentType.split('/')[1] || '').split(';')[0].replace('jpeg', 'jpg')
  if (fromType && /^(jpg|png|gif|webp|avif|bmp)$/i.test(fromType)) return fromType.toLowerCase()
  const m = url.split('?')[0].match(/\.(jpe?g|png|gif|webp|avif|bmp)$/i)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

// 代抓圖片回傳給瀏覽器下載（避開新聞圖跨網域 CORS 擋下載）
export async function POST(req: NextRequest) {
  try {
    const { 圖片連結 = '', 來源 = '', 標題 = '' } = (await req.json()) as {
      圖片連結?: string
      來源?: string
      標題?: string
    }
    if (!圖片連結) return NextResponse.json({ ok: false, error: '這則沒有圖片連結' }, { status: 400 })

    const res = await fetch(圖片連結)
    if (!res.ok) return NextResponse.json({ ok: false, error: `下載失敗 ${res.status}` }, { status: 502 })
    const buf = Buffer.from(await res.arrayBuffer())
    const contentType = res.headers.get('content-type') || 'image/jpeg'

    // 台灣時間時間戳，格式 YYYYMMDD_HHMM
    const tw = new Date(Date.now() + 8 * 3600 * 1000)
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${tw.getUTCFullYear()}${p(tw.getUTCMonth() + 1)}${p(tw.getUTCDate())}_${p(tw.getUTCHours())}${p(tw.getUTCMinutes())}`
    const ext = extFromUrl(圖片連結, contentType)
    const filename = `${safe(來源)}_${safe(標題)}_${stamp}.${ext}`

    return new NextResponse(buf, {
      headers: {
        'Content-Type': contentType.split(';')[0],
        // 檔名含中文，用 RFC 5987 編碼放在前端讀
        'X-Filename': encodeURIComponent(filename),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
