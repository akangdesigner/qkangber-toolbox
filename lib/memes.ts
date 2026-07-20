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

export type Meme = {
  id: string
  圖片連結: string
  頁面連結: string
  標題: string
}

// memes.tw 的網頁端（/wtf、詳細頁）現在被 Cloudflare 全面擋掉，curl 帶瀏覽器 header 也是 403，
// 換 Node/Python 客戶端一樣擋，代表擋的是非瀏覽器的連線特徵而不是 header。
// 但官方 RSS（robots.txt 全站允許）沒有防護，而且比爬 HTML 更好用：
// 結構化、附標題（省掉原本每張圖再打一次詳細頁拿標題）。
// 代價是 RSS 只給最新 50 則，?q= / ?page= / ?tag= 都會被忽略——所以沒有搜尋和翻頁。
const RSS_URL = 'https://memes.tw/rss'

const decodeCdata = (s: string) =>
  s
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

export async function fetchMemes(): Promise<Meme[]> {
  const res = await fetch(RSS_URL, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`memes.tw RSS 回應 ${res.status}`)
  const xml = await res.text()

  const memes: Meme[] = []
  const seen = new Set<string>()
  for (const block of xml.split(/<item[\s>]/).slice(1)) {
    const img = block.match(/<image>([^<]+)<\/image>/)?.[1]?.trim() ?? ''
    const link = block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() ?? ''
    const id = link.match(/\/wtf\/(\d+)/)?.[1] ?? ''
    if (!img || !id || seen.has(id)) continue
    const 標題 = decodeCdata(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '')
    // 有些投稿沒寫標題，RSS 就直接放編號（"#581686"）。這種沒有文字線索，配對時只是雜訊。
    if (!標題 || /^#?\d+$/.test(標題)) continue
    seen.add(id)
    memes.push({ id, 圖片連結: img, 頁面連結: link, 標題 })
  }
  if (memes.length === 0) throw new Error('memes.tw RSS 解析不到梗圖')
  return memes
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
