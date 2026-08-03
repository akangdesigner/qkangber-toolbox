'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'

type ChatMsg = { role: 'user' | 'assistant'; content: string; crisis?: boolean }

// 把危機文案裡的求助電話轉成可點擊的 tel: 連結（手機上能直接撥打）
function linkifyPhones(text: string): ReactNode[] {
  const parts = text.split(/(\d{3,4})(?=（|\)|\s|$)/g)
  return parts.map((part, i) =>
    /^\d{3,4}$/.test(part) ? (
      <a key={i} href={`tel:${part}`} className="underline decoration-dotted underline-offset-2 text-amber-200">
        {part}
      </a>
    ) : (
      part
    )
  )
}

export default function MemoryBotPage() {
  const [target, setTarget] = useState('')
  const [ready, setReady] = useState<boolean | null>(null)
  const [initError, setInitError] = useState('')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/tools/memory-bot')
      .then((r) => r.json())
      .then((j) => {
        if (j.ready) {
          setReady(true)
          setTarget(j.target)
        } else {
          setReady(false)
          setInitError(j.error ?? '資料尚未就緒')
        }
      })
      .catch(() => { setReady(false); setInitError('無法連線') })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, loading])

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    setLoading(true)
    try {
      const res = await fetch('/api/tools/memory-bot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '回覆失敗')
      setMessages((m) => [...m, { role: 'assistant', content: json.reply, crisis: !!json.crisis }])
    } catch (err) {
      setMessages((m) => [...m, { role: 'assistant', content: `（${err instanceof Error ? err.message : '出了點問題'}）` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="relative max-w-2xl mx-auto px-4 sm:px-6 py-8 flex flex-col" style={{ minHeight: '100dvh' }}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-white tracking-[-0.02em]">
            {target ? target : '思念'}
            <span className="text-xs text-slate-500 font-normal ml-2">from 思念</span>
          </h1>
        </div>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
      </div>
      <p className="text-xs text-slate-500 mb-4">用你們的真實對話學說話。它記得的是過去，不會憑空知道現在的事。</p>

      {ready === false && (
        <div className="rounded-xl px-4 py-3 text-sm text-amber-300" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)' }}>
          {initError}
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-2xl p-4 space-y-3"
        style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
      >
        {messages.length === 0 && ready && (
          <p className="text-center text-sm text-slate-600 mt-10">傳一句話給{target}吧…</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[78%] px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${m.crisis ? 'max-w-[90%]' : ''}`}
              style={
                m.crisis
                  ? { background: 'rgba(245,158,11,0.1)', color: '#fde68a', borderRadius: '18px 18px 18px 4px', border: '1px solid rgba(245,158,11,0.3)' }
                  : m.role === 'user'
                  ? { background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: '#fff', borderRadius: '18px 18px 4px 18px' }
                  : { background: 'rgba(255,255,255,0.06)', color: '#e2e8f0', borderRadius: '18px 18px 18px 4px', border: '1px solid rgba(255,255,255,0.06)' }
              }
            >
              {m.crisis ? linkifyPhones(m.content) : m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="px-4 py-2.5 text-sm text-slate-500" style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '18px 18px 18px 4px' }}>
              {target} 正在輸入…
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send() }}
          disabled={!ready || loading}
          placeholder="說點什麼…"
          className="flex-1 rounded-full px-5 py-3 text-white text-sm placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500/50 disabled:opacity-50"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
        />
        <button
          onClick={send}
          disabled={!ready || loading || !input.trim()}
          className="px-6 rounded-full text-white font-medium text-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
        >
          傳送
        </button>
      </div>
    </main>
  )
}
