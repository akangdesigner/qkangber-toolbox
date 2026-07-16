// 梗圖配文控制台的後端邏輯：
// 1) 抓 memes.tw 的梗圖（熱門/搜尋，公開圖片網址可直接給 Threads 用）
// 2) 讀官網文章清單（master 試算表 posts 分頁）
// 3) 輕量抓當日新聞標題（只要標題+連結，不叫 AI，跟新聞控制台的重抓取不同）
import { google } from 'googleapis'

const SHEET_ID = process.env.GOOGLE_SHEET_ID || ''
const POSTS_TAB = process.env.POSTS_SHEET_NAME || 'posts'
const BLOG_BASE = 'https://aiqkangber.com/blog'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

// memes.tw 的 Cloudflare 會擋 Node fetch 的 TLS 指紋，但 curl 帶瀏覽器 header 過得了。
// 這個工具箱在本機跑，Windows 內建 curl.exe，直接用它抓 HTML。
async function fetchHtmlViaCurl(url: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      [
        '-s', '--max-time', '15', '--compressed',
        '-H', `User-Agent: ${UA}`,
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '-H', 'Accept-Language: zh-TW,zh;q=0.9',
        url,
      ],
      { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) reject(new Error('curl 抓取失敗：' + err.message))
        else if (!stdout || stdout.length < 500) reject(new Error('memes.tw 回傳空頁（可能被擋）'))
        else resolve(stdout)
      }
    )
  })
}

export type Meme = {
  id: string
  圖片連結: string
  頁面連結: string
  作者: string
}

// memes.tw 列表頁（q 留空＝熱門）。頁面是 server render，直接 parse HTML。
export async function fetchMemes(q = '', page = 1): Promise<Meme[]> {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (page > 1) params.set('page', String(page))
  const qs = params.toString()
  const html = await fetchHtmlViaCurl(`https://memes.tw/wtf${qs ? '?' + qs : ''}`)

  // 每張卡：<div ... data-id="581624"> <a href="/wtf/581624"> <img ... data-src="https://memeprod...">
  const memes: Meme[] = []
  const seen = new Set<string>()
  const cardRe = /data-id="(\d+)"[\s\S]{0,600}?data-src="(https:\/\/memeprod[^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = cardRe.exec(html))) {
    const [, id, img] = m
    if (seen.has(id)) continue
    seen.add(id)
    // 作者在卡片後面一點：<a href="/wtf/user/xxx">名字</a>
    const after = html.slice(m.index, m.index + 2000)
    const author = after.match(/\/wtf\/user\/\d+">([^<]+)<\/a>/)?.[1] ?? ''
    memes.push({ id, 圖片連結: img, 頁面連結: `https://memes.tw/wtf/${id}`, 作者: author.trim() })
  }
  return memes
}

// 梗圖詳細頁的標題（配對時當輔助線索；抓不到就算了）
export async function fetchMemeTitle(id: string): Promise<string> {
  try {
    const html = await fetchHtmlViaCurl(`https://memes.tw/wtf/${id}`)
    const t = html.match(/<title>([^<|]+)/)?.[1] ?? ''
    return t.trim()
  } catch {
    return ''
  }
}

// ---- 官網文章（posts 分頁：slug title date tags excerpt content featured published）----

export type BlogPost = {
  slug: string
  標題: string
  日期: string
  tags: string
  摘要: string
  連結: string
}

function getSheets() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('缺少 GOOGLE_SERVICE_ACCOUNT_JSON')
  const sa = JSON.parse(raw)
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: (sa.private_key || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
  return google.sheets({ version: 'v4', auth })
}

export async function getBlogPosts(): Promise<BlogPost[]> {
  const sheets = getSheets()
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${POSTS_TAB}!A2:H` })
  const rows = res.data.values ?? []
  return rows
    .filter((r) => String(r[7] ?? '').toUpperCase() === 'TRUE') // published
    .map((r) => ({
      slug: r[0] ?? '',
      標題: r[1] ?? '',
      日期: r[2] ?? '',
      tags: r[3] ?? '',
      摘要: r[4] ?? '',
      連結: `${BLOG_BASE}/${r[0] ?? ''}`,
    }))
    .filter((p) => p.slug && p.標題)
}

// ---- 輕量新聞標題（只抓乾淨連結的 RSS，不還原 Google News、不叫 AI）----

export type NewsHeadline = {
  標題: string
  連結: string
  來源: string
  摘要: string
}

const LIGHT_FEEDS = [
  { name: 'iThome', url: 'https://www.ithome.com.tw/rss' },
  { name: 'TechNews 科技新報', url: 'https://technews.tw/feed/' },
  { name: '科技報橘', url: 'https://buzzorange.com/techorange/feed/' },
  { name: 'INSIDE', url: 'https://www.inside.com.tw/feed' },
]

const strip = (s: string) =>
  (s || '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

export async function fetchNewsHeadlines(): Promise<NewsHeadline[]> {
  const MAX_AGE_MS = 2 * 24 * 3600 * 1000
  const results = await Promise.allSettled(
    LIGHT_FEEDS.map(async (f) => {
      const res = await fetch(f.url, {
        headers: { 'User-Agent': UA },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return []
      const xml = await res.text()
      const items = xml.split(/<item[\s>]/).slice(1, 9)
      const out: NewsHeadline[] = []
      for (const it of items) {
        const title = strip(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
        const link = strip(it.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '')
        const desc = strip(it.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '').slice(0, 120)
        const pub = it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? ''
        if (!title || !link) continue
        if (pub && Date.now() - new Date(pub).getTime() > MAX_AGE_MS) continue
        out.push({ 標題: title, 連結: link, 來源: f.name, 摘要: desc })
      }
      return out
    })
  )
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
}
