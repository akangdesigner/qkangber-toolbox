'use client'

import { useEffect, useState } from 'react'
import type { StockHealth, MarketOverview } from '@/lib/stock'

type Row = StockHealth | { symbol: string; error: string }
const isErr = (r: Row): r is { symbol: string; error: string } => 'error' in r

const STORE_KEY = 'qk-watchlist'
const PAPER_KEY = 'qk-papertrades'
const BUDGET_KEY = 'qk-paperbudget'
const CAPITAL_KEY = 'qk-capital'
const DEFAULT_BUDGET = 5000 // 模擬持股每檔預設投入金額（用來回推零股股數）
const DEFAULT_CAPITAL = 100000 // 總資金：算「2% 風險部位上限」用
const DEFAULT_LIST = ['2330', '0050', '2412']

type PaperPos = { symbol: string; name: string; entryPrice: number; entryDate: string; stopPrice?: number } // stopPrice：買進當下記的停損價（舊資料沒有此欄）

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

// 波動度徽章：風險越高越紅（低波=平靜藍、高波=危險紅），讓使用者一眼看出「會跳多大」
const volStyle: Record<StockHealth['volLabel'], { cls: string; hint: string }> = {
  低波: { cls: 'bg-sky-500/15 text-sky-300 border-sky-500/40', hint: '溫和、適合長抱' },
  中波: { cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40', hint: '中等起伏' },
  高波: { cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40', hint: '跳很大、易被洗' },
}

// 買點徽章樣式 + 排序優先序（接近買點排最前）
const entryStyle: Record<StockHealth['entry'], { cls: string; rank: number }> = {
  帶量突破: { cls: 'bg-fuchsia-500/20 text-fuchsia-200 border-fuchsia-500/50', rank: 0 },
  接近買點: { cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', rank: 1 },
  強勢偏貴: { cls: 'bg-sky-500/15 text-sky-300 border-sky-500/40', rank: 2 },
  盤整觀望: { cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40', rank: 3 },
  轉弱避開: { cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40', rank: 4 },
}
const entryRank = (r: Row) => (isErr(r) ? 99 : entryStyle[r.entry].rank)

// 選股篩選的中分類 key（多選，AND 邏輯）
type FilterKey = 'buy' | 'near' | 'breakout' | 'gold' | 'fund' | 'trust' | 'foreign' | 'bothbuy' | 'vol'

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
  const [scanSort, setScanSort] = useState<'score' | 'gain'>('score') // 選股結果排序：總分 / 本日漲幅
  const [filters, setFilters] = useState<Set<FilterKey>>(new Set(['buy'])) // 多選：交集(AND)；空集合＝全部
  const toggleFilter = (k: FilterKey) => setFilters((prev) => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k); else next.add(k)
    return next
  })
  const [papers, setPapers] = useState<PaperPos[]>([]) // 模擬持股
  const [paperData, setPaperData] = useState<Row[]>([]) // 模擬持股的最新數據
  const [budget, setBudget] = useState(DEFAULT_BUDGET) // 每檔投入金額（估零股股數用）
  const [capital, setCapital] = useState(DEFAULT_CAPITAL) // 總資金（2% 風險部位建議用）
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
    syncList(list) // 開頁就同步一次清單到伺服器端，讓每日排程快照知道要記錄哪些股票
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
      const c = localStorage.getItem(CAPITAL_KEY)
      if (c) setCapital(Number(c) || DEFAULT_CAPITAL)
    } catch {}

    // 大盤環境（看天氣）
    fetch('/api/market').then((r) => r.json()).then((j) => { if (j.ok) setMarket(j) }).catch(() => {})

    // 盤中提醒：每分鐘更新一次，13:30 一過自動消失
    setTradingNow(isTwTradingNow())
    const t = setInterval(() => setTradingNow(isTwTradingNow()), 60000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 假買：用現價記一筆模擬買進（存本機，不是真下單）。停損價一起記下——買進當下就定好出場，才是紀律
  function paperBuy(s: StockHealth) {
    if (papers.some((p) => p.symbol === s.symbol)) return
    const next = [{ symbol: s.symbol, name: s.name, entryPrice: s.price, entryDate: new Date().toISOString(), stopPrice: s.stopPrice }, ...papers]
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

  function changeCapital(v: number) {
    const safe = Number.isFinite(v) && v > 0 ? v : DEFAULT_CAPITAL
    setCapital(safe)
    localStorage.setItem(CAPITAL_KEY, String(safe))
  }

  function persist(list: string[]) {
    setSymbols(list)
    localStorage.setItem(STORE_KEY, JSON.stringify(list))
    syncList(list)
  }

  // 清單備份到伺服器端 data/watchlist.json（fire-and-forget）——scripts/snapshot.ts 每日排程靠它
  function syncList(list: string[]) {
    fetch('/api/watch/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols: list }) }).catch(() => {})
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
    setFilters(new Set())
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
    setFilters(new Set(['buy']))
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

  // 一鍵把目前畫面上（已套用篩選）的股票整批加進追蹤清單
  function addManyToWatch(codes: string[]) {
    const toAdd = codes.filter((c) => !symbols.some((s) => s.toUpperCase() === c.toUpperCase()))
    if (!toAdd.length) return
    persist([...toAdd, ...symbols])
    const newRows = scanRows.filter((r) => toAdd.includes(r.symbol) && !isErr(r))
    setRows((prev) => [...newRows, ...prev.filter((r) => !toAdd.includes(r.symbol))])
  }

  // 依目前檢視決定要顯示哪些卡片
  const inScan = view === 'scan'
  const baseRows = inScan ? scanRows : rows
  const scoreOf = (r: Row) => (isErr(r) ? -1 : r.overallScore)
  const HIGH = 60 // 總分門檻：60 以上才算「可考慮」
  // 選股快捷篩選的判定（對齊四大領先指標）：總分 / 投信連買 / 帶量突破 / 法人同買
  // 連買的最低買超張數門檻：濾掉「連買2天但只買幾張」的零頭雜訊。
  // 外資部位天生比投信大，門檻拉高才有意義。
  const TRUST_MIN_LOTS = 50
  const FOREIGN_MIN_LOTS = 200
  const filterPred: Record<FilterKey, (s: StockHealth) => boolean> = {
    buy: (s) => s.overallScore >= HIGH,
    near: (s) => s.entry === '接近買點',
    breakout: (s) => s.entry === '帶量突破',
    gold: (s) => s.kdCross === '黃金交叉' && s.arrange !== '空頭排列', // 只看「健康趨勢裡的金叉」，擋掉下跌股騙線
    fund: (s) => s.fundSignal === 'green',
    trust: (s) => s.chipTrustStreak >= 2 && (s.chipTrust ?? 0) >= TRUST_MIN_LOTS,
    foreign: (s) => s.chipForeignStreak >= 2 && (s.chipForeign ?? 0) >= FOREIGN_MIN_LOTS,
    bothbuy: (s) => s.chipBothBuy,
    vol: (s) => s.volLabel !== '低波', // 中高波：濾掉不會動的低波，找波段標的
  }
  const FILTER_LABELS: Record<FilterKey, string> = {
    buy: `總分 ${HIGH}+`, near: '接近買點', breakout: '帶量突破', gold: '黃金交叉',
    fund: '體質佳', trust: '投信連買', foreign: '外資連買', bothbuy: '法人同買', vol: '中高波',
  }
  // 多選交集(AND)下，每顆 chip 顯示「再加它之後還剩幾檔」，幫使用者邊點邊看交叉結果
  const others = (k: FilterKey) => [...filters].filter((x) => x !== k)
  const cnt = (k: FilterKey) => scanRows.filter((r) => !isErr(r) && filterPred[k](r) && others(k).every((x) => filterPred[x](r))).length
  const counts = Object.fromEntries((Object.keys(filterPred) as FilterKey[]).map((k) => [k, cnt(k)])) as Record<FilterKey, number>
  // 篩選器分類：大分類（時機／體質／籌碼／波動）→ 中分類（各別條件）
  const filterGroups: { cat: string; items: { key: FilterKey; label: string }[] }[] = [
    { cat: '時機', items: [{ key: 'near', label: '接近買點' }, { key: 'breakout', label: '帶量突破' }, { key: 'gold', label: '黃金交叉' }] },
    { cat: '體質', items: [{ key: 'fund', label: '體質佳' }] },
    { cat: '籌碼', items: [{ key: 'trust', label: '投信連買' }, { key: 'foreign', label: '外資連買' }, { key: 'bothbuy', label: '法人同買' }] },
    { cat: '波動', items: [{ key: 'vol', label: '中高波' }] },
  ]
  const sel = [...filters]
  const filtered = inScan && sel.length
    ? baseRows.filter((r) => !isErr(r) && sel.every((k) => filterPred[k](r))) // 交集：要同時符合所有選取條件
    : baseRows
  // 主排序：總分高→低；同分用技術買點當 tiebreak。選股結果可切「本日漲幅」榜（純收盤漲幅高→低）
  const changeOf = (r: Row) => (isErr(r) ? -Infinity : r.changePct)
  const sortByGain = inScan && scanSort === 'gain'
  const displayRows = [...filtered].sort((a, b) =>
    sortByGain ? changeOf(b) - changeOf(a) : scoreOf(b) - scoreOf(a) || entryRank(a) - entryRank(b)
  )

  // 找某代號目前的最新數據（模擬持股 → 自選 → 選股結果）
  const currentOf = (sym: string): StockHealth | null => {
    for (const list of [paperData, rows, scanRows]) {
      const r = list.find((x) => x.symbol === sym)
      if (r && !isErr(r)) return r
    }
    return null
  }
  const heldSet = new Set(papers.map((p) => p.symbol))

  // 逆風判定：mood 偏空「或」加權跌破季線就算（2y 回測：大盤在季線下時，高分股 20 日平均 -2%、
  // 連「接近買點」都只剩 5 天反彈力——季線是硬條件，不是參考）
  const headwind = market?.mood === 'bearish' || market?.indices?.find((i) => i.key === 'twii')?.aboveMa60 === false

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

      {/* 總資金：算「2% 風險部位上限」用（跌到停損價時虧損 ≈ 總資金的 2%） */}
      <label className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
        💰 總資金
        <input
          type="number"
          value={capital}
          min={10000}
          step={10000}
          onChange={(e) => changeCapital(Number(e.target.value))}
          className="w-28 rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-right text-white focus:border-violet-400/50 focus:outline-none"
        />
        元——個股展開後會顯示「2% 風險部位上限」：買到上限、跌到停損價出場時，虧損約等於總資金的 2%
      </label>

      {/* 選股結果列：進度、動作、分類篩選 */}
      {inScan && (() => {
        const addable = displayRows.filter((r) => !isErr(r) && !symbols.some((s) => s.toUpperCase() === r.symbol.toUpperCase())).map((r) => r.symbol)
        const chipCls = (active: boolean) => `rounded px-2 py-1 text-xs ${active ? 'bg-emerald-500/20 text-emerald-200' : 'text-slate-400 hover:text-white'}`
        return (
        <div className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-3">
          {/* 上排：標題 + 排序 + 動作 */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-white">
              選股結果：掃 {scanProg.total} 檔（依{scanSort === 'gain' ? '本日漲幅' : '總分'}高→低）
              {scanning && `（進行中 ${scanProg.done}/${scanProg.total}）`}
            </span>
            <div className="flex overflow-hidden rounded-md border border-white/10 text-xs">
              <button onClick={() => setScanSort('score')} className={`px-2.5 py-1 ${scanSort === 'score' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>總分</button>
              <button onClick={() => setScanSort('gain')} className={`px-2.5 py-1 ${scanSort === 'gain' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>本日漲幅</button>
            </div>
            {addable.length > 0 && (
              <button onClick={() => addManyToWatch(addable)} className="ml-auto rounded-md border border-violet-400/40 bg-violet-500/10 px-3 py-1 text-xs font-medium text-violet-200 hover:bg-violet-500/20">
                ＋ 全部加入追蹤（{addable.length}）
              </button>
            )}
            <button onClick={() => setView('watch')} className={`text-xs text-slate-400 hover:text-white ${addable.length > 0 ? '' : 'ml-auto'}`}>← 回我的清單</button>
          </div>
          {/* 下排：大分類 → 中分類篩選（可複選，交集 AND）*/}
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/5 pt-2.5">
            <div className="flex items-center gap-1">
              <span className="mr-0.5 text-[10px] text-slate-500">綜合</span>
              <button onClick={() => toggleFilter('buy')} className={chipCls(filters.has('buy'))}>總分 {HIGH}+ {counts.buy}</button>
              <button onClick={() => setFilters(new Set())} className={chipCls(filters.size === 0)}>全部</button>
            </div>
            {filterGroups.map((g) => (
              <div key={g.cat} className="flex items-center gap-1">
                <span className="mr-0.5 text-[10px] text-slate-500">{g.cat}</span>
                {g.items.map((it) => (
                  <button key={it.key} onClick={() => toggleFilter(it.key)} className={chipCls(filters.has(it.key))}>
                    {it.label} {counts[it.key]}
                  </button>
                ))}
              </div>
            ))}
            {filters.size > 0 && (
              <button onClick={() => setFilters(new Set())} className="text-[11px] text-slate-500 hover:text-rose-300">清除（{filters.size}）✕</button>
            )}
          </div>
        </div>
        )
      })()}

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
                    {p.stopPrice != null && curPrice != null && (
                      curPrice <= p.stopPrice
                        ? <span className="rounded border border-rose-500/50 bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-300">🛑 已觸停損 {p.stopPrice}——照紀律出場，不凹單</span>
                        : <span className="text-xs text-slate-500">停損 {p.stopPrice}</span>
                    )}
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

      <div className="mt-8 space-y-2.5">
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
            <StockCard key={r.symbol} s={r} mode="scan" inWatch={symbols.includes(r.symbol)} onAdd={() => addToWatch(r.symbol)} onPaperBuy={() => paperBuy(r)} isHeld={heldSet.has(r.symbol)} bearish={headwind} capital={capital} />
          ) : (
            <StockCard key={r.symbol} s={r} mode="watch" onRemove={() => removeSymbol(r.symbol)} onPaperBuy={() => paperBuy(r)} isHeld={heldSet.has(r.symbol)} bearish={headwind} capital={capital} />
          )
        )}
      </div>

      {inScan && !scanning && displayRows.length === 0 && (
        <p className="mt-8 text-sm text-slate-400">
          這批熱門股裡，目前沒有同時符合「{sel.length ? sel.map((k) => FILTER_LABELS[k]).join(' ＋ ') : '任何'}」的標的——這很正常，代表現在大環境或多數個股還沒對齊。可切「全部」看完整清單（仍依總分排序），或換個條件、改天再掃。
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

function StockCard({ s, mode, onRemove, onAdd, inWatch, onPaperBuy, isHeld, bearish, capital }: { s: StockHealth; mode: 'watch' | 'scan'; onRemove?: () => void; onAdd?: () => void; inWatch?: boolean; onPaperBuy?: () => void; isHeld?: boolean; bearish?: boolean; capital: number }) {
  const [open, setOpen] = useState(false) // 預設收合，點整列展開詳細
  const [chartMode, setChartMode] = useState<'line' | 'candle'>('line') // 走勢圖：折線 / K棒
  const st = signalStyle[s.signal]
  const up = s.changePct >= 0
  const sc = scoreColor(s.overallScore)
  // 逆風降級：大盤偏空時，對偏多型進場訊號加註「寧可錯過」提醒
  const bullishEntry = s.entry === '帶量突破' || s.entry === '接近買點' || s.entry === '強勢偏貴'
  return (
    <div className={`rounded-xl border ${st.ring} bg-white/[0.03] overflow-hidden`}>
      {/* ===== 精簡列（永遠顯示，點整列展開/收合）===== */}
      <div onClick={() => setOpen((o) => !o)} className="cursor-pointer px-4 py-3 hover:bg-white/[0.02]">
        <div className="flex items-center gap-2.5">
          <span className={`h-2.5 w-2.5 rounded-full ${st.dot} shrink-0`} />
          <div className="min-w-0 truncate">
            <span className="font-semibold text-white">{s.name}</span>
            <span className="ml-1.5 text-xs text-slate-500">{s.symbol}</span>
          </div>
          <div className="ml-auto flex items-center gap-3 shrink-0">
            <div className="text-right leading-tight">
              <div className="text-sm font-semibold text-white">{s.price}</div>
              <div className={`text-xs ${up ? 'text-rose-400' : 'text-emerald-400'}`}>{up ? '▲' : '▼'}{Math.abs(s.changePct)}%</div>
            </div>
            <div className="flex items-baseline gap-0.5" title={`總分 ${s.overallScore}：${sc.label}`}>
              <span className={`text-xl font-bold ${sc.text}`}>{s.overallScore}</span>
              <span className="text-[10px] text-slate-500">分</span>
            </div>
            {mode === 'watch' ? (
              <button onClick={(e) => { e.stopPropagation(); onRemove?.() }} className="text-slate-600 hover:text-rose-400 leading-none" aria-label={`移除 ${s.symbol}`}>×</button>
            ) : inWatch ? (
              <span className="text-xs text-emerald-400 whitespace-nowrap">✓已加入</span>
            ) : (
              <button onClick={(e) => { e.stopPropagation(); onAdd?.() }} className="rounded border border-violet-400/40 px-2 py-0.5 text-xs text-violet-200 hover:bg-violet-500/20 whitespace-nowrap">＋清單</button>
            )}
            <span className={`text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
          </div>
        </div>
        {/* 第二行：徽章 + 迷你走勢 */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-5">
          <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${entryStyle[s.entry].cls}`}>{s.entry}</span>
          <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${fundStyle[s.fundSignal].cls}`}>{fundStyle[s.fundSignal].label}</span>
          <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${volStyle[s.volLabel].cls}`} title={`日均 ±${s.volatilityPct}%`}>{s.volLabel}</span>
          <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${chipStyle[s.chipSignal].cls}`}>{chipStyle[s.chipSignal].label}</span>
          {s.chipBothBuy && <span className="rounded border border-fuchsia-500/50 bg-fuchsia-500/15 px-2 py-0.5 text-[11px] font-medium text-fuchsia-200">🔥同買</span>}
          <Sparkline series={s.series} />
        </div>
      </div>

      {/* ===== 展開：完整詳細 ===== */}
      {open && (
      <div className="border-t border-white/5 px-4 pb-4 pt-1">
      {/* 三柱分數明細 */}
      <div className={`mt-3 rounded-lg border px-3 py-2.5 ${sc.ring}`}>
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${sc.text}`}>{sc.label}</span>
          <div className="ml-auto flex gap-3 text-[11px] text-slate-400">
            <span>技術 <span className="text-slate-200">{s.techScore}</span></span>
            <span>基本 <span className="text-slate-200">{s.fundScore ?? '—'}</span></span>
            <span>籌碼 <span className="text-slate-200">{s.chipScore ?? '—'}</span></span>
          </div>
        </div>
      </div>

      {/* ===== 技術面（看時機）===== */}
      <section className="mt-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300">📈 技術面</span>
          <span className="text-[10px] text-slate-600">看進場時機</span>
        </div>
        {bearish && bullishEntry && (
          <div className="mb-2 rounded-md border border-sky-500/30 bg-sky-500/[0.08] px-2.5 py-1.5 text-[11px] leading-relaxed text-sky-200">
            🌧 大盤逆風（偏空或跌破季線）：<span className="font-medium">波段買進訊號此時失效，不進場</span>——2年回測：大盤在季線下時，高總分股 20 日平均轉負、連「接近買點」都只剩幾天反彈力。已持有的緊盯停損。
          </div>
        )}
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
          <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${volStyle[s.volLabel].cls}`} title={`波動度（${volStyle[s.volLabel].hint}）：近60日平均每日漲跌 ±${s.volatilityPct}%、3個月高低振幅約 ${s.range60Pct}%`}>
            {s.volLabel}・日±{s.volatilityPct}%
          </span>
          <span className="inline-flex items-center rounded-md border border-rose-500/30 bg-rose-500/[0.06] px-2.5 py-1 text-xs font-medium text-rose-200" title={`停損距離依這檔的波動度推算（3.5×日均波動，夾5~15%）。回測：固定-6%停損有近半機率被日常雜訊掃出場，波動大的股票停損要放得更遠、部位相應縮小`}>
            🛑 建議停損 {s.stopPrice}（-{s.stopPct}%）
          </span>
          {(() => {
            // 2% 風險部位上限＝總資金×2% ÷ 停損距離%；停損越遠（越會跳的股票）能買越少
            const maxPos = Math.min(capital, Math.round((capital * 2) / s.stopPct))
            const shares = Math.floor(maxPos / s.price)
            return (
              <span
                className="inline-flex items-center rounded-md border border-violet-500/30 bg-violet-500/[0.06] px-2.5 py-1 text-xs font-medium text-violet-200"
                title={`2% 風險規則：部位上限＝總資金×2%÷停損距離。買滿 ${maxPos.toLocaleString()} 元、跌到停損價 ${s.stopPrice} 出場，虧損約 ${Math.round(capital * 0.02).toLocaleString()} 元（總資金 ${capital.toLocaleString()} 的 2%）`}
              >
                🎯 2%風險部位 ≤ {maxPos.toLocaleString()} 元{shares > 0 ? `（約 ${shares.toLocaleString()} 股）` : ''}
              </span>
            )
          })()}
          {s.chipBothBuy && (
            <span className="inline-flex items-center rounded-md border border-fuchsia-500/50 bg-fuchsia-500/15 px-2.5 py-1 text-xs font-medium text-fuchsia-200" title="外資與投信最近交易日同步買超：極強短線領先訊號">
              🔥 外資投信同買
            </span>
          )}
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

        {/* 走勢圖：可切換 折線（看趨勢）/ K棒（看進出場細節）*/}
        <div className="mt-3 mb-1 flex items-center gap-2">
          <span className="text-[11px] text-slate-500">走勢圖</span>
          <div className="flex overflow-hidden rounded border border-white/10 text-[10px]">
            {(['line', 'candle'] as const).map((m) => (
              <button key={m} onClick={() => setChartMode(m)} className={`px-2 py-0.5 ${chartMode === m ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>
                {m === 'line' ? '折線' : 'K棒'}
              </button>
            ))}
          </div>
          {chartMode === 'candle' && <span className="text-[10px] text-slate-500">近60根・紅漲綠跌</span>}
        </div>
        {chartMode === 'line' ? <MiniChart series={s.series} /> : <CandleChart series={s.series} />}
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
          {chartMode === 'line' && <span className="inline-flex items-center gap-1.5"><span className="inline-block w-4 rounded-full" style={{ height: 3, background: '#e2e8f0' }} />收盤價</span>}
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
      )}
    </div>
  )
}

// 迷你走勢火花線：只畫收盤、無座標，給精簡列一眼看方向（紅漲綠跌，台股慣例）
function Sparkline({ series }: { series: StockHealth['series'] }) {
  const c = series.close
  if (!c.length) return null
  const W = 72, H = 22
  const min = Math.min(...c), max = Math.max(...c)
  const x = (i: number) => (c.length <= 1 ? 0 : (i / (c.length - 1)) * W)
  const y = (v: number) => (1 - (v - min) / (max - min || 1)) * H
  const d = c.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const up = c[c.length - 1] >= c[0]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="ml-auto h-5 w-16 shrink-0">
      <path d={d} fill="none" stroke={up ? '#fb7185' : '#34d399'} strokeWidth="1.2" />
    </svg>
  )
}

// 本益比偏高給點顏色提示：>40 紅、>25 琥珀（粗略門檻，成長股本來就偏高，僅供參考）
function peColor(pe: number | null): string {
  if (pe == null) return 'text-slate-200'
  if (pe > 40) return 'text-rose-400'
  if (pe > 25) return 'text-amber-400'
  return 'text-slate-200'
}

// 價格刻度：在 min~max 間取等距 count+1 條，回傳格線位置(viewBox y)與標籤縱向比例(frac)
function priceTicks(min: number, max: number, H: number, padY: number, count = 4) {
  const out: { price: number; yvb: number; frac: number }[] = []
  for (let i = 0; i <= count; i++) {
    const v = min + (i / count) * (max - min)
    const yvb = padY + (1 - (v - min) / (max - min || 1)) * (H - 2 * padY)
    out.push({ price: v, yvb, frac: yvb / H })
  }
  return out
}
// 刻度標籤（HTML 疊在圖右側留白；圖用 preserveAspectRatio=none 會扭曲文字，故文字走 HTML 不進 SVG）
function PriceLabels({ ticks }: { ticks: { price: number; frac: number }[] }) {
  const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1))
  return (
    <>
      {ticks.map((t, i) => (
        <span key={i} className="pointer-events-none absolute right-0 -translate-y-1/2 tabular-nums text-[9px] text-slate-500" style={{ top: `${t.frac * 100}%` }}>{fmt(t.price)}</span>
      ))}
    </>
  )
}

