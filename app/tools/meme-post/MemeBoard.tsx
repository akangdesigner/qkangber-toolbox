'use client'

import { useEffect, useState } from 'react'
import MemeEditor from './MemeEditor'

type Template = { id: string; name: string; url: string; box_count: number; 用法?: string }
type TemplateSuggestion = { 模板: Template; 分數: number; 理由: string; 文字: string[] }

export default function MemeBoard() {
  const [主題, set主題] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggested, setSuggested] = useState(false)
  const [suggestions, setSuggestions] = useState<TemplateSuggestion[]>([])

  const [templates, setTemplates] = useState<Template[]>([])
  const [browsing, setBrowsing] = useState(false)

  const [editing, setEditing] = useState<{ template: Template; texts: string[] } | null>(null)

  useEffect(() => {
    fetch('/api/tools/meme-post/templates')
      .then((r) => r.json())
      .then((j) => setTemplates(j.templates ?? []))
      .catch(() => {})
  }, [])

  async function runSuggest(e: React.FormEvent) {
    e.preventDefault()
    const t = 主題.trim()
    if (!t) return
    setSuggesting(true)
    setSuggested(false)
    setSuggestions([])
    try {
      const res = await fetch('/api/tools/meme-post/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 主題: t }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? res.status)
      setSuggestions(json.templateSuggestions ?? [])
      setSuggested(true)
    } catch (e) {
      alert('推薦失敗：' + e)
    }
    setSuggesting(false)
  }

  return (
    <div className="space-y-8">
      {editing && (
        <MemeEditor template={editing.template} texts={editing.texts} onClose={() => setEditing(null)} />
      )}

      {/* 主題 → 推薦格式 */}
      <section className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <form onSubmit={runSuggest} className="flex flex-wrap gap-2">
          <input
            value={主題}
            onChange={(e) => set主題(e.target.value)}
            placeholder="想做什麼梗圖？例：嘲諷 Gemini 模型能力差"
            className="min-w-60 flex-1 rounded-lg border border-white/10 bg-black/30 px-4 py-2 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-violet-400"
          />
          <button
            type="submit"
            disabled={suggesting || !主題.trim()}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            {suggesting ? '想哏中…' : '產生梗圖'}
          </button>
        </form>
        <p className="mt-2 text-xs text-slate-500">AI 挑格式並把每一格的字寫好，點「編輯這張」就能拖字、下載。</p>
      </section>

      {/* 推薦結果 */}
      {suggested && (
        <section>
          {suggestions.length === 0 ? (
            <p className="text-sm text-slate-500">這次沒想出來，換個講法再試一次，或直接從下面挑格式。</p>
          ) : (
            <div className="space-y-3">
              {suggestions.map((t) => (
                <div
                  key={t.模板.id}
                  className="flex flex-wrap gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-3"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={t.模板.url}
                    alt={t.模板.name}
                    crossOrigin="anonymous"
                    className="h-32 w-32 rounded-lg bg-black/40 object-contain"
                  />
                  <div className="min-w-52 flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300">
                        {t.分數} 分
                      </span>
                      <span className="truncate text-xs text-slate-500">{t.模板.name}</span>
                    </div>
                    <p className="text-sm text-slate-300">{t.理由}</p>
                    <ol className="space-y-1">
                      {t.文字.map((line, i) => (
                        <li key={i} className="flex gap-2 text-sm">
                          <span className="text-slate-600">{i + 1}.</span>
                          <span className="text-slate-100">
                            {line || <em className="text-slate-600">（留白）</em>}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <button
                      onClick={() => setEditing({ template: t.模板, texts: t.文字 })}
                      className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
                    >
                      編輯這張
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 全部格式：不想讓 AI 挑就自己翻 */}
      <section>
        <button onClick={() => setBrowsing((v) => !v)} className="text-sm text-slate-400 hover:text-slate-200">
          {browsing ? '▾' : '▸'} 自己挑格式（{templates.length} 個）
        </button>
        {browsing && (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {templates.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => setEditing({ template: tpl, texts: Array(tpl.box_count).fill('') })}
                className="group rounded-xl border border-white/10 p-2 text-left transition-colors hover:border-violet-400"
                title={tpl.用法 ?? tpl.name}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={tpl.url}
                  alt={tpl.name}
                  loading="lazy"
                  crossOrigin="anonymous"
                  className="mb-1 aspect-square w-full rounded-lg bg-black/40 object-contain"
                />
                <p className="truncate text-xs text-slate-400 group-hover:text-slate-200">{tpl.name}</p>
                <p className="text-[11px] text-slate-600">{tpl.box_count} 格</p>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
