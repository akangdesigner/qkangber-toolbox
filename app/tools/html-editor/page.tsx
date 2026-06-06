'use client'

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import Link from 'next/link'

const DEFAULT_HTML = `<h2>文章標題</h2>
<p>將你的 HTML 文章貼入左側，工具會自動偵測截圖佔位符。</p>
<p>佔位符格式：包含 📸 的 div 區塊，例如：</p>

<!-- 截圖：示範 -->
<div style="border: 2px dashed #ccc; background: #f9f9f9; padding: 48px 24px; text-align: center; margin: 24px 0; color: #aaa; border-radius: 8px;">
  📸 截圖：示範用的佔位符說明
</div>

<p>點擊右側卡片選取佔位符後，截圖並按 <strong>Ctrl+V</strong> 即可取代。</p>`

const TODAY = new Date().toISOString().slice(0, 10)

type FilledSlot = { text: string; thumb: string }
type Slot = { key: string; text: string }
type AsyncState = { phase: 'idle' | 'loading' | 'ok' | 'err'; msg?: string; needsLogin?: boolean }
type Meta = { slug: string; title: string; date: string; tags: string; category: string; coverImage: string; published: boolean }

const SLOT_RE = /<div[^>]*>([^<]*📸[^<]*)<\/div>/gi
const BASE64_RE = /src="data:image\/[^;]+;base64,[^"]+"/gi

function detectSlots(html: string): Slot[] {
  const results: Slot[] = []
  const re = new RegExp(SLOT_RE.source, 'gi')
  let m
  while ((m = re.exec(html)) !== null) {
    results.push({ key: m[0], text: m[1].trim() })
  }
  return results
}

function countBase64(html: string): number {
  return (html.match(new RegExp(BASE64_RE.source, 'gi')) ?? []).length
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target?.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target?.result as string)
    reader.onerror = reject
    reader.readAsText(file, 'utf-8')
  })
}

function buildPreviewDoc(body: string) {
  return `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Noto Sans TC',sans-serif;font-size:16px;line-height:1.85;color:#1f2937;padding:28px 32px;max-width:760px;margin:0 auto;background:#fff}
  img{max-width:100%;height:auto;border-radius:8px;margin:16px 0;display:block}
  h1{font-size:1.875rem}h2{font-size:1.5rem}h3{font-size:1.2rem}
  h1,h2,h3,h4{line-height:1.35;margin:1.8em 0 .6em;color:#111827;font-weight:700}
  p{margin:.85em 0}a{color:#6366f1}
  code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:.85em}
  pre{background:#f3f4f6;padding:16px 20px;border-radius:8px;overflow-x:auto;font-size:.875em}
  blockquote{border-left:4px solid #6366f1;padding:8px 16px;color:#6b7280;margin:1.2em 0;background:#f9fafb;border-radius:0 6px 6px 0}
  ul,ol{padding-left:1.6em;margin:.85em 0}li{margin:.35em 0}
  hr{border:none;border-top:1px solid #e5e7eb;margin:2em 0}
  table{border-collapse:collapse;width:100%}td,th{border:1px solid #e5e7eb;padding:8px 14px}th{background:#f9fafb;font-weight:600}
</style></head>
<body>${body}</body></html>`
}

