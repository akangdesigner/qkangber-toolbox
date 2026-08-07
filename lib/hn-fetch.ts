// Hacker News (Algolia API) 共用抓取邏輯：idea-spark 的 Show HN 分頁和文章靈感分頁都靠這個
// 拿「文章在講什麼」的素材（官網 meta description／作者自己貼的文字），AI 才有東西可以摘要。

export type HNHit = {
  objectID: string
  title: string
  url: string | null
  points: number
  num_comments: number
  created_at: string
  story_text?: string | null // 作者自己在 HN 貼的介紹/內文，官網沒 meta 時靠它
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
const META_FETCH_TIMEOUT = 3500
const MAX_HTML_BYTES = 150_000

// 只翻標題常常看不出文章/產品在講什麼，所以去抓連結的 meta description 當作 AI 寫說明的素材。
// 抓失敗或抓不到就回空字串，AI 會退回只憑標題推測（或直接判「材料不足」）。
export async function fetchMetaDescription(url: string): Promise<string> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), META_FETCH_TIMEOUT)
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': UA }, redirect: 'follow' })
    clearTimeout(timer)
    if (!res.ok || !res.body) return ''

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let html = ''
    let bytes = 0
    while (bytes < MAX_HTML_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      html += decoder.decode(value, { stream: true })
      if (/<\/head>/i.test(html)) break
    }
    reader.cancel().catch(() => {})

    const match =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)
    if (!match) return ''
    const text = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // GitHub 的罐頭描述，留著只會讓 AI 以為內容在講 GitHub
      .replace(/Contribute to [\w.-]+\/[\w.-]+ development by creating an account on GitHub\.?/gi, '')
      .replace(/\s*-\s*[\w.-]+\/[\w.-]+$/, '')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length < 15 ? '' : text.slice(0, 300)
  } catch {
    return ''
  }
}

// 作者在 HN 貼文裡自己寫的文字（Show HN 的自我介紹，或 Ask HN／文字貼文的內文）。
// 官網常常沒有 meta description（個人部落格、GitHub Pages），這段是補位來源。
export function cleanStoryText(raw: string | null | undefined): string {
  if (!raw) return ''
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // 開頭的招呼語（Hi HN!／Hello HN,／Hey there!）對理解內容沒幫助
    .replace(/^\s*(hi|hey|hello|greetings)[\s,!]*(hn|there|all|everyone|folks)?[\s,!—-]*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length < 15 ? '' : text.slice(0, 400)
}
