import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

// 自選清單伺服器端備份（data/watchlist.json）：前端存 localStorage 時順手 POST 過來，
// scripts/snapshot.ts 的每日排程靠這份知道要記錄哪些股票
const FILE = path.join(process.cwd(), 'data', 'watchlist.json')

export async function GET() {
  try {
    const raw = JSON.parse(await fs.readFile(FILE, 'utf8'))
    return NextResponse.json({ ok: true, symbols: Array.isArray(raw.symbols) ? raw.symbols : [] })
  } catch {
    return NextResponse.json({ ok: true, symbols: [] }) // 還沒同步過
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    const symbols = Array.isArray(body?.symbols)
      ? (body.symbols as unknown[]).map((s) => String(s).trim()).filter(Boolean).slice(0, 30)
      : null
    if (!symbols) return NextResponse.json({ ok: false, error: 'symbols 需為陣列' }, { status: 400 })
    await fs.mkdir(path.dirname(FILE), { recursive: true })
    await fs.writeFile(FILE, JSON.stringify({ symbols, updatedAt: new Date().toISOString() }, null, 1), 'utf8')
    return NextResponse.json({ ok: true, symbols })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