function normalizeHighlightColor(html: string): string {
  return html.replace(/#c0392b/gi, '#fbbf24')
}

function extractFromFullHtml(raw: string): { content: string; title: string } | null {
  if (!/<html/i.test(raw)) return null
  const contentMatch = raw.match(/<div id="article-content">([\s\S]*?)<\/div>\s*(?:<\/body>|<script)/)
  if (!contentMatch) return null
  const content = contentMatch[1].trim()
  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : ''
  return { content, title }
}

const inputCls = 'w-full px-3 py-2 rounded-lg text-sm text-white bg-white/[0.04] border border-white/[0.07] outline-none focus:border-violet-500/50 transition-colors placeholder-slate-700'

function ErrorStrip({ state, onClose }: { state: AsyncState; onClose: () => void }) {
  return (
    <div className="mb-4 px-4 py-2.5 rounded-xl text-sm flex items-center gap-2.5"
      style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#f87171' }}>
      <span>✕</span>
      <span className="flex-1">
        {state.msg}
        {state.needsLogin && (
          <>
            {' '}
            <Link href="/login" className="underline font-semibold text-red-300 hover:text-red-200">
              前往登入 →
            </Link>
          </>
        )}
      </span>
      <button onClick={onClose} className="text-red-900 hover:text-red-700 text-xs">✕</button>
    </div>
  )
}

export default function HtmlEditorPage() {
  const [html, setHtml] = useState(DEFAULT_HTML)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [filledSlots, setFilledSlots] = useState<Record<string, FilledSlot>>({})
  const [rightTab, setRightTab] = useState<'slots' | 'preview' | 'publish'>('slots')
  const [copied, setCopied] = useState(false)
  const [copiedRich, setCopiedRich] = useState(false)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const [upload, setUpload] = useState<AsyncState>({ phase: 'idle' })
  const [sync, setSync] = useState<AsyncState>({ phase: 'idle' })
  const [meta, setMeta] = useState<Meta>({
    slug: '', title: '', date: TODAY, tags: '', category: '開發日記', coverImage: '', published: true,
  })
  const [folderState, setFolderState] = useState<AsyncState>({ phase: 'idle' })
  const folderInputRef = useRef<HTMLInputElement>(null)

  const htmlRef = useRef(html)
  const activeKeyRef = useRef(activeKey)
  useEffect(() => { htmlRef.current = html }, [html])
  useEffect(() => { activeKeyRef.current = activeKey }, [activeKey])

  const unfilled = useMemo(() => detectSlots(html), [html])
  const filledCount = Object.keys(filledSlots).length
  const totalCount = unfilled.length + filledCount
  const base64Count = useMemo(() => countBase64(html), [html])

  async function handleFolderSelect(files: FileList) {
    setFolderState({ phase: 'loading' })
    try {
      let htmlFile: File | null = null
      const imageFiles = new Map<string, File>()
      for (const file of Array.from(files)) {
        const name = file.name.toLowerCase()
        if (name.endsWith('.html') && !file.name.startsWith('.')) {
          htmlFile = file
        } else if (/\.(png|jpg|jpeg|gif|webp)$/i.test(name)) {
          imageFiles.set(file.name, file)
        }
      }
      if (!htmlFile) throw new Error('資料夾裡找不到 .html 檔案')

      let rawHtml = await readAsText(htmlFile)
      for (const [name, file] of imageFiles) {
        const b64 = await readAsBase64(file)
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        rawHtml = rawHtml.replace(new RegExp(`src="${esc}"`, 'g'), `src="${b64}"`)
        rawHtml = rawHtml.replace(new RegExp(`src='${esc}'`, 'g'), `src='${b64}'`)
      }

      const extracted = extractFromFullHtml(rawHtml)
      const content = normalizeHighlightColor(extracted ? extracted.content : rawHtml)
      const title = extracted?.title ?? ''

      setHtml(content)
      if (title) setMeta((p) => ({ ...p, title: p.title || title }))
      setFolderState({ phase: 'idle' })

      if (imageFiles.size > 0) {
        setUpload({ phase: 'loading' })
        const res = await fetch('/api/tools/html-editor/upload-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: content }),
        })
        const json = await res.json()
        if (!res.ok) {
          setUpload({ phase: 'err', msg: json.error, needsLogin: res.status === 401 })
          setRightTab('publish')
          return
        }
        setHtml(json.html)
        setUpload({ phase: 'ok', msg: `${json.uploaded} 張截圖已上傳，網址已替換完成` })
      }

      setRightTab('publish')
    } catch (err) {
      setFolderState({ phase: 'err', msg: err instanceof Error ? err.message : '讀取失敗' })
    }
  }

  function handleHtmlChange(value: string) {
    const extracted = extractFromFullHtml(value)
    if (extracted) {
      setHtml(normalizeHighlightColor(extracted.content))
      setMeta((prev) => ({ ...prev, title: prev.title || extracted.title }))
      setRightTab('publish')
      return
    }
    setHtml(value)
  }

  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const key = activeKeyRef.current
      if (!key) return
      const imgItem = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
      if (!imgItem) return
      e.preventDefault()
      const file = imgItem.getAsFile()
      if (!file) return

      const src = await readAsBase64(file)
      const currentHtml = htmlRef.current
      const slots = detectSlots(currentHtml)
      const slot = slots.find((s) => s.key === key)
      if (!slot) { setActiveKey(null); return }

      const altText = slot.text.replace(/📸\s*截圖[：:]\s*/, '').trim()
      setHtml(currentHtml.replace(slot.key, `<img src="${src}" alt="${altText}" style="max-width:100%;">`))
      setFilledSlots((prev) => ({ ...prev, [slot.text]: { text: slot.text, thumb: src } }))
      setFlashKey(slot.text)
      setTimeout(() => setFlashKey(null), 1500)
      const remaining = slots.filter((s) => s.key !== key)
      setActiveKey(remaining.length > 0 ? remaining[0].key : null)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(html)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }, [html])

  const handleCopyRichText = useCallback(async () => {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([html], { type: 'text/plain' }),
      }),
    ])
    setCopiedRich(true)
    setTimeout(() => setCopiedRich(false), 2500)
  }, [html])

  async function handleUpload() {
    setUpload({ phase: 'loading' })
    try {
      const res = await fetch('/api/tools/html-editor/upload-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      })
      const json = await res.json()
      if (!res.ok) {
        setUpload({ phase: 'err', msg: json.error, needsLogin: res.status === 401 })
        return
      }
      setHtml(json.html)
      setUpload({ phase: 'ok', msg: `${json.uploaded} 張截圖已上傳至 imgbb，網址已替換完成` })
    } catch (err) {
      setUpload({ phase: 'err', msg: err instanceof Error ? err.message : '上傳失敗' })
    }
  }

  async function handleSync() {
    if (!meta.slug.trim() || !meta.title.trim()) {
      setSync({ phase: 'err', msg: 'slug 和標題為必填' })
      return
    }
    setSync({ phase: 'loading' })
    try {
      const res = await fetch('/api/tools/html-editor/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: meta.slug,
          title: meta.title,
          date: meta.date,
          tags: meta.tags,
          published: meta.published,
          html,
          category: meta.category,
          coverImage: meta.coverImage,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setSync({ phase: 'err', msg: json.error, needsLogin: res.status === 401 })
        return
      }
      setSync({ phase: 'ok', msg: `文章已${json.action === 'updated' ? '更新' : '新增'}到 Google Sheets ✓` })
    } catch (err) {
      setSync({ phase: 'err', msg: err instanceof Error ? err.message : '同步失敗' })
    }
  }

  const cursorRef = useRef(0)
  const trackCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    cursorRef.current = e.currentTarget.selectionStart
  }

  return (
    <main className="relative max-w-[1440px] mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 mb-5 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1.5">
            <h1 className="text-2xl sm:text-3xl font-semibold text-white tracking-[-0.02em]">HTML 文章編輯器</h1>
            <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
          </div>
          <p className="text-slate-400 text-sm">
            選取草稿資料夾（HTML + 截圖）→ 自動處理圖片 → 填妥 slug / tags → 一鍵發布到 Google Sheets
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-shrink-0 flex-wrap">
          <input
            ref={folderInputRef}
            type="file"
            // @ts-expect-error webkitdirectory is not in React types
            webkitdirectory=""
            multiple
            className="hidden"
            onChange={(e) => e.target.files && handleFolderSelect(e.target.files)}
          />

          <button
            onClick={() => folderInputRef.current?.click()}
            disabled={folderState.phase === 'loading'}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#6366f1)', color: '#fff', border: '1px solid transparent', boxShadow: '0 0 20px rgba(124,58,237,0.3)' }}>
            {folderState.phase === 'loading' ? (
              <span className="flex items-center gap-2">
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                處理中…
              </span>
            ) : '📁 選取草稿資料夾'}
          </button>

          <span className="text-xs text-slate-700 hidden sm:block tabular-nums">{html.length.toLocaleString()} 字元</span>

          {base64Count > 0 && (
            <button
              onClick={handleUpload}
              disabled={upload.phase === 'loading'}
              className="px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50"
              style={{ background: 'rgba(99,102,241,0.15)', color: '#a5b4fc', border: '1px solid rgba(99,102,241,0.35)' }}>
              {upload.phase === 'loading' ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin" />
                  上傳中…
                </span>
              ) : `上傳截圖取得網址 (${base64Count})`}
            </button>
          )}

          <button onClick={handleCopy}
            className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all"
            style={{
              background: copied ? 'rgba(34,197,94,0.15)' : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
              color: copied ? '#4ade80' : '#fff',
              border: copied ? '1px solid rgba(34,197,94,0.3)' : '1px solid transparent',
              boxShadow: copied ? 'none' : '0 0 20px rgba(99,102,241,0.25)',
            }}>
            {copied ? '✓ 已複製 HTML' : '複製完整 HTML'}
          </button>
        </div>
      </div>

      {folderState.phase === 'err' && (
        <ErrorStrip state={folderState} onClose={() => setFolderState({ phase: 'idle' })} />
      )}
      {upload.phase === 'ok' && (
        <div className="mb-4 px-4 py-2.5 rounded-xl text-sm flex items-center gap-2.5"
          style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80' }}>
          <span>✓</span><span className="flex-1">{upload.msg}</span>
          <button onClick={() => setUpload({ phase: 'idle' })} className="text-green-800 hover:text-green-600 text-xs">✕</button>
        </div>
      )}
      {upload.phase === 'err' && (
        <ErrorStrip state={upload} onClose={() => setUpload({ phase: 'idle' })} />
      )}

      {activeKey && (
        <div className="mb-4 px-4 py-3 rounded-xl text-sm flex items-center gap-3"
          style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.35)', color: '#a5b4fc' }}>
          <span>📋</span>
          <span className="flex-1">
            佔位符已選取 ── 截圖後回到此頁按{' '}
            <kbd className="px-1.5 py-0.5 rounded text-xs font-mono"
              style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)' }}>
              Ctrl+V
            </kbd>
          </span>
          <button onClick={() => setActiveKey(null)} className="text-slate-600 hover:text-slate-400 text-xs">取消</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:h-[68vh] lg:min-h-[520px]">
        <div className="flex flex-col h-56 sm:h-72 lg:h-auto lg:min-h-0 rounded-2xl overflow-hidden"
          style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="flex items-center gap-3 px-4 py-2.5 flex-shrink-0"
            style={{ background: 'rgba(255,255,255,0.025)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex gap-1.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-2.5 h-2.5 rounded-full" style={{ background: 'rgba(255,255,255,0.12)' }} />
              ))}
            </div>
            <span className="text-xs text-slate-500">HTML 編輯器 — 支援貼入完整草稿 HTML</span>
            {base64Count > 0 && (
              <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full"
                style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.2)' }}>
                {base64Count} 張截圖待上傳
              </span>
            )}
          </div>
          <textarea
            value={html}
            onChange={(e) => { handleHtmlChange(e.target.value); trackCursor(e) }}
            onKeyUp={trackCursor}
            onMouseUp={trackCursor}
            onBlur={trackCursor}
            className="flex-1 w-full resize-none focus:outline-none font-mono text-sm min-h-0"
            style={{ background: '#0d1117', color: '#c9d1d9', padding: '14px 16px', lineHeight: '1.75' }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col h-[420px] sm:h-[480px] lg:h-auto lg:min-h-0 gap-3">
          <div className="flex gap-1.5 flex-shrink-0 flex-wrap">
            {([
              { id: 'slots' as const, label: totalCount > 0 ? `📸 截圖佔位符 (${filledCount}/${totalCount})` : '📸 截圖佔位符' },
              { id: 'preview' as const, label: '即時預覽' },
              { id: 'publish' as const, label: sync.phase === 'ok' ? '✓ 已發布' : '發布到 Sheets' },
            ]).map(({ id, label }) => (
              <button key={id} onClick={() => setRightTab(id)}
                className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
                style={{
                  background: rightTab === id ? 'rgba(99,102,241,0.18)' : 'rgba(255,255,255,0.03)',
                  color: rightTab === id ? '#a5b4fc' : '#64748b',
                  border: `1px solid ${rightTab === id ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.07)'}`,
                }}>
                {label}
              </button>
            ))}
          </div>

          {rightTab === 'slots' && (
            <div className="flex-1 min-h-0 rounded-2xl overflow-y-auto"
              style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.01)' }}>
              {totalCount === 0 ? (
                <div className="flex flex-col items-center justify-center h-full gap-3 px-8 text-center">
                  <span className="text-4xl opacity-25">📸</span>
                  <p className="text-slate-500 text-sm">尚未偵測到截圖佔位符</p>
                  <p className="text-slate-700 text-xs leading-relaxed max-w-xs">
                    在 HTML 中加入含有 📸 的 div 即可，例如：<br />
                    <code className="mt-1 block font-mono text-slate-600 text-[11px] leading-loose">
                      {'<div style="border:2px dashed #ccc;...'}<br />
                      {'  📸 截圖：說明文字'}<br />
                      {'</div>'}
                    </code>
                  </p>
                </div>
              ) : (
                <div className="p-4 space-y-2.5">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.07)' }}>
                      <div className="h-full rounded-full transition-all duration-700"
                        style={{ width: totalCount > 0 ? `${(filledCount / totalCount) * 100}%` : '0%', background: 'linear-gradient(90deg,#6366f1,#22c55e)' }} />
                    </div>
                    <span className="text-xs text-slate-600 flex-shrink-0 tabular-nums">{filledCount} / {totalCount} 完成</span>
                  </div>

                  {unfilled.map((slot, idx) => {
                    const isActive = activeKey === slot.key
                    return (
                      <button key={slot.key} type="button"
                        onClick={() => setActiveKey(isActive ? null : slot.key)}
                        className="w-full text-left rounded-xl transition-all duration-150"
                        style={{
                          padding: '12px 14px',
                          background: isActive ? 'rgba(99,102,241,0.1)' : 'rgba(255,255,255,0.025)',
                          border: `1px solid ${isActive ? 'rgba(99,102,241,0.55)' : 'rgba(255,255,255,0.07)'}`,
                          boxShadow: isActive ? '0 0 0 3px rgba(99,102,241,0.12)' : 'none',
                        }}>
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold"
                            style={{ background: isActive ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.06)', color: isActive ? '#a5b4fc' : '#475569' }}>
                            {idx + filledCount + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-300 truncate">{slot.text.replace(/^📸\s*/, '')}</p>
                            <p className="text-[11px] mt-0.5" style={{ color: isActive ? '#818cf8' : '#374151' }}>
                              {isActive ? '◉ 已選取 — 截圖後按 Ctrl+V' : '點擊選取'}
                            </p>
                          </div>
                          <div className="flex-shrink-0 w-16 h-11 rounded-lg flex items-center justify-center"
                            style={{ border: `1.5px dashed ${isActive ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.1)'}`, background: isActive ? 'rgba(99,102,241,0.06)' : 'rgba(255,255,255,0.02)' }}>
                            <span className="text-xl opacity-30">📷</span>
                          </div>
                        </div>
                      </button>
                    )
                  })}

                  {Object.entries(filledSlots).map(([text, slot]) => {
                    const isFlashing = flashKey === text
                    return (
                      <div key={text} className="w-full rounded-xl transition-all duration-300"
                        style={{ padding: '12px 14px', background: isFlashing ? 'rgba(34,197,94,0.1)' : 'rgba(34,197,94,0.04)', border: `1px solid ${isFlashing ? 'rgba(34,197,94,0.4)' : 'rgba(34,197,94,0.15)'}` }}>
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-sm"
                            style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80' }}>✓</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-400 truncate">{text.replace(/^📸\s*/, '')}</p>
                            <p className="text-[11px] text-green-700 mt-0.5">已貼入截圖</p>
                          </div>
                          <div className="flex-shrink-0 w-16 h-11 rounded-lg overflow-hidden" style={{ boxShadow: '0 0 0 1px rgba(34,197,94,0.25)' }}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={slot.thumb} alt="已貼入的截圖縮圖" className="w-full h-full object-cover" />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {rightTab === 'preview' && (
            <div className="flex-1 flex flex-col min-h-0 rounded-2xl overflow-hidden"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="flex items-center gap-2.5 px-4 py-2.5 flex-shrink-0"
                style={{ background: 'rgba(255,255,255,0.025)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="w-2 h-2 rounded-full" style={{ background: '#22c55e' }} />
                <span className="text-xs text-slate-500">即時預覽</span>
                <button
                  onClick={handleCopyRichText}
                  className="ml-auto px-3 py-1 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: copiedRich ? 'rgba(34,197,94,0.15)' : 'rgba(255,255,255,0.06)',
                    color: copiedRich ? '#4ade80' : '#64748b',
                    border: `1px solid ${copiedRich ? 'rgba(34,197,94,0.3)' : 'rgba(255,255,255,0.08)'}`,
                  }}>
                  {copiedRich ? '✓ 已複製' : '複製預覽內容'}
                </button>
              </div>
              <iframe
                srcDoc={buildPreviewDoc(html)}
                className="flex-1 w-full min-h-0"
                style={{ border: 'none', background: '#fff' }}
                sandbox="allow-same-origin"
                title="HTML 預覽"
              />
            </div>
          )}

          {rightTab === 'publish' && (
            <div className="flex-1 min-h-0 rounded-2xl overflow-y-auto"
              style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.01)' }}>
              <div className="p-5 space-y-4">
                <p className="text-xs text-slate-600 leading-relaxed">
                  貼入草稿 HTML 後，標題會自動填入。補上 slug、tags 後一鍵同步到 Google Sheets。
                </p>

                <div>
                  <label className="block text-[11px] text-slate-500 mb-1.5 uppercase tracking-wider">Slug <span className="text-red-500">*</span></label>
                  <input value={meta.slug} onChange={(e) => setMeta((p) => ({ ...p, slug: e.target.value }))} placeholder="gsc-rank-tracker" className={inputCls} />
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 mb-1.5 uppercase tracking-wider">標題 <span className="text-red-500">*</span></label>
                  <input value={meta.title} onChange={(e) => setMeta((p) => ({ ...p, title: e.target.value }))} placeholder="文章完整標題" className={inputCls} />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1.5 uppercase tracking-wider">日期</label>
                    <input type="date" value={meta.date} onChange={(e) => setMeta((p) => ({ ...p, date: e.target.value }))} className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1.5 uppercase tracking-wider">分類</label>
                    <input value={meta.category} onChange={(e) => setMeta((p) => ({ ...p, category: e.target.value }))} placeholder="開發日記" className={inputCls} />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 mb-1.5 uppercase tracking-wider">Tags（逗號分隔）</label>
                  <input value={meta.tags} onChange={(e) => setMeta((p) => ({ ...p, tags: e.target.value }))} placeholder="n8n,Claude Code,SEO" className={inputCls} />
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 mb-1.5 uppercase tracking-wider">封面圖路徑</label>
                  <input value={meta.coverImage} onChange={(e) => setMeta((p) => ({ ...p, coverImage: e.target.value }))} placeholder="/images/blog/screenshot-xxx.png" className={inputCls} />
                </div>

                <label className="flex items-center gap-3 cursor-pointer">
                  <div
                    onClick={() => setMeta((p) => ({ ...p, published: !p.published }))}
                    className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
                    style={{ background: meta.published ? '#6366f1' : 'rgba(255,255,255,0.1)' }}>
                    <div className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform" style={{ left: meta.published ? '18px' : '2px' }} />
                  </div>
                  <span className="text-sm text-slate-400">立即發布</span>
                </label>

                {sync.phase === 'ok' && (
                  <div className="px-4 py-3 rounded-xl text-sm flex items-center gap-2"
                    style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80' }}>
                    <span>✓</span><span>{sync.msg}</span>
                  </div>
                )}
                {sync.phase === 'err' && (
                  <div className="px-4 py-3 rounded-xl text-sm flex items-center gap-2"
                    style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#f87171' }}>
                    <span>✕</span>
                    <span className="flex-1">{sync.msg}</span>
                  </div>
                )}

                <button
                  onClick={handleSync}
                  disabled={sync.phase === 'loading'}
                  className="w-full py-3 rounded-xl text-sm font-semibold transition-all disabled:opacity-50"
                  style={{
                    background: sync.phase === 'ok' ? 'rgba(34,197,94,0.15)' : 'linear-gradient(135deg,#6366f1,#8b5cf6)',
                    color: sync.phase === 'ok' ? '#4ade80' : '#fff',
                    border: sync.phase === 'ok' ? '1px solid rgba(34,197,94,0.3)' : '1px solid transparent',
                    boxShadow: sync.phase === 'ok' ? 'none' : '0 0 24px rgba(99,102,241,0.3)',
                  }}>
                  {sync.phase === 'loading' ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      同步中…
                    </span>
                  ) : sync.phase === 'ok' ? '✓ 已同步到 Google Sheets' : '同步到 Google Sheets'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}