// K 棒圖：近 60 根日K（紅漲綠跌＝台股慣例），疊月線/季線。小圖只畫 60 根才看得清楚 K 棒。
function CandleChart({ series }: { series: StockHealth['series'] }) {
  // 防呆：改版前抓到的舊資料沒有 OHLC，切 K 棒會 slice undefined 崩潰 → 提示重新整理
  if (!series.open?.length || !series.high?.length || !series.low?.length) {
    return <div className="mt-1 py-6 text-center text-[11px] text-slate-500">K 棒資料需重新整理（按清單上方「↻ 全部重新整理」即可）</div>
  }
  const N = Math.min(60, series.close.length)
  const o = series.open.slice(-N), h = series.high.slice(-N), l = series.low.slice(-N), c = series.close.slice(-N)
  const m20 = series.ma20.slice(-N), m60 = series.ma60.slice(-N)
  const W = 320, H = 140, padR = 2, padY = 8
  const nums = (a: (number | null)[]) => a.filter((v): v is number => v != null)
  const all = [...h, ...l, ...nums(m20), ...nums(m60)]
  if (!all.length) return null
  const min = Math.min(...all), max = Math.max(...all)
  const slot = (W - padR) / N
  const cx = (i: number) => slot * (i + 0.5)
  const y = (v: number) => padY + (1 - (v - min) / (max - min || 1)) * (H - 2 * padY)
  const cw = Math.max(1.5, slot * 0.62)
  const maPath = (arr: (number | null)[]) => {
    let d = '', started = false
    arr.forEach((v, i) => { if (v == null) return; d += `${started ? 'L' : 'M'}${cx(i).toFixed(1)} ${y(v).toFixed(1)} `; started = true })
    return d.trim()
  }
  const mlines = [{ arr: m60, color: '#818cf8', label: '季60' }, { arr: m20, color: '#fbbf24', label: '月20' }]
  const ticks = priceTicks(min, max, H, padY)
  return (
    <div className="relative mt-1 pr-9">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-44">
        {ticks.map((t, i) => <line key={'g' + i} x1={0} y1={t.yvb} x2={W} y2={t.yvb} stroke="#ffffff" strokeOpacity={i === 0 || i === ticks.length - 1 ? 0.1 : 0.05} strokeWidth="0.5" vectorEffect="non-scaling-stroke" />)}
        {mlines.map((ln) => <path key={ln.label} d={maPath(ln.arr)} fill="none" stroke={ln.color} strokeWidth="1" opacity="0.9" vectorEffect="non-scaling-stroke" />)}
        {Array.from({ length: N }).map((_, i) => {
          const up = c[i] >= o[i]
          const color = up ? '#fb7185' : '#34d399'
          const yo = y(o[i]), yc = y(c[i])
          const top = Math.min(yo, yc), bot = Math.max(yo, yc)
          return (
            <g key={i}>
              <line x1={cx(i)} y1={y(h[i])} x2={cx(i)} y2={y(l[i])} stroke={color} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <rect x={cx(i) - cw / 2} y={top} width={cw} height={Math.max(0.8, bot - top)} fill={color} />
            </g>
          )
        })}
      </svg>
      <PriceLabels ticks={ticks} />
    </div>
  )
}

