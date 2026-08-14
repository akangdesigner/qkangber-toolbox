'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type Idea = {
  title: string
  titleZh: string
  summary: string
  note: string
  url: string
  hnUrl: string
  points: number
  comments: number
  createdAt: string
}

type RadarIdea = {
  row: number
  日期: string
  類別: string
  新聞標題: string
  來源: string
  新聞連結: string
  工具分數: number
  工具點子: string
  資料集: string
  使用者輸入: string
  商機分數: number
  商機點子: string
  重複: string
  狀態: string
}

type RadarFilter = '全部' | '未讀' | '要做' | '高分'

const chipStyle = (active: boolean) => ({
  background: active ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : 'rgba(255,255,255,0.04)',
  border: active ? '1px solid transparent' : '1px solid rgba(255,255,255,0.08)',
})

function ScoreBadge({ label, score }: { label: string; score: number }) {
  const hot = score >= 8
  return (
    <span
      className="px-2 py-0.5 rounded-full text-xs font-medium"
      style={{
        background: hot ? 'rgba(251,191,36,0.12)' : 'rgba(255,255,255,0.05)',
        color: hot ? '#fbbf24' : '#94a3b8',
        border: hot ? '1px solid rgba(251,191,36,0.3)' : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {label} {score}
    </span>
  )
}

function RadarTab() {
  const [ideas, setIdeas] = useState<RadarIdea[]>([])
  const [filter, setFilter] = useState<RadarFilter>('未讀')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState<number | null>(null)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/tools/idea-spark/radar')
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? '讀取失敗')
        setIdeas(json.ideas ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : '發生錯誤')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  async function setStatus(idea: RadarIdea, status: string) {
    if (idea.狀態 === status) return
    setSaving(idea.row)
    const prev = idea.狀態
    setIdeas((list) => list.map((it) => (it.row === idea.row ? { ...it, 狀態: status } : it)))
    try {
      const res = await fetch('/api/tools/idea-spark/radar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ row: idea.row, link: idea.新聞連結, status }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '更新失敗')
    } catch (err) {
      setIdeas((list) => list.map((it) => (it.row === idea.row ? { ...it, 狀態: prev } : it)))
      setError(err instanceof Error ? err.message : '更新失敗')
    } finally {
      setSaving(null)
    }
  }

  const shown = ideas.filter((it) => {
    if (filter === '未讀') return it.狀態 === '未讀'
    if (filter === '要做') return it.狀態 === '要做'
    if (filter === '高分') return it.工具分數 >= 8 && it.狀態 !== '放生'
    return true
  })

  const filters: { key: RadarFilter; label: string }[] = [
    { key: '未讀', label: `未讀 ${ideas.filter((i) => i.狀態 === '未讀').length}` },
    { key: '高分', label: '工具 8 分↑' },
    { key: '要做', label: `要做 ${ideas.filter((i) => i.狀態 === '要做').length}` },
    { key: '全部', label: '全部' },
  ]

  return (
    <div>
      <p className="text-slate-400 mb-6">
        n8n 點子雷達每天 8:30 掃民生時事（回收、食安、個資外洩、詐騙、新制），AI 評「能不能做成查詢小工具」＋「有沒有商機」。想找靈感再來翻，看完標「要做」或「放生」。
      </p>

      <div className="flex flex-wrap gap-2 mb-6">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className="px-4 py-1.5 rounded-full text-sm text-white transition-all"
            style={chipStyle(filter === f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-6 rounded-xl px-4 py-3 text-sm text-red-400" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
          {error}
        </div>
      )}

      {loading && <p className="text-center text-sm text-slate-600 mt-10">讀取中…</p>}

      <div className="space-y-4">
        {shown.map((idea) => (
          <div
            key={idea.row}
            className="rounded-2xl px-5 py-4"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div className="flex flex-wrap items-center gap-2 mb-2 text-xs text-slate-500">
              <span>{idea.日期}</span>
              <span className="px-2 py-0.5 rounded-full" style={{ background: 'rgba(139,92,246,0.12)', color: '#c4b5fd' }}>{idea.類別}</span>
              {idea.重複 === '復活' && (
                <span className="px-2 py-0.5 rounded-full" style={{ background: 'rgba(52,211,153,0.12)', color: '#6ee7b7' }}>復活・同類事件重演</span>
              )}
              <ScoreBadge label="工具" score={idea.工具分數} />
              <ScoreBadge label="商機" score={idea.商機分數} />
            </div>

            {idea.工具點子 && <h2 className="text-white font-medium mb-1">🔧 {idea.工具點子}</h2>}
            {(idea.資料集 || idea.使用者輸入) && (
              <p className="text-xs text-slate-500 mb-2">
                {idea.資料集 && <>資料集：{idea.資料集}</>}
                {idea.資料集 && idea.使用者輸入 && '｜'}
                {idea.使用者輸入 && <>使用者提供：{idea.使用者輸入}</>}
              </p>
            )}
            {idea.商機點子 && <p className="text-sm text-violet-300 mb-2">💼 {idea.商機點子}</p>}

            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <a href={idea.新聞連結} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-slate-300 truncate max-w-full">
                {idea.新聞標題}
              </a>
            </div>

            <div className="flex gap-2 mt-3">
              {(['要做', '放生', '未讀'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatus(idea, s)}
                  disabled={saving === idea.row}
                  className="px-3 py-1 rounded-full text-xs text-white transition-all disabled:opacity-40"
                  style={chipStyle(idea.狀態 === s)}
                >
                  {s === '要做' ? '⭐ 要做' : s === '放生' ? '放生' : '未讀'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {!loading && shown.length === 0 && !error && (
        <p className="text-center text-sm text-slate-600 mt-10">
          {filter === '未讀' ? '沒有未讀點子，雷達明早 8:30 會再掃一輪' : '這個篩選下沒有點子'}
        </p>
      )}
    </div>
  )
}

function ShowHNTab() {
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  async function load(q: string) {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/tools/idea-spark?q=${encodeURIComponent(q)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '抓取失敗')
      setIdeas(json.ideas ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '發生錯誤')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load('')
  }, [])

  function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    load(query.trim())
  }

  return (
    <div>
      <p className="text-slate-400 mb-6">抓 Hacker News 上的 Show HN，看獨立開發者都在做什麼小工具。AI 讀作者自述寫成中文摘要，不點原文也知道他做了什麼，再補一句延伸靈感。</p>

      <form onSubmit={handleSearch} className="flex gap-2 mb-8">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="輸入關鍵字搜尋（留空＝近期熱門）"
          className="flex-1 rounded-full px-5 py-3 text-white text-sm placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500/50"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
        />
        <button
          type="submit"
          disabled={loading}
          className="px-6 rounded-full text-white font-medium text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
        >
          {loading ? '搜尋中…' : '搜尋'}
        </button>
      </form>

      {error && (
        <div className="mb-6 rounded-xl px-4 py-3 text-sm text-red-400" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}>
          {error}
        </div>
      )}

      {loading && ideas.length === 0 && (
        <p className="text-center text-sm text-slate-600 mt-10">抓取中…</p>
      )}

      <div className="space-y-4">
        {ideas.map((idea) => (
          <div
            key={idea.hnUrl}
            className="rounded-2xl px-5 py-4"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <h2 className="text-white font-medium mb-1">{idea.titleZh}</h2>
            <p className="text-xs text-slate-500 mb-2">{idea.title}</p>
            {idea.summary && <p className="text-sm text-slate-300 leading-relaxed mb-3">{idea.summary}</p>}
            {idea.note && <p className="text-sm text-violet-300 mb-3">💡 {idea.note}</p>}
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span>▲ {idea.points}</span>
              <span>💬 {idea.comments}</span>
              <a href={idea.url} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-slate-300">
                查看網站
              </a>
              <a href={idea.hnUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-dotted hover:text-slate-300">
                看討論
              </a>
            </div>
          </div>
        ))}
      </div>

      {!loading && ideas.length === 0 && !error && (
        <p className="text-center text-sm text-slate-600 mt-10">沒找到結果，換個關鍵字試試</p>
      )}
    </div>
  )
}

export default function IdeaSparkPage() {
  const [tab, setTab] = useState<'radar' | 'hn'>('radar')

  return (
    <main className="relative max-w-2xl mx-auto px-4 sm:px-6 py-12">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl sm:text-3xl font-semibold text-white tracking-[-0.02em]">創業靈感雷達</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
      </div>

      <div className="flex gap-2 mb-8">
        <button
          onClick={() => setTab('radar')}
          className="px-5 py-2 rounded-full text-sm text-white transition-all"
          style={chipStyle(tab === 'radar')}
        >
          📡 時事點子庫
        </button>
        <button
          onClick={() => setTab('hn')}
          className="px-5 py-2 rounded-full text-sm text-white transition-all"
          style={chipStyle(tab === 'hn')}
        >
          🌏 Show HN 靈感
        </button>
      </div>

      {tab === 'radar' ? <RadarTab /> : <ShowHNTab />}
    </main>
  )
}
