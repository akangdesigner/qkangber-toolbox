'use client'

import { useState } from 'react'
import type { Candidate } from '@/lib/news-fetch'
import type { PostedLog } from '@/lib/news'

const typeColor: Record<string, string> = {
  'AI/LLM': 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  台灣科技: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  科技綜合: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  國際科技: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
}

type VKey = '感性' | '技術' | '討論'
const VARIANTS: { key: VKey; label: string }[] = [
  { key: '感性', label: '感性人味' },
  { key: '技術', label: '技術短知識' },
  { key: '討論', label: '觸發討論' },
]

const stripUrls = (s: string) =>
  (s || '').replace(/https?:\/\/\S+/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
const hasCJK = (s: string) => /[一-鿿]/.test(s)
const domainOf = (u: string) => (u.match(/https?:\/\/([^/]+)/)?.[1] || u).replace(/^www\./, '')

export default function NewsBoard({ history }: { history: PostedLog[] }) {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [drafts, setDrafts] = useState<Record<string, Record<VKey, string>>>({})
  const [tab, setTab] = useState<Record<string, VKey>>({})
  const [withImg, setWithImg] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [lang, setLang] = useState<'all' | 'zh' | 'en'>('all')
  const [posted, setPosted] = useState<PostedLog[]>(history)

  const zh = candidates.filter((c) => hasCJK(c.標題))
  const en = candidates.filter((c) => !hasCJK(c.標題))

  async function runFetch() {
    setFetching(true)
    try {
      const res = await fetch('/api/news/fetch', { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.ok) {
        const items: Candidate[] = json.items || []
        setCandidates(items)
        setDrafts(Object.fromEntries(items.map((c) => [c.原文連結, { 感性: stripUrls(c.感性), 技術: stripUrls(c.技術), 討論: stripUrls(c.討論) }])))
        setTab(Object.fromEntries(items.map((c) => [c.原文連結, '感性' as VKey])))
        setWithImg(Object.fromEntries(items.map((c) => [c.原文連結, c.配圖 === '是' && !!c.圖片連結])))
        if (items.length === 0) alert(`掃了 ${json.scanned} 則，兩天內沒有新的夠分（或都發過了）。`)
      } else {
        alert('抓取失敗：' + (json.error || res.status))
      }
    } catch (e) {
      alert('抓取失敗：' + e)
    }
    setFetching(false)
  }

  async function publish(c: Candidate) {
    const vkey = tab[c.原文連結] ?? '感性'
    const text = drafts[c.原文連結]?.[vkey] ?? ''
    if (![...text].length) return
    setBusy(c.原文連結)
    const 配圖 = withImg[c.原文連結] && c.圖片連結 ? '是' : '否'
    const res = await fetch('/api/news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, 圖片連結: c.圖片連結, 配圖, 類型: c.類型, 標題: c.標題, 來源: c.來源, 原文連結: c.原文連結 }),
    })
    const json = await res.json().catch(() => ({}))
    setBusy(null)
    if (res.ok && json.ok) {
      setCandidates((prev) => prev.filter((x) => x.原文連結 !== c.原文連結))
      setPosted((prev) => [
        {
          發文時間: new Date().toLocaleString('zh-TW', { hour12: false }),
          類型: c.類型,
          標題: c.標題,
          來源: c.來源,
          原文連結: c.原文連結,
          發文內容: text,
          Threads連結: json.permalink || '',
        },
        ...prev,
      ])
      alert('已發布到 Threads ✓' + (json.permalink ? '\n' + json.permalink : ''))
    } else {
      alert('發文失敗：' + (json.error || res.status))
    }
  }

  function skip(c: Candidate) {
    setCandidates((prev) => prev.filter((x) => x.原文連結 !== c.原文連結))
  }

  async function saveImage(c: Candidate) {
    if (!c.圖片連結) return
    setSaving(c.原文連結)
    try {
      const res = await fetch('/api/news/save-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 圖片連結: c.圖片連結, 來源: c.來源, 標題: c.標題 }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        alert('存圖失敗：' + (json.error || res.status))
        setSaving(null)
        return
      }
      const blob = await res.blob()
      const name = decodeURIComponent(res.headers.get('X-Filename') || '') || 'news.jpg'

      // Chrome / Edge：跳另存視窗、預設開在桌面
      const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker
      if (picker) {
        try {
          const handle = await picker({ suggestedName: name, startIn: 'desktop' })
          const w = await handle.createWritable()
          await w.write(blob)
          await w.close()
        } catch (err) {
          if ((err as DOMException)?.name === 'AbortError') {
            setSaving(null)
            return // 使用者自己取消，不算失敗
          }
          throw err
        }
      } else {
        // 不支援（如 Safari）：退回一般下載，進「下載」資料夾
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        a.click()
        URL.revokeObjectURL(url)
      }
      setSaved(c.原文連結)
      setTimeout(() => setSaved((v) => (v === c.原文連結 ? null : v)), 2000)
    } catch (e) {
      alert('存圖失敗：' + e)
    }
    setSaving(null)
  }

  async function copy(c: Candidate) {
    const vkey = tab[c.原文連結] ?? '感性'
    const text = drafts[c.原文連結]?.[vkey] ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied(c.原文連結)
      setTimeout(() => setCopied((v) => (v === c.原文連結 ? null : v)), 1500)
    } catch {
      alert('複製失敗，請手動選取')
    }
  }

  function Card(c: Candidate) {
    const id = c.原文連結
    const isBusy = busy === id
    const active = tab[id] ?? '感性'
    const text = drafts[id]?.[active] ?? ''
    const len = [...text].length
    return (
      <article key={id} className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
        <div className="lg:grid lg:grid-cols-2">
          {/* 左：新聞 */}
          <div className="p-5 lg:border-r border-white/10">
            <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
              <span className={`px-2 py-0.5 rounded-full border ${typeColor[c.類型] || 'bg-white/10 text-slate-300 border-white/20'}`}>
                {c.類型 || '未分類'}
              </span>
              <span className="text-slate-500">分數 {c.分數}</span>
              <span className="text-slate-500">{c.來源}</span>
              {c.時間 && <span className="ml-auto text-slate-500">🕒 {c.時間}</span>}
            </div>
            <h3 className="text-lg font-semibold text-white leading-snug mb-2">{c.標題}</h3>
            {c.摘要 && <p className="text-sm text-slate-400 leading-relaxed mb-3">{c.摘要}</p>}
            {c.圖片連結 && (
              <div className="mb-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={c.圖片連結}
                  alt="新聞配圖"
                  className={`rounded-lg max-h-64 w-full object-cover border transition-opacity ${
                    withImg[id] ? 'border-violet-400/50 opacity-100' : 'border-white/10 opacity-40'
                  }`}
                />
                <div className="mt-2 flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={!!withImg[id]}
                      onChange={(e) => setWithImg((m) => ({ ...m, [id]: e.target.checked }))}
                      className="accent-violet-500"
                    />
                    發文時連同這張圖一起發
                  </label>
                  <button
                    onClick={() => saveImage(c)}
                    disabled={saving === id}
                    className="ml-auto rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 px-3 py-1 text-xs text-slate-300"
                  >
                    {saving === id ? '存檔中…' : saved === id ? '已存到桌面 ✓' : '存到桌面'}
                  </button>
                </div>
              </div>
            )}
            {c.原文連結 && (
              <a href={c.原文連結} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-violet-400 hover:text-violet-300 break-all">
                原文：{domainOf(c.原文連結)} ↗
              </a>
            )}
          </div>

          {/* 右：三種建議貼文 */}
          <div className="p-5 bg-black/20">
            <div className="flex gap-1.5 mb-3">
              {VARIANTS.map((v) => (
                <button
                  key={v.key}
                  onClick={() => setTab((t) => ({ ...t, [id]: v.key }))}
                  className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                    active === v.key ? 'bg-violet-600 border-violet-500 text-white' : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <textarea
              value={text}
              onChange={(e) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [active]: e.target.value } }))}
              rows={9}
              className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-slate-200 leading-relaxed outline-none focus:border-violet-400 resize-y"
              placeholder="貼文草稿…"
            />
            <div className="flex items-center gap-2 mt-2">
              <span className={`text-xs ${len > 500 ? 'text-red-400' : 'text-slate-500'}`}>{len}/500</span>
              <button
                onClick={() => publish(c)}
                disabled={isBusy || len === 0 || len > 500}
                className="ml-auto rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium text-white"
              >
                {isBusy ? '發送中…' : '發這則'}
              </button>
              <button onClick={() => copy(c)} className="rounded-lg bg-white/5 hover:bg-white/10 px-3 py-1.5 text-sm text-slate-300">
                {copied === id ? '已複製 ✓' : '複製'}
              </button>
              <button onClick={() => skip(c)} disabled={isBusy} className="rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 px-3 py-1.5 text-sm text-slate-500">
                略過
              </button>
            </div>
          </div>
        </div>
      </article>
    )
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={runFetch}
          disabled={fetching}
          className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium text-white"
        >
          {fetching ? '抓取中…（約 1 分鐘）' : '抓最新新聞'}
        </button>
        {candidates.length > 0 && (
          <div className="flex gap-1.5">
            {([
              ['all', `全部 ${candidates.length}`],
              ['zh', `🇹🇼 中文 ${zh.length}`],
              ['en', `🌐 英文 ${en.length}`],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setLang(k)}
                className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                  lang === k ? 'bg-violet-600 border-violet-500 text-white' : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {candidates.length === 0 && (
        <p className="text-sm text-slate-500">按「抓最新新聞」開始。候選只留在這頁，重新整理就會清掉；發出去的會記在下方。</p>
      )}

      {lang !== 'en' && zh.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-4">🇹🇼 中文新聞（{zh.length}）</h2>
          <div className="space-y-6">{zh.map((c) => Card(c))}</div>
        </section>
      )}

      {lang !== 'zh' && en.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-4">🌐 英文新聞（{en.length}）</h2>
          <div className="space-y-6">{en.map((c) => Card(c))}</div>
        </section>
      )}

      {posted.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-4">已發紀錄（{posted.length}）</h2>
          <div className="space-y-2">
            {posted.slice(0, 30).map((p, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-4 py-2.5 text-sm text-slate-400">
                <span className="truncate">
                  <span className="text-slate-500">{p.發文時間} · {p.來源}</span> · {(p.發文內容 || p.標題).slice(0, 50)}
                </span>
                {p.Threads連結 && (
                  <a href={p.Threads連結} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-violet-400 hover:text-violet-300">
                    看貼文 ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
