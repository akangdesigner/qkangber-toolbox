'use client'

import { useEffect, useState } from 'react'
import type { StockHealth, MarketOverview } from '@/lib/stock'

type Row = StockHealth | { symbol: string; error: string }
const isErr = (r: Row): r is { symbol: string; error: string } => 'error' in r

const STORE_KEY = 'qk-watchlist'
const PAPER_KEY = 'qk-papertrades'
const BUDGET_KEY = 'qk-paperbudget'
const DEFAULT_BUDGET = 5000 // 模擬持股每檔預設投入金額（用來回推零股股數）
const DEFAULT_LIST = ['2330', '0050', '2412']

type PaperPos = { symbol: string; name: string; entryPrice: number; entryDate: string }

// 台股 AI 概念股快速名單（晶片/設計、AI 伺服器、散熱電源、管理晶片）
const AI_STOCKS = ['2330', '2454', '3661', '3035', '2317', '2382', '3231', '6669', '2376', '3017', '2308', '5274']

const signalStyle: Record<StockHealth['signal'], { dot: string; ring: string; label: string; text: string }> = {
  green: { dot: 'bg-emerald-400', ring: 'border-emerald-500/40', label: '偏多', text: 'text-emerald-300' },
  yellow: { dot: 'bg-amber-400', ring: 'border-amber-500/40', label: '觀望', text: 'text-amber-300' },
  red: { dot: 'bg-rose-400', ring: 'border-rose-500/40', label: '轉弱', text: 'text-rose-300' },
}

