import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { password } = await req.json().catch(() => ({ password: '' }))
  const expected = process.env.TOOLBOX_PASSWORD || ''
  if (!expected || password !== expected) {
    return NextResponse.json({ ok: false, error: '密碼錯誤' }, { status: 401 })
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set('tb_auth', btoa(expected), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return res
}
