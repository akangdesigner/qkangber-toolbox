import { NextResponse } from 'next/server'
import { fetchNewsCandidates, RateLimitError } from '@/lib/news-fetch'

export const dynamic = 'force-dynamic'
// 註：這裡不設 maxDuration——那是 Vercel serverless 的設定，本專案部在 Zeabur 容器上無效，
// 留著只會讓人誤以為有 2 分鐘的保護。真正的防呆是 lib/news-fetch 裡的 fetch timeout。

// 只抓候選回前端，不寫表
export async function POST() {
  try {
    const { items, scanned } = await fetchNewsCandidates()
    return NextResponse.json({ ok: true, items, scanned })
  } catch (e) {
    // 額度用完是可預期的狀況，給前端看得懂的話，不要吐一整包 Groq 的原始 JSON
    if (e instanceof RateLimitError) {
      return NextResponse.json({ ok: false, error: e.message, rateLimited: true }, { status: 429 })
    }
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