// 基本面（體質）紅綠燈樣式
const fundStyle: Record<StockHealth['fundSignal'], { cls: string; label: string }> = {
  green: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', label: '體質佳' },
  yellow: { cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40', label: '體質中性' },
  red: { cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40', label: '體質偏弱' },
  na: { cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30', label: '基本面 N/A' },
}
// 營收年增率上色：成長紅、衰退綠（台股紅漲綠跌慣例）
function yoyColor(v: number | null): string {
  if (v == null) return 'text-slate-200'
  if (v >= 5) return 'text-rose-400'
  if (v <= -5) return 'text-emerald-400'
  return 'text-slate-200'
}
// 法人籌碼方向樣式（買超紅、賣超綠）
const chipStyle: Record<StockHealth['chipSignal'], { cls: string; label: string }> = {
  buy: { cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40', label: '法人買超' },
  sell: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', label: '法人賣超' },
  neutral: { cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30', label: '法人中性' },
  na: { cls: 'bg-slate-500/15 text-slate-500 border-slate-500/20', label: '籌碼 N/A' },
}
// 張數上色：買超紅、賣超綠
function lotColor(v: number | null): string {
  if (v == null) return 'text-slate-200'
  return v > 0 ? 'text-rose-400' : v < 0 ? 'text-emerald-400' : 'text-slate-200'
}
const lots = (v: number | null) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toLocaleString())
// 是否台股盤中（台北時間 週一~五 09:00~13:30）；用 Asia/Taipei 不受使用者時區影響
function isTwTradingNow(): boolean {
  const tpe = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }))
  const day = tpe.getDay() // 0=日 6=六
  const mins = tpe.getHours() * 60 + tpe.getMinutes()
  return day >= 1 && day <= 5 && mins >= 9 * 60 && mins <= 13 * 60 + 30
}
// 總分配色：70+ 強(綠) / 55+ 偏多(琥珀) / 45+ 中性(灰) / 弱(紅)
function scoreColor(v: number): { text: string; ring: string; label: string } {
  if (v >= 70) return { text: 'text-emerald-300', ring: 'border-emerald-500/40 bg-emerald-500/10', label: '整體偏強' }
  if (v >= 55) return { text: 'text-amber-300', ring: 'border-amber-500/40 bg-amber-500/10', label: '中性偏多' }
  if (v >= 45) return { text: 'text-slate-300', ring: 'border-slate-500/30 bg-slate-500/10', label: '中性' }
  return { text: 'text-rose-300', ring: 'border-rose-500/40 bg-rose-500/10', label: '整體偏弱' }
}
// 連買/連賣天數標籤（正=連買紅、負=連賣綠）
function streakTag(n: number, who: string): { txt: string; cls: string } | null {
  if (n >= 2) return { txt: `${who}連買${n}天`, cls: 'text-rose-400' }
  if (n <= -2) return { txt: `${who}連賣${-n}天`, cls: 'text-emerald-400' }
  return null
}

// 買點徽章樣式 + 排序優先序（接近買點排最前）
const entryStyle: Record<StockHealth['entry'], { cls: string; rank: number }> = {
  接近買點: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', rank: 0 },
  強勢偏貴: { cls: 'bg-sky-500/15 text-sky-300 border-sky-500/40', rank: 1 },
  盤整觀望: { cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40', rank: 2 },
  轉弱避開: { cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40', rank: 3 },
}
const entryRank = (r: Row) => (isErr(r) ? 99 : entryStyle[r.entry].rank)

export default function WatchBoard() {
  const [input, setInput] = useState('')
  const [symbols, setSymbols] = useState<string[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false) // 整批重新整理
  const [adding, setAdding] = useState(false) // 加入單檔中
  const [asOf, setAsOf] = useState<string>('')
  const [view, setView] = useState<'watch' | 'scan'>('watch') // watch=我的清單 / scan=選股結果
  const [scanRows, setScanRows] = useState<Row[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanProg, setScanProg] = useState({ done: 0, total: 0 })
  const [scanFilter, setScanFilter] = useState<'buy' | 'all'>('buy')
  const [papers, setPapers] = useState<PaperPos[]>([]) // 模擬持股
  const [paperData, setPaperData] = useState<Row[]>([]) // 模擬持股的最新數據
  const [budget, setBudget] = useState(DEFAULT_BUDGET) // 每檔投入金額（估零股股數用）
  const [market, setMarket] = useState<MarketOverview | null>(null) // 大盤環境
  const [tradingNow, setTradingNow] = useState(false) // 是否台股盤中（client-only，避免 SSR 水合不一致）

  // 首次載入：讀清單並查全部
  useEffect(() => {
    let list = DEFAULT_LIST
    try {
      const saved = localStorage.getItem(STORE_KEY)
      if (saved) list = JSON.parse(saved)
    } catch {}
    setSymbols(list)
    if (list.length) fetchMany(list).then((r) => setRows(r))

    let plist: PaperPos[] = []
    try {
      const ps = localStorage.getItem(PAPER_KEY)
      if (ps) plist = JSON.parse(ps)
    } catch {}
    setPapers(plist)
    if (plist.length) fetchMany(plist.map((p) => p.symbol)).then(setPaperData).catch(() => {})

    try {
      const b = localStorage.getItem(BUDGET_KEY)
      if (b) setBudget(Number(b) || DEFAULT_BUDGET)
    } catch {}

    // 大盤環境（看天氣）
    fetch('/api/market').then((r) => r.json()).then((j) => { if (j.ok) setMarket(j) }).catch(() => {})

    // 盤中提醒：每分鐘更新一次，13:30 一過自動消失
    setTradingNow(isTwTradingNow())
    const t = setInterval(() => setTradingNow(isTwTradingNow()), 60000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 假買：用現價記一筆模擬買進（存本機，不是真下單）
  function paperBuy(s: StockHealth) {
    if (papers.some((p) => p.symbol === s.symbol)) return
    const next = [{ symbol: s.symbol, name: s.name, entryPrice: s.price, entryDate: new Date().toISOString() }, ...papers]
    setPapers(next)
    localStorage.setItem(PAPER_KEY, JSON.stringify(next))
    setPaperData((prev) => [s, ...prev.filter((r) => r.symbol !== s.symbol)])
  }

  function paperSell(symbol: string) {
    const next = papers.filter((p) => p.symbol !== symbol)
    setPapers(next)
    localStorage.setItem(PAPER_KEY, JSON.stringify(next))
  }

  function changeBudget(v: number) {
    const safe = Number.isFinite(v) && v > 0 ? v : DEFAULT_BUDGET
    setBudget(safe)
    localStorage.setItem(BUDGET_KEY, String(safe))
  }

  function persist(list: string[]) {
    setSymbols(list)
    localStorage.setItem(STORE_KEY, JSON.stringify(list))
  }

  async function fetchMany(list: string[]): Promise<Row[]> {
    const res = await fetch('/api/watch?symbols=' + encodeURIComponent(list.join(',')))
    const json = await res.json()
    if (!json.ok) throw new Error(json.error || res.status)
    setAsOf(json.asOf)
    return json.results as Row[]
  }

  // 加入一檔：normalize → 去重 → 只查這一檔並接到最前面
  async function addSymbol(raw: string) {
    const code = raw.trim().toUpperCase()
    if (!code) return
    if (symbols.some((s) => s.toUpperCase() === code)) {
      setInput('')
      return // 已存在，略過
    }
    setInput('')
    setAdding(true)
    try {
      const [row] = await fetchMany([code])
      persist([code, ...symbols])
      setRows((prev) => [row, ...prev])
    } catch (e) {
      alert('加入失敗：' + e)
    }
    setAdding(false)
  }

  function removeSymbol(code: string) {
    persist(symbols.filter((s) => s !== code))
    setRows((prev) => prev.filter((r) => r.symbol !== code))
  }

  async function refreshAll() {
    if (!symbols.length) return
    setLoading(true)
    try {
      setRows(await fetchMany(symbols))
    } catch (e) {
      alert('重新整理失敗：' + e)
    }
    setLoading(false)
  }

  // 一鍵掃描 AI 概念股：走獨立的選股結果檢視，不動你的追蹤清單
  async function scanAI() {
    setView('scan')
    setScanRows([])
    setScanFilter('all')
    setScanning(true)
    setScanProg({ done: 0, total: AI_STOCKS.length })
    try {
      const r = await fetchMany(AI_STOCKS)
      setScanRows(r)
      setScanProg({ done: r.length, total: AI_STOCKS.length })
    } catch (e) {
      alert('掃描失敗：' + e)
    }
    setScanning(false)
  }

  // 清空整個追蹤清單（重置用）
  function clearWatch() {
    if (typeof window !== 'undefined' && !window.confirm('確定清空整個追蹤清單？（模擬持股不受影響）')) return
    persist([])
    setRows([])
  }

  // 選股掃描：抓熱門股池 → 分批(每批12檔)逐步掃 → 結果獨立顯示（不動自選清單）
  async function screenStocks() {
    setScanning(true)
    setView('scan')
    setScanRows([])
    setScanFilter('buy')
    try {
      const u = await fetch('/api/universe?n=150').then((r) => r.json())
      if (!u.ok) throw new Error(u.error || '選股池抓取失敗')
      const pool: string[] = u.symbols
      setScanProg({ done: 0, total: pool.length })
      const chunks: string[][] = []
      for (let i = 0; i < pool.length; i += 12) chunks.push(pool.slice(i, i + 12))
      let acc: Row[] = []
      for (const g of chunks) {
        const part = await fetchMany(g)
        acc = [...acc, ...part]
        setScanRows(acc)
        setScanProg({ done: acc.length, total: pool.length })
      }
    } catch (e) {
      alert('選股掃描失敗：' + e)
    }
    setScanning(false)
  }

  // 把掃到的股票加進自選清單（不離開選股結果）
  function addToWatch(code: string) {
    if (symbols.some((s) => s.toUpperCase() === code.toUpperCase())) return
    persist([code, ...symbols])
    const row = scanRows.find((r) => r.symbol === code)
    if (row) setRows((prev) => [row, ...prev.filter((r) => r.symbol !== code)])
  }

  // 依目前檢視決定要顯示哪些卡片
  const inScan = view === 'scan'
  const baseRows = inScan ? scanRows : rows
  const scoreOf = (r: Row) => (isErr(r) ? -1 : r.overallScore)
  const HIGH = 60 // 總分門檻：60 以上才算「可考慮」
  const buyCount = scanRows.filter((r) => !isErr(r) && r.overallScore >= HIGH).length
  const filtered = inScan && scanFilter === 'buy'
    ? baseRows.filter((r) => !isErr(r) && r.overallScore >= HIGH)
    : baseRows
  // 主排序：總分高→低；同分用技術買點當 tiebreak
  const displayRows = [...filtered].sort((a, b) => scoreOf(b) - scoreOf(a) || entryRank(a) - entryRank(b))

  // 找某代號目前的最新數據（模擬持股 → 自選 → 選股結果）
  const currentOf = (sym: string): StockHealth | null => {
    for (const list of [paperData, rows, scanRows]) {
      const r = list.find((x) => x.symbol === sym)
      if (r && !isErr(r)) return r
    }
    return null
  }
  const heldSet = new Set(papers.map((p) => p.symbol))

  return (
    <main className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-white">自選股健檢</h1>
        <a href="/" className="text-sm text-slate-400 hover:text-white">← 回工具箱</a>
      </div>
      <p className="text-sm text-slate-400 mb-4">
        免費盤後日K → 技術面算 均線(5/20/60)、KD、MACD、多空排列；基本面看 月營收年增＋本益比/殖利率 體質燈。技術看時機、基本看體質，兩者都是「參考」，不是買賣建議。
      </p>

      {tradingNow && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/[0.08] px-4 py-2.5 text-xs leading-relaxed text-amber-200">
          ⚠️ 現在是台股盤中（09:00–13:30）：今日 K 棒還沒收，<span className="font-medium">技術指標、買點、總分都未定案，收盤前隨時會變</span>；三大法人籌碼是昨天的。盤中僅供方向參考，要照訊號決策請等盤後。
        </div>
      )}

      {market && <MarketBanner m={market} />}

      {/* 輸入：打一個代號按 Enter 加一檔 */}
      <div className="flex gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addSymbol(input)
          }}
          placeholder="輸入一檔代號後按 Enter，例如 0050"
          className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-white placeholder:text-slate-500 focus:border-violet-400/50 focus:outline-none"
        />
        <button
          onClick={() => addSymbol(input)}
          disabled={adding}
          className="rounded-lg bg-violet-500 px-6 py-2.5 font-medium text-white transition-colors hover:bg-violet-400 disabled:opacity-50"
        >
          {adding ? '加入中…' : '加入'}
        </button>
      </div>

      {/* 快速功能：選股掃描 + AI 概念股 */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={screenStocks}
          disabled={scanning}
          className="rounded-lg bg-emerald-600/90 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {scanning ? `選股掃描中… ${scanProg.done}/${scanProg.total}` : '🔎 選股掃描（大中型熱門股 150 檔）'}
        </button>
        <button
          onClick={scanAI}
          disabled={scanning}
          className="rounded-lg border border-violet-400/40 bg-violet-500/10 px-4 py-2 text-sm text-violet-200 transition-colors hover:bg-violet-500/20 disabled:opacity-50"
        >
          {scanning ? '掃描中…' : '🔍 AI 概念股（12 檔）'}
        </button>
      </div>

      {/* 選股結果列：進度、買點檔數、篩選、回清單 */}
      {inScan && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3">
          <span className="text-sm text-white">
            選股結果：掃 {scanProg.total} 檔（已依總分高→低排序）
            {scanning ? `（進行中 ${scanProg.done}/${scanProg.total}）` : `，總分 ${HIGH}+ 共 ${buyCount} 檔`}
          </span>
          <div className="flex gap-1 text-xs">
            <button onClick={() => setScanFilter('buy')} className={`rounded px-2 py-1 ${scanFilter === 'buy' ? 'bg-emerald-500/20 text-emerald-200' : 'text-slate-400 hover:text-white'}`}>只看總分 {HIGH}+</button>
            <button onClick={() => setScanFilter('all')} className={`rounded px-2 py-1 ${scanFilter === 'all' ? 'bg-emerald-500/20 text-emerald-200' : 'text-slate-400 hover:text-white'}`}>全部</button>
          </div>
          <button onClick={() => setView('watch')} className="ml-auto text-xs text-slate-400 hover:text-white">← 回我的清單</button>
        </div>
      )}

      {/* 我的模擬持股（假買，存本機，不是真下單） */}
      {!inScan && papers.length > 0 && (() => {
        // 以「每檔投入約 budget 元」回推零股股數，算出實際賺賠金額
        const money = (v: number) => '$' + Math.round(Math.abs(v)).toLocaleString()
        const calc = papers.map((p) => {
          const cur = currentOf(p.symbol)
          const curPrice = cur ? cur.price : null
          const shares = Math.max(1, Math.round(budget / p.entryPrice)) // 估算零股股數
          const cost = p.entryPrice * shares
          const value = curPrice != null ? curPrice * shares : null
          const profit = value != null ? value - cost : null
          const pnl = curPrice != null ? ((curPrice - p.entryPrice) / p.entryPrice) * 100 : null
          const days = Math.max(0, Math.floor((Date.now() - new Date(p.entryDate).getTime()) / 86400000))
          return { p, cur, curPrice, shares, cost, value, profit, pnl, days }
        })
        const totalCost = calc.reduce((a, c) => a + c.cost, 0)
        const totalValue = calc.reduce((a, c) => a + (c.value ?? c.cost), 0)
        const totalProfit = totalValue - totalCost
        const totalPct = totalCost ? (totalProfit / totalCost) * 100 : 0
        const totalWin = totalProfit >= 0
        return (
          <section className="mt-5 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <h2 className="text-sm font-medium text-white">📝 我的模擬持股<span className="ml-2 text-xs text-slate-500">假買練習，不是真的下單</span></h2>
              <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-400">
                每檔投入
                <input
                  type="number"
                  value={budget}
                  min={1000}
                  step={1000}
                  onChange={(e) => changeBudget(Number(e.target.value))}
                  className="w-24 rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-right text-white focus:border-amber-400/50 focus:outline-none"
                />
                元（估零股股數）
              </label>
            </div>

            {/* 總計：總成本、總市值、總賺賠 */}
            <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg bg-white/[0.03] px-3 py-2.5">
              <span className="text-xs text-slate-400">總成本 <span className="text-slate-200">${Math.round(totalCost).toLocaleString()}</span></span>
              <span className="text-xs text-slate-400">總市值 <span className="text-slate-200">${Math.round(totalValue).toLocaleString()}</span></span>
              <span className={`ml-auto text-sm font-semibold ${totalWin ? 'text-rose-400' : 'text-emerald-400'}`}>
                {totalWin ? '▲' : '▼'} 總賺賠 {totalWin ? '+' : '−'}{money(totalProfit)}（{totalWin ? '+' : ''}{totalPct.toFixed(1)}%）
              </span>
            </div>

            <div className="space-y-2">
              {calc.map(({ p, cur, curPrice, shares, profit, pnl, days }) => {
                const win = (pnl ?? 0) >= 0
                return (
                  <div key={p.symbol} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white/[0.03] px-3 py-2 text-sm">
                    <span className="font-medium text-white">{p.name}</span>
                    <span className="text-xs text-slate-400">買 {p.entryPrice} × {shares} 股 → 現 {curPrice ?? '—'}</span>
                    {profit != null && (
                      <span className={`font-medium ${win ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {win ? '▲' : '▼'} {win ? '+' : '−'}{money(profit)}
                      </span>
                    )}
                    {pnl != null && (
                      <span className={`text-xs ${win ? 'text-rose-400' : 'text-emerald-400'}`}>
                        {win ? '+' : ''}{pnl.toFixed(1)}%
                      </span>
                    )}
                    <span className="text-xs text-slate-500">持有 {days} 天</span>
                    {cur && !cur.aboveMa60 && <span className="text-xs text-amber-400">⚠ 已跌破季線，考慮出場</span>}
                    {cur && cur.kdCross === '死亡交叉' && <span className="text-xs text-amber-400">⚠ KD 死亡交叉</span>}
                    <button onClick={() => paperSell(p.symbol)} className="ml-auto rounded border border-white/10 px-2 py-0.5 text-xs text-slate-300 hover:border-rose-400/50 hover:text-rose-300">賣出平倉</button>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })()}

      {/* 已選清單（顯示名稱、可單獨移除） */}
      {!inScan && symbols.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {symbols.map((s) => {
            const row = rows.find((r) => r.symbol === s)
            const label = row && !isErr(row) ? `${row.name}` : s
            return (
              <span key={s} className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-sm text-slate-200">
                {label}<span className="text-xs text-slate-500">{s}</span>
                <button onClick={() => removeSymbol(s)} className="text-slate-500 hover:text-rose-400" aria-label={`移除 ${s}`}>
                  ×
                </button>
              </span>
            )
          })}
          <button onClick={refreshAll} disabled={loading} className="ml-1 text-xs text-slate-400 hover:text-white disabled:opacity-50">
            {loading ? '更新中…' : '↻ 全部重新整理'}
          </button>
          <button onClick={clearWatch} className="text-xs text-slate-500 hover:text-rose-400">清空</button>
        </div>
      )}

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {displayRows.map((r) =>
          isErr(r) ? (
            !inScan && (
              <div key={r.symbol} className="rounded-xl border border-rose-500/30 bg-rose-500/[0.04] p-5">
                <div className="flex items-start justify-between">
                  <div className="font-medium text-white">{r.symbol}</div>
                  <button onClick={() => removeSymbol(r.symbol)} className="text-slate-500 hover:text-rose-400" aria-label={`移除 ${r.symbol}`}>×</button>
                </div>
                <div className="text-sm text-rose-300 mt-1">{r.error}</div>
              </div>
            )
          ) : inScan ? (
            <StockCard key={r.symbol} s={r} mode="scan" inWatch={symbols.includes(r.symbol)} onAdd={() => addToWatch(r.symbol)} onPaperBuy={() => paperBuy(r)} isHeld={heldSet.has(r.symbol)} />
          ) : (
            <StockCard key={r.symbol} s={r} mode="watch" onRemove={() => removeSymbol(r.symbol)} onPaperBuy={() => paperBuy(r)} isHeld={heldSet.has(r.symbol)} />
          )
        )}
      </div>

      {inScan && !scanning && displayRows.length === 0 && (
        <p className="mt-8 text-sm text-slate-400">
          這批熱門股裡，目前沒有總分 {HIGH} 以上的標的——這很正常，代表現在大環境或多數個股體質/技術/籌碼沒對齊。可切「全部」看完整清單（仍依總分排序），或改天再掃。
        </p>
      )}

      {asOf && (
        <p className="text-xs text-slate-500 mt-8">
          資料時間 {new Date(asOf).toLocaleString('zh-TW')}（盤後日K，今日訊號依最近收盤計算）
        </p>
      )}
    </main>
  )
}

// 大盤環境列：加權/費半/標普/VIX ＋ 偏多偏空總結（看天氣）
function MarketBanner({ m }: { m: MarketOverview }) {
  const moodCls =
    m.mood === 'bullish' ? 'border-rose-500/40 bg-rose-500/[0.06] text-rose-300'
    : m.mood === 'bearish' ? 'border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-300'
    : 'border-slate-500/30 bg-slate-500/[0.06] text-slate-300'
  // VIX 是「跌=好」，方向色與其他指數相反
  const idxColor = (key: string, pct: number) => {
    const good = key === 'vix' ? pct < 0 : pct > 0
    return good ? 'text-rose-400' : 'text-emerald-400'
  }
  return (
    <div className={`mb-6 rounded-xl border p-4 ${moodCls}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">🌤 大盤環境</span>
        <span className="rounded-md border border-white/20 px-2 py-0.5 text-xs font-medium">{m.moodLabel}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {m.indices.map((i) => (
          <div key={i.key} className="flex items-baseline gap-1.5">
            <span className="text-xs text-slate-400">{i.name}</span>
            <span className="font-medium text-slate-100">{i.price.toLocaleString()}</span>
            <span className={`text-xs ${idxColor(i.key, i.changePct)}`}>
              {i.changePct >= 0 ? '▲' : '▼'}{Math.abs(i.changePct)}%
            </span>
            {i.aboveMa60 != null && (
              <span className={`text-[10px] ${i.aboveMa60 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {i.aboveMa60 ? '站上季線' : '破季線'}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-slate-300">{m.moodText}</p>
    </div>
  )
}

function StockCard({ s, mode, onRemove, onAdd, inWatch, onPaperBuy, isHeld }: { s: StockHealth; mode: 'watch' | 'scan'; onRemove?: () => void; onAdd?: () => void; inWatch?: boolean; onPaperBuy?: () => void; isHeld?: boolean }) {
  const st = signalStyle[s.signal]
  const up = s.changePct >= 0
  return (
    <div className={`rounded-xl border ${st.ring} bg-white/[0.03] p-5`}>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${st.dot} shrink-0`} />
            <span className="font-semibold text-white truncate">{s.name}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500">{s.symbol}・{s.resolved}</div>
        </div>
        <div className="flex items-start gap-3 shrink-0">
          <div className="text-right">
            <div className="text-lg font-semibold text-white">{s.price}</div>
            <div className={`text-sm ${up ? 'text-rose-400' : 'text-emerald-400'}`}>
              {up ? '▲' : '▼'} {Math.abs(s.changePct)}%
            </div>
          </div>
          {mode === 'watch' ? (
            <button onClick={onRemove} className="text-slate-600 hover:text-rose-400 leading-none" aria-label={`移除 ${s.symbol}`}>×</button>
          ) : inWatch ? (
            <span className="text-xs text-emerald-400 whitespace-nowrap">✓ 已加入</span>
          ) : (
            <button onClick={onAdd} className="rounded border border-violet-400/40 px-2 py-0.5 text-xs text-violet-200 hover:bg-violet-500/20 whitespace-nowrap">＋清單</button>
          )}
        </div>
      </div>

      {/* ===== 總分（技術＋基本＋籌碼加權）===== */}
      {(() => {
        const sc = scoreColor(s.overallScore)
        return (
          <div className={`mt-4 rounded-lg border px-3 py-2.5 ${sc.ring}`}>
            <div className="flex items-center gap-3">
              <div className="flex items-baseline gap-1">
                <span className={`text-2xl font-bold ${sc.text}`}>{s.overallScore}</span>
                <span className="text-xs text-slate-500">/100</span>
              </div>
              <span className={`text-sm font-medium ${sc.text}`}>{sc.label}</span>
              <div className="ml-auto flex gap-3 text-[11px] text-slate-400">
                <span>技術 <span className="text-slate-200">{s.techScore}</span></span>
                <span>基本 <span className="text-slate-200">{s.fundScore ?? '—'}</span></span>
                <span>籌碼 <span className="text-slate-200">{s.chipScore ?? '—'}</span></span>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ===== 技術面（看時機）===== */}
      <section className="mt-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300">📈 技術面</span>
          <span className="text-[10px] text-slate-600">看進場時機</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${entryStyle[s.entry].cls}`}>
            {s.entry}
          </span>
          <span className={`inline-flex items-center rounded-md border ${st.ring} px-2.5 py-1 text-xs ${st.text}`}>
            {st.label}・{s.arrange}
          </span>
          <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${chipStyle[s.chipSignal].cls}`} title="領先指標：最近交易日三大法人買賣超">
            {chipStyle[s.chipSignal].label}
          </span>
        </div>

        {/* 籌碼面（領先）：外資/投信最近交易日買賣超（張） */}
        {s.chipSignal !== 'na' && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <span>外資 <span className={lotColor(s.chipForeign)}>{lots(s.chipForeign)}</span> 張</span>
            <span>投信 <span className={lotColor(s.chipTrust)}>{lots(s.chipTrust)}</span> 張</span>
            <span>三大法人 <span className={lotColor(s.chipTotal)}>{lots(s.chipTotal)}</span> 張</span>
            {s.chipDate && <span className="text-slate-600">{s.chipDate}</span>}
            {[streakTag(s.chipTrustStreak, '投信'), streakTag(s.chipForeignStreak, '外資')]
              .filter((x): x is { txt: string; cls: string } => x != null)
              .map((x) => <span key={x.txt} className={`font-medium ${x.cls}`}>{x.txt}</span>)}
          </div>
        )}

        {/* 走勢圖：近約半年 收盤＋月線(20)＋季線(60)，線末直接標名稱 */}
        <MiniChart series={s.series} />
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 rounded-full" style={{ height: 3, background: '#e2e8f0' }} />收盤價</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 rounded-full" style={{ height: 2, background: '#fbbf24' }} />月線(20日)</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 rounded-full" style={{ height: 2, background: '#818cf8' }} />季線(60日)</span>
        </div>

        {/* KD 副圖：K(快)、D(慢) 在 0~100 擺動，80 超買線 / 20 超賣線 */}
        <div className="mt-3 text-[11px] text-slate-500">KD 指標</div>
        <KDChart series={s.series} />
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 rounded-full" style={{ height: 2, background: '#fbbf24' }} />K（快線）</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 rounded-full" style={{ height: 2, background: '#818cf8' }} />D（慢線）</span>
          <span className="text-slate-500">紅 80＝超買・綠 20＝超賣</span>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Item label="季線(60)" value={`${s.ma60}`} hint={s.aboveMa60 ? `站上 +${s.distMa60Pct}%` : `跌破 ${s.distMa60Pct}%`} hintColor={s.aboveMa60 ? 'text-emerald-400' : 'text-rose-400'} />
          <Item label="均線 5/20" value={`${s.ma5} / ${s.ma20}`} />
          <Item
            label="KD"
            value={`${s.k} / ${s.d}`}
            hint={s.kdCross !== '無' ? s.kdCross : s.kdZone !== '中性' ? s.kdZone : undefined}
            hintColor={s.kdCross === '黃金交叉' ? 'text-emerald-400' : s.kdCross === '死亡交叉' ? 'text-rose-400' : 'text-amber-400'}
          />
          <Item label="MACD 柱" value={`${s.macdHist}`} hint={s.macdTrend} hintColor={s.macdHist >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
          <Item
            label="量能"
            value={s.volTag === '—' ? '—' : `${s.volTag}`}
            hint={s.volRatio != null ? `量比 ${s.volRatio}` : undefined}
            hintColor={s.volTag === '爆量' || s.volTag === '量增' ? 'text-rose-400' : s.volTag === '量縮' || s.volTag === '窒息量' ? 'text-emerald-400' : 'text-slate-400'}
          />
        </dl>

        <p className="mt-3 text-sm text-slate-300 leading-relaxed">{s.verdict}</p>
        <p className="mt-1 text-xs text-slate-400 leading-relaxed">📊 {s.volNote}</p>
      </section>

      {/* ===== 基本面（看體質）===== */}
      <section className="mt-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300">🩺 基本面</span>
          <span className="text-[10px] text-slate-600">看公司體質</span>
          <span className={`ml-auto inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${fundStyle[s.fundSignal].cls}`} title="基本面：營收成長＋估值">
            {fundStyle[s.fundSignal].label}{s.fundScore != null && <span className="ml-1 opacity-70">{s.fundScore}</span>}
          </span>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
          <span title={s.revMonth ? `${s.revMonth} 營收` : undefined}>
            營收年增 <span className={yoyColor(s.revYoY)}>{s.revYoY != null ? (s.revYoY >= 0 ? '+' : '') + s.revYoY + '%' : '—'}</span>
            {s.revMonth && <span className="ml-1 text-slate-600">{s.revMonth}</span>}
          </span>
          {s.revMomentum != null && Math.abs(s.revMomentum) >= 3 && (
            <span className={s.revMomentum > 0 ? 'text-rose-400' : 'text-emerald-400'}>
              動能{s.revMomentum > 0 ? '加速' : '轉弱'} {s.revMomentum > 0 ? '+' : ''}{s.revMomentum}pp
            </span>
          )}
          <span>本益比 PE <span className={peColor(s.pe)}>{s.pe ?? '—'}</span></span>
          <span>股價淨值比 <span className="text-slate-200">{s.pb ?? '—'}</span></span>
          <span>殖利率 <span className="text-slate-200">{s.dividendYield != null ? s.dividendYield + '%' : '—'}</span></span>
        </div>

        <p className="mt-2 text-sm text-slate-300 leading-relaxed">{s.fundVerdict}</p>
      </section>

      <button
        onClick={onPaperBuy}
        disabled={isHeld}
        className={`mt-3 w-full rounded-lg border py-2 text-sm transition-colors ${
          isHeld ? 'border-white/10 text-slate-500' : 'border-amber-400/30 text-amber-200 hover:bg-amber-500/10'
        }`}
      >
        {isHeld ? '✓ 模擬持有中' : '📝 假買（記錄模擬買進）'}
      </button>
    </div>
  )
}

// 本益比偏高給點顏色提示：>40 紅、>25 琥珀（粗略門檻，成長股本來就偏高，僅供參考）
function peColor(pe: number | null): string {
  if (pe == null) return 'text-slate-200'
  if (pe > 40) return 'text-rose-400'
  if (pe > 25) return 'text-amber-400'
  return 'text-slate-200'
}

function MiniChart({ series }: { series: StockHealth['series'] }) {
  const W = 320
  const H = 110
  const padL = 4
  const padR = 30 // 右側留白給線末標籤
  const padY = 8
  const nums = (a: (number | null)[]) => a.filter((v): v is number => v != null)
  const all = [...series.close, ...nums(series.ma20), ...nums(series.ma60)]
  if (all.length === 0) return null
  const min = Math.min(...all)
  const max = Math.max(...all)
  const n = series.close.length
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR))
  const y = (v: number) => padY + (1 - (v - min) / (max - min || 1)) * (H - 2 * padY)
  const path = (arr: (number | null)[]) => {
    let d = ''
    let started = false
    arr.forEach((v, i) => {
      if (v == null) return
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `
      started = true
    })
    return d.trim()
  }
  const lastVal = (arr: (number | null)[]) => {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i] as number
    return null
  }
  const lines = [
    { arr: series.ma60, color: '#818cf8', label: '季60' },
    { arr: series.ma20, color: '#fbbf24', label: '月20' },
    { arr: series.close, color: '#e2e8f0', label: '收盤', w: 1.5 },
  ]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full h-28">
      {lines.map((ln) => (
        <path key={ln.label} d={path(ln.arr)} fill="none" stroke={ln.color} strokeWidth={ln.w ?? 1} />
      ))}
      {lines.map((ln) => {
        const v = lastVal(ln.arr)
        if (v == null) return null
        return (
          <text key={'t' + ln.label} x={W - padR + 3} y={y(v)} fill={ln.color} fontSize="8" dominantBaseline="middle">
            {ln.label}
          </text>
        )
      })}
    </svg>
  )
}

function KDChart({ series }: { series: StockHealth['series'] }) {
  const W = 320
  const H = 64
  const padL = 4
  const padR = 22 // 右側留白給 80/20 標籤
  const padY = 6
  const n = series.k.length
  if (!n) return null
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR))
  const y = (v: number) => padY + (1 - v / 100) * (H - 2 * padY) // KD 固定 0~100
  const path = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 w-full h-16">
      <line x1={padL} y1={y(80)} x2={W - padR} y2={y(80)} stroke="#f87171" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.6" />
      <line x1={padL} y1={y(20)} x2={W - padR} y2={y(20)} stroke="#34d399" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.6" />
      <text x={W - padR + 2} y={y(80)} fill="#f87171" fontSize="7" dominantBaseline="middle">80</text>
      <text x={W - padR + 2} y={y(20)} fill="#34d399" fontSize="7" dominantBaseline="middle">20</text>
      <path d={path(series.d)} fill="none" stroke="#818cf8" strokeWidth="1" />
      <path d={path(series.k)} fill="none" stroke="#fbbf24" strokeWidth="1" />
    </svg>
  )
}

function Item({ label, value, hint, hintColor }: { label: string; value: string; hint?: string; hintColor?: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-white">
        {value} {hint && <span className={`text-xs ${hintColor || 'text-slate-400'}`}>{hint}</span>}
      </dd>
    </div>
  )
}
