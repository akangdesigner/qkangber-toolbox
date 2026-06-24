import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/universe?n=150
// 回傳「成交金額最大的前 N 檔個股」當選股池（大中型熱門股，每天自動更新；排除 ETF/權證）
export async function GET(req: NextRequest) {
  const n = Math.min(Number(req.nextUrl.searchParams.get('n')) || 150, 200)
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error('TWSE ' + res.status)
    const data = (await res.json()) as Array<{ Code: string; Name: string; TradeValue: string }>
    const stocks = data
      .filter((d) => /^[1-9]\d{3}$/.test(d.Code)) // 4 碼且非 0 開頭 = 個股，排除 ETF(00xx)/權證
      .map((d) => ({ code: d.Code, name: (d.Name || '').trim(), value: Number(String(d.TradeValue).replace(/,/g, '')) || 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, n)
    return NextResponse.json({ ok: true, symbols: stocks.map((s) => s.code), total: stocks.length })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
