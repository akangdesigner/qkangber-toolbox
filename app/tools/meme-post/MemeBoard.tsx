'use client'

import { useEffect, useRef, useState } from 'react'

type Meme = { id: string; 圖片連結: string; 頁面連結: string; 標題: string }
type MatchTarget = { 種類: '官網文章' | '新聞'; 標題: string; 摘要: string; 連結: string; 來源: string }
type MatchResult = { 分數: number; 理由: string; 目標: MatchTarget }

// 選定的梗圖：memes.tw 的有公開網址（可自動附圖）；上傳的只有 base64（發文要手動補圖）
type Picked =
  | { kind: 'web'; id: string; url: string; 標題: string }
  | { kind: 'upload'; dataUrl: string }

const kindColor: Record<string, string> = {
  官網文章: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  新聞: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
}

// 上傳圖縮到 1024px 以內再轉 base64（給看圖模型，太大會被擋）
async function fileToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

export default function MemeBoard() {
  const [memes, setMemes] = useState<Meme[]>([])
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(null)

  const [matching, setMatching] = useState(false)
  const [解讀, set解讀] = useState('')
  const [matches, setMatches] = useState<MatchResult[] | null>(null)
  const [scanned, setScanned] = useState('')

  const [drafting, setDrafting] = useState<string | null>(null)
  const [chosen, setChosen] = useState<MatchResult | null>(null)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [permalink, setPermalink] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  async function loadMemes() {
    setLoading(true)
    try {
      const res = await fetch('/api/tools/meme-post/memes')
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? res.status)
      setMemes(json.memes ?? [])
      if ((json.memes ?? []).length === 0) alert('抓不到梗圖')
    } catch (e) {
      alert('抓梗圖失敗：' + e)
    }
    setLoading(false)
  }

  useEffect(() => {
    loadMemes()
  }, [])

  function resetResult() {
    setMatches(null)
    set解讀('')
    setChosen(null)
    setDraft('')
    setPermalink('')
  }

  async function onUpload(file: File) {
    try {
      const dataUrl = await fileToDataUrl(file)
      setPicked({ kind: 'upload', dataUrl })
      resetResult()
    } catch (e) {
      alert('讀取圖片失敗：' + e)
    }
  }

  async function runMatch() {
    if (!picked) return
    setMatching(true)
    resetResult()
    try {
      const body =
        picked.kind === 'web'
          ? { 圖片連結: picked.url, 標題: picked.標題 }
          : { imageBase64: picked.dataUrl }
      const res = await fetch('/api/tools/meme-post/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? res.status)
      set解讀(json.梗圖解讀 ?? '')
      setMatches(json.matches ?? [])
      setScanned(json.掃描 ? `官網文章 ${json.掃描.官網文章} 篇＋新聞 ${json.掃描.新聞} 則` : '')
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (e) {
      alert('配對失敗：' + e)
    }
    setMatching(false)
  }

  async function makeDraft(m: MatchResult) {
    setDrafting(m.目標.連結)
    setPermalink('')
    try {
      const res = await fetch('/api/tools/meme-post/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 梗圖解讀: 解讀, 目標: m.目標, 理由: m.理由 }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? res.status)
      setChosen(m)
      setDraft(json.draft ?? '')
    } catch (e) {
      alert('產草稿失敗：' + e)
    }
    setDrafting(null)
  }

  async function publish() {
    if (!chosen || !draft.trim() || !picked) return
    setPosting(true)
    try {
      const canAttach = picked.kind === 'web'
      const res = await fetch('/api/news', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: draft,
          圖片連結: canAttach ? picked.url : '',
          配圖: canAttach ? '是' : '否',
          類型: '梗圖',
          標題: chosen.目標.標題,
          來源: chosen.目標.來源,
          原文連結: chosen.目標.連結,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) throw new Error(json.error ?? res.status)
      setPermalink(json.permalink || '')
      alert('已發布到 Threads ✓' + (json.permalink ? '\n' + json.permalink : ''))
    } catch (e) {
      alert('發文失敗：' + e)
    }
    setPosting(false)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(draft)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      alert('複製失敗，請手動選取')
    }
  }

  const len = [...draft].length

  return (
    <div className="space-y-8">
      {/* 來源：memes.tw 最新 / 上傳 */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => loadMemes()}
          disabled={loading}
          className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white"
        >
          {loading ? '抓取中…' : '重新整理梗圖'}
        </button>
        <span className="text-xs text-slate-500 flex-1 min-w-40">memes.tw 最新 50 張</span>
        <button
          onClick={() => fileRef.current?.click()}
          className="rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 px-4 py-2 text-sm text-slate-300"
        >
          上傳自己的梗圖
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onUpload(f)
            e.target.value = ''
          }}
        />
      </div>

      {/* 上傳預覽 */}
      {picked?.kind === 'upload' && (
        <div className="rounded-xl border border-violet-400/50 bg-white/[0.03] p-4 flex flex-wrap items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={picked.dataUrl} alt="上傳的梗圖" className="max-h-48 rounded-lg" />
          <div className="text-sm text-slate-400 space-y-2">
            <p>已選擇上傳的梗圖。</p>
            <p className="text-amber-400/80">注意：上傳圖沒有公開網址，一鍵發文只會發文字，圖要自己去 Threads 補。</p>
          </div>
        </div>
      )}

      {/* 梗圖牆 */}
      {memes.length > 0 && (
        <section>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {memes.map((m) => {
              const selected = picked?.kind === 'web' && picked.id === m.id
              return (
                <button
                  key={m.id}
                  onClick={() => {
                    setPicked({ kind: 'web', id: m.id, url: m.圖片連結, 標題: m.標題 })
                    resetResult()
                  }}
                  className={`group relative rounded-xl overflow-hidden border text-left transition-colors ${
                    selected ? 'border-violet-400 ring-2 ring-violet-500/40' : 'border-white/10 hover:border-white/30'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={m.圖片連結}
                    alt={m.標題 || '梗圖'}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="w-full aspect-square object-cover bg-black/40"
                  />
                  {m.標題 && (
                    <span className="absolute bottom-0 inset-x-0 bg-black/60 px-2 py-1 text-[11px] text-slate-300 truncate">
                      {m.標題}
                    </span>
                  )}
                  {selected && (
                    <span className="absolute top-2 right-2 rounded-full bg-violet-600 px-2 py-0.5 text-[11px] text-white">
                      已選 ✓
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="mt-3 text-xs text-slate-600">{memes.length} 張 · 圖片來自 memes.tw</p>
        </section>
      )}

      {/* 確認配對 */}
      {picked && (
        <div className="sticky bottom-4 z-10">
          <button
            onClick={runMatch}
            disabled={matching}
            className="w-full rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-60 px-4 py-3 text-sm font-medium text-white shadow-lg shadow-violet-950/50"
          >
            {matching ? 'AI 看圖＋掃描官網文章和今日新聞中…（約 20-40 秒）' : '就用這張 → 找適合搭配的文章/新聞'}
          </button>
        </div>
      )}

      {/* 配對結果 */}
      {matches && (
        <section ref={resultRef} className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-2">AI 對這張梗圖的解讀{scanned && `（已掃 ${scanned}）`}</h2>
            <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{解讀}</p>
          </div>

          {matches.length === 0 && <p className="text-sm text-slate-500">AI 覺得目前沒有夠搭的內容，換張梗圖試試。</p>}

          {matches.map((m) => (
            <div key={m.目標.連結} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
                <span className={`px-2 py-0.5 rounded-full border ${kindColor[m.目標.種類]}`}>{m.目標.種類}</span>
                <span className={`font-medium ${m.分數 >= 7 ? 'text-emerald-400' : m.分數 >= 5 ? 'text-amber-400' : 'text-slate-500'}`}>
                  搭配度 {m.分數}/10
                </span>
                <span className="text-slate-500">{m.目標.來源}</span>
              </div>
              <h3 className="text-white font-medium mb-1">{m.目標.標題}</h3>
              <p className="text-sm text-slate-400 mb-3">{m.理由}</p>
              <div className="flex items-center gap-2">
                <a href={m.目標.連結} target="_blank" rel="noreferrer" className="text-sm text-violet-400 hover:text-violet-300">
                  看內容 ↗
                </a>
                <button
                  onClick={() => makeDraft(m)}
                  disabled={drafting !== null}
                  className="ml-auto rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium text-white"
                >
                  {drafting === m.目標.連結 ? '寫草稿中…' : chosen?.目標.連結 === m.目標.連結 ? '重寫草稿' : '配這個，寫草稿'}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* 草稿＋發文 */}
      {chosen && (
        <section className="rounded-xl border border-violet-500/30 bg-black/20 p-5">
          <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-3">
            Threads 草稿（梗圖 × {chosen.目標.標題.slice(0, 30)}）
          </h2>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-slate-200 leading-relaxed outline-none focus:border-violet-400 resize-y"
          />
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className={`text-xs ${len > 500 ? 'text-red-400' : 'text-slate-500'}`}>{len}/500</span>
            {picked?.kind === 'upload' && <span className="text-xs text-amber-400/80">上傳圖不會自動附上</span>}
            <button
              onClick={publish}
              disabled={posting || len === 0 || len > 500}
              className="ml-auto rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium text-white"
            >
              {posting ? '發送中…' : picked?.kind === 'web' ? '連圖發 Threads' : '發文字到 Threads'}
            </button>
            <button onClick={copy} className="rounded-lg bg-white/5 hover:bg-white/10 px-3 py-1.5 text-sm text-slate-300">
              {copied ? '已複製 ✓' : '複製'}
            </button>
          </div>
          {permalink && (
            <a href={permalink} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-violet-400 hover:text-violet-300">
              看貼文 ↗
            </a>
          )}
        </section>
      )}
    </div>
  )
}
