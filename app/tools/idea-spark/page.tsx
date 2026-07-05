'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type Idea = {
  title: string
  titleZh: string
  note: string
  url: string
  hnUrl: string
  points: number
  comments: number
  createdAt: string
}

export default function IdeaSparkPage() {
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
    <main className="relative max-w-2xl mx-auto px-4 sm:px-6 py-12">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl sm:text-3xl font-semibold text-white tracking-[-0.02em]">創業靈感雷達</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
      </div>
      <p className="text-slate-400 mb-8">抓 Hacker News 上的 Show HN，看獨立開發者都在做什麼小工具，AI 順手翻成中文＋補一句延伸靈感。</p>

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
    </main>
  )
}