function MiniChart({ series }: { series: StockHealth['series'] }) {
  const W = 320
  const H = 110
  const padL = 2
  const padR = 2
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
  const lines = [
    { arr: series.ma60, color: '#818cf8', label: '季60' },
    { arr: series.ma20, color: '#fbbf24', label: '月20' },
    { arr: series.close, color: '#e2e8f0', label: '收盤', w: 1.5 },
  ]
  const ticks = priceTicks(min, max, H, padY)
  return (
    <div className="relative mt-3 pr-9">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-36">
        {ticks.map((t, i) => (
          <line key={'g' + i} x1={0} y1={t.yvb} x2={W} y2={t.yvb} stroke="#ffffff" strokeOpacity={i === 0 || i === ticks.length - 1 ? 0.1 : 0.05} strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
        ))}
        {lines.map((ln) => (
          <path key={ln.label} d={path(ln.arr)} fill="none" stroke={ln.color} strokeWidth={ln.w ?? 1} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <PriceLabels ticks={ticks} />
    </div>
  )
}

function KDChart({ series }: { series: StockHealth['series'] }) {
  const W = 320
  const H = 64
  const padL = 2
  const padR = 2
  const padY = 6
  const n = series.k.length
  if (!n) return null
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR))
  const y = (v: number) => padY + (1 - v / 100) * (H - 2 * padY) // KD 固定 0~100
  const path = (arr: number[]) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const kdTicks = [{ v: 80, c: '#f87171' }, { v: 50, c: '#64748b' }, { v: 20, c: '#34d399' }]
  return (
    <div className="relative mt-1 pr-6">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-20">
        <line x1={padL} y1={y(80)} x2={W - padR} y2={y(80)} stroke="#f87171" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.6" vectorEffect="non-scaling-stroke" />
        <line x1={padL} y1={y(50)} x2={W - padR} y2={y(50)} stroke="#64748b" strokeWidth="0.5" strokeDasharray="2 4" opacity="0.4" vectorEffect="non-scaling-stroke" />
        <line x1={padL} y1={y(20)} x2={W - padR} y2={y(20)} stroke="#34d399" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.6" vectorEffect="non-scaling-stroke" />
        <path d={path(series.d)} fill="none" stroke="#818cf8" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={path(series.k)} fill="none" stroke="#fbbf24" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      {kdTicks.map(({ v, c }) => (
        <span key={v} className="pointer-events-none absolute right-0 -translate-y-1/2 text-[9px]" style={{ top: `${(y(v) / H) * 100}%`, color: c }}>{v}</span>
      ))}
    </div>
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
