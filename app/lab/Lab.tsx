'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { StockHealth } from '@/lib/stock'

// 選股研究室：跟「看盤」分開的記錄帳本。
// 預測對帳本：記「我看好它」，T+5/T+20 結算「有沒有贏過大盤(0050)」，累積誠實勝率。
// （飆股解剖已併回看盤的選股掃描——那裡有現成的折線/K棒圖可看。）

const PRED_KEY = 'qk-predictions' // 與看盤共用同一份 localStorage（同源跨路由共享）
const BENCH = '0050' // 大盤基準
const HORIZONS = [5, 20] as const

type PredSnap = { stockRet: number; benchRet: number; alpha: number; at: string }
type Prediction = {
  id: string
  symbol: string
  name: string
  pickDate: string
  pickPrice: number
  benchPrice: number
  reason: string
  t5?: PredSnap
  t20?: PredSnap
}

// 兩日期間經過幾個「交易日」（粗算：只數週一~五，不扣國定假日）
function tradingDaysBetween(fromIso: string): number {
  const from = new Date(fromIso); from.setHours(0, 0, 0, 0)
  const to = new Date(); to.setHours(0, 0, 0, 0)
  let n = 0
  const cur = new Date(from)
  while (cur < to) {
    cur.setDate(cur.getDate() + 1)
    const dow = cur.getDay()
    if (dow >= 1 && dow <= 5) n++
  }
  return n
}
const r1 = (n: number) => Math.round(n * 10) / 10
const isHealth = (r: unknown): r is StockHealth => !!r && typeof r === 'object' && !('error' in (r as object))

async function fetchHealth(codes: string[]): Promise<StockHealth[]> {
  if (!codes.length) return []
  const res = await fetch('/api/watch?symbols=' + encodeURIComponent(codes.join(',')))
  const j = await res.json()
  if (!j.ok) throw new Error(j.error || '查詢失敗')
  return (j.results as unknown[]).filter(isHealth)
}
async function fetchOne(code: string): Promise<StockHealth | null> {
  const [r] = await fetchHealth([code])
  return r ?? null
}

