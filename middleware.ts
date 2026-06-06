import { NextRequest, NextResponse } from 'next/server'

// 自用工具箱：除了登入頁與登入 API，其餘一律要 cookie
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  if (pathname.startsWith('/login') || pathname.startsWith('/api/login')) {
    return NextResponse.next()
  }
  const expected = btoa(process.env.TOOLBOX_PASSWORD || '__unset__')
  const token = req.cookies.get('tb_auth')?.value
  if (token !== expected) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  // 跳過靜態資源
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
