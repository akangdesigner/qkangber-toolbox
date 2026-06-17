import { NextResponse } from 'next/server'
import { fetchNewsCandidates } from '@/lib/news-fetch'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// 只抓候選回前端，不寫表
export async function POST() {
  try {
    const { items, scanned } = await fetchNewsCandidates()
    return NextResponse.json({ ok: true, items, scanned })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