export default function Lab() {
  const [bench, setBench] = useState<StockHealth | null>(null)
  const [preds, setPreds] = useState<Prediction[]>([])
  const [predData, setPredData] = useState<StockHealth[]>([])
  const [horizon, setHorizon] = useState<5 | 20>(20)
  const [predInput, setPredInput] = useState('')
  const [predBusy, setPredBusy] = useState(false)

  // 載入：歷史預測 + 大盤(0050) + 預測標的現價
  useEffect(() => {
    let list: Prediction[] = []
    try {
      const s = localStorage.getItem(PRED_KEY)
      if (s) list = JSON.parse(s)
    } catch {}
    setPreds(list)
    fetchHealth(Array.from(new Set([BENCH, ...list.map((p) => p.symbol)])))
      .then((rs) => {
        const b = rs.find((r) => r.symbol === BENCH)
        if (b) setBench(b)
        setPredData(rs.filter((r) => r.symbol !== BENCH))
      })
      .catch(() => {})
  }, [])

  function savePreds(next: Prediction[]) {
    setPreds(next)
    localStorage.setItem(PRED_KEY, JSON.stringify(next))
  }

  // 結算：補上已滿 T+5 / T+20 的凍結快照（凍結後不再變，才是誠實成績單）
  useEffect(() => {
    if (!bench || !preds.length) return
    let changed = false
    const next = preds.map((p) => {
      if (p.t5 && p.t20) return p
      const cur = predData.find((r) => r.symbol === p.symbol)
      if (!cur) return p
      const td = tradingDaysBetween(p.pickDate)
      const stockRet = ((cur.price - p.pickPrice) / p.pickPrice) * 100
      const benchRet = ((bench.price - p.benchPrice) / p.benchPrice) * 100
      const snap: PredSnap = { stockRet: r1(stockRet), benchRet: r1(benchRet), alpha: r1(stockRet - benchRet), at: new Date().toISOString() }
      let np = p
      if (td >= 5 && !np.t5) { np = { ...np, t5: snap }; changed = true }
      if (td >= 20 && !np.t20) { np = { ...np, t20: snap }; changed = true }
      return np
    })
    if (changed) savePreds(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bench, predData])

  async function recordPrediction() {
    const code = predInput.trim().toUpperCase()
    if (!code) return
    if (!bench) { alert('大盤(0050)還在載入，稍等一下再記'); return }
    if (preds.some((p) => p.symbol === code && !p.t20)) { alert('這檔已有未結算的預測，先讓它跑完 T+20'); setPredInput(''); return }
    setPredBusy(true)
    let s: StockHealth | null = null
    try { s = await fetchOne(code) } catch {}
    setPredBusy(false)
    if (!s) { alert('查無此代號（上市/上櫃都找不到）'); return }
    const reason = window.prompt(`為什麼看好「${s.name}」？寫一句話，未來複盤時最值錢（可留空）`)
    if (reason === null) return
    const p: Prediction = {
      id: `${s.symbol}-${Date.now()}`,
      symbol: s.symbol, name: s.name,
      pickDate: new Date().toISOString(),
      pickPrice: s.price, benchPrice: bench.price,
      reason: reason.trim(),
    }
    savePreds([p, ...preds])
    setPredData((prev) => [s!, ...prev.filter((r) => r.symbol !== s!.symbol)])
    setPredInput('')
  }

  function removePrediction(id: string) {
    savePreds(preds.filter((p) => p.id !== id))
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-white">選股研究室</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-white">← 回工具箱</Link>
      </div>
      <p className="mb-6 text-sm text-slate-400">
        記錄帳本，跟「看盤」分開：記下你看好的股票，用<span className="text-slate-200">「贏過大盤」</span>誠實驗證自己的判斷。研究線索，不是追噴完的榜單。
      </p>

      <section className="rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2 className="text-sm font-medium text-white">🎯 預測對帳本<span className="ml-2 text-xs text-slate-500">「贏過大盤(0050)」才算對</span></h2>
          <div className="ml-auto flex overflow-hidden rounded-lg border border-white/10 text-xs">
            {HORIZONS.map((h) => (
              <button key={h} onClick={() => setHorizon(h)} className={`px-2.5 py-1 ${horizon === h ? 'bg-violet-500/25 text-violet-100' : 'text-slate-400 hover:text-white'}`}>
                T+{h} 結算
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex gap-2">
          <input
            value={predInput}
            onChange={(e) => setPredInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') recordPrediction() }}
            placeholder="輸入你看好的代號，按 Enter 記一筆預測"
            className="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-white placeholder:text-slate-500 focus:border-violet-400/50 focus:outline-none"
          />
          <button onClick={recordPrediction} disabled={predBusy} className="rounded-lg bg-violet-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-violet-400 disabled:opacity-50">
            {predBusy ? '查詢中…' : '🎯 記一筆'}
          </button>
        </div>

        {preds.length > 0 ? (
          <Scorecard preds={preds} predData={predData} bench={bench} horizon={horizon} onRemove={removePrediction} />
        ) : (
          <p className="mt-4 text-sm text-slate-400">還沒有預測。輸入一檔你看好的股票記下來，T+{horizon} 個交易日後看它有沒有贏過大盤。</p>
        )}
      </section>
    </main>
  )
}

// ---------- 預測成績單 ----------
function Scorecard({ preds, predData, bench, horizon, onRemove }: {
  preds: Prediction[]; predData: StockHealth[]; bench: StockHealth | null; horizon: 5 | 20; onRemove: (id: string) => void
}) {
  const sign = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
  const dateOf = (iso: string) => new Date(iso).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })
  const list = preds.map((p) => {
    const cur = predData.find((r) => r.symbol === p.symbol) ?? null
    const td = tradingDaysBetween(p.pickDate)
    const liveStock = cur ? ((cur.price - p.pickPrice) / p.pickPrice) * 100 : null
    const liveBench = bench ? ((bench.price - p.benchPrice) / p.benchPrice) * 100 : null
    const liveAlpha = liveStock != null && liveBench != null ? liveStock - liveBench : null
    const snap = horizon === 5 ? p.t5 : p.t20
    return { p, td, liveStock, liveBench, liveAlpha, snap }
  })
  const judged = list.filter((x) => x.snap)
  const wins = judged.filter((x) => x.snap!.alpha > 0)
  const hit = judged.length ? (wins.length / judged.length) * 100 : null
  const avgAlpha = judged.length ? judged.reduce((a, x) => a + x.snap!.alpha, 0) / judged.length : null
  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg bg-white/[0.03] px-3 py-2.5 text-xs text-slate-400">
        <span>預測 <span className="text-slate-200">{preds.length}</span> 筆</span>
        <span>已結算（T+{horizon}）<span className="text-slate-200">{judged.length}</span> 筆</span>
        {hit != null ? (
          <>
            <span className="ml-auto text-sm font-semibold text-white">
              贏過大盤勝率 <span className={hit >= 50 ? 'text-rose-400' : 'text-emerald-400'}>{hit.toFixed(0)}%</span>
              <span className="ml-1 text-xs font-normal text-slate-500">（{wins.length}/{judged.length}）</span>
            </span>
            {avgAlpha != null && <span className="text-xs">平均超額 <span className={avgAlpha >= 0 ? 'text-rose-400' : 'text-emerald-400'}>{sign(avgAlpha)}</span></span>}
          </>
        ) : (
          <span className="ml-auto text-xs text-slate-500">還沒有預測滿 T+{horizon} 個交易日，再等幾天就有第一筆成績。</span>
        )}
      </div>

      <div className="space-y-2">
        {list.map(({ p, td, liveStock, liveBench, liveAlpha, snap }) => {
          const shown = snap ?? (liveAlpha != null ? { stockRet: liveStock!, benchRet: liveBench!, alpha: liveAlpha, at: '' } : null)
          const win = (shown?.alpha ?? 0) > 0
          return (
            <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white/[0.03] px-3 py-2 text-sm">
              <span className="font-medium text-white">{p.name}</span>
              <span className="text-xs text-slate-500">{dateOf(p.pickDate)} 記・持有 {td} 交易日</span>
              {shown ? (
                <>
                  <span className="text-xs text-slate-400">你 <span className={shown.stockRet >= 0 ? 'text-rose-400' : 'text-emerald-400'}>{sign(shown.stockRet)}</span> / 大盤 <span className={shown.benchRet >= 0 ? 'text-rose-400' : 'text-emerald-400'}>{sign(shown.benchRet)}</span></span>
                  <span className={`text-xs font-semibold ${win ? 'text-rose-400' : 'text-emerald-400'}`}>超額 {sign(shown.alpha)}</span>
                </>
              ) : (
                <span className="text-xs text-slate-500">現價載入中…</span>
              )}
              {snap ? (
                <span className={`rounded border px-2 py-0.5 text-[11px] font-medium ${win ? 'border-rose-500/40 bg-rose-500/10 text-rose-300' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'}`}>
                  T+{horizon} 結算・{win ? '✓ 贏過大盤' : '✗ 輸給大盤'}
                </span>
              ) : (
                <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">觀察中 {td}/{horizon}</span>
              )}
              <button onClick={() => onRemove(p.id)} className="ml-auto rounded border border-white/10 px-2 py-0.5 text-xs text-slate-300 hover:border-rose-400/50 hover:text-rose-300">刪除</button>
              {p.reason && <p className="w-full pl-0.5 text-xs text-slate-500">💭 {p.reason}</p>}
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        只有滿 T+{horizon} 個交易日的預測才列入勝率——一日漲跌是雜訊，多頭時人人都賺，唯有「贏過大盤」才證明你的判斷有價值。誠實面對輸的單，比記住贏的單更重要。
      </p>
    </div>
  )
}
