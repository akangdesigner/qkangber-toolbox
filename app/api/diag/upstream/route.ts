import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// GET /api/diag/upstream
// 逐一探測所有外部資料來源，回報真實 HTTP 狀態碼與延遲。
// 存在的理由：抓取失敗在上層一律被翻成「查無此代號」，狀態碼被吃掉，
// 線上壞掉時完全看不出是「代號錯」還是「整個 host 被擋」。有這支就一眼分辨。
type Probe = { name: string; url: string; expect: string } // expect：回應內容裡該出現的字串，用來確認不是被導到錯誤頁
const PROBES: Probe[] = [
  { name: 'twse-openapi-bulk', url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', expect: 'Code' },
  { name: 'twse-www-stockday', url: 'https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=20260701&stockNo=2330&response=json', expect: '"stat":"OK"' },
  { name: 'twse-www-taiex', url: 'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=20260701&response=json', expect: '"stat":"OK"' },
  { name: 'tpex-openapi-bulk', url: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', expect: 'SecuritiesCompanyCode' },
  { name: 'tpex-www-history', url: 'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=6488&date=2026/07/01&id=&response=json', expect: '個股日成交資訊' },
  { name: 'yahoo-chart', url: 'https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?range=1mo&interval=1d', expect: 'chart' },
]

async function probe(p: Probe) {
  const t0 = Date.now()
  try {
    const res = await fetch(p.url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.text()
    return {
      name: p.name,
      status: res.status,
      ms: Date.now() - t0,
      bytes: body.length,
      matched: body.includes(p.expect), // 200 但內容不對 = 被導到攔截頁/空殼
      sample: body.slice(0, 160),
    }
  } catch (e) {
    return { name: p.name, status: 0, ms: Date.now() - t0, error: String(e) } // status 0 = 連不上（DNS/TLS/timeout）
  }
}

export async function GET() {
  const results = await Promise.all(PROBES.map(probe))
  return NextResponse.json({ ok: true, at: new Date().toISOString(), results })
}
