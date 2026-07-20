'use client'

import { useEffect, useRef, useState } from 'react'

type Template = { id: string; name: string; url: string; box_count: number }

type Layer = {
  id: number
  text: string
  x: number // 佔圖寬的百分比（0-1），指文字方塊中心
  y: number // 佔圖高的百分比（0-1）
  size: number // 字級＝佔圖高的百分比，這樣預覽和匯出才會等比例一致
}

// 中文字型交給瀏覽器的系統字型——這正是不用 Imgflip caption_image 的原因，
// 它只有 Impact/Arial，中文會變成豆腐方塊。
const FONT_STACK =
  '"Noto Sans TC", "PingFang TC", "Heiti TC", "Microsoft JhengHei", "Hiragino Sans GB", sans-serif'
const WRAP_WIDTH = 0.9 // 文字最寬佔圖寬的比例，超過就換行

function initialLayers(texts: string[], boxCount: number): Layer[] {
  const n = Math.max(texts.length, boxCount, 1)
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    text: texts[i] ?? '',
    x: 0.5,
    // 依格數平均分佈在垂直方向，落在每一段的中間
    y: (i + 0.5) / n,
    size: 0.07,
  }))
}

// 中文沒有空白可斷，逐字量測寬度來換行；\n 強制斷行
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const ch of paragraph) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        out.push(line)
        line = ch
      } else {
        line += ch
      }
    }
    out.push(line)
  }
  return out
}

export default function MemeEditor({
  template,
  texts,
  onClose,
}: {
  template: Template
  texts: string[]
  onClose: () => void
}) {
  const [layers, setLayers] = useState<Layer[]>(() => initialLayers(texts, template.box_count))
  const [active, setActive] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  // 字級存的是「佔圖高的比例」，預覽要換算成 px，所以得知道舞台目前多高
  const [stageH, setStageH] = useState(0)
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ id: number; dx: number; dy: number } | null>(null)

  // 拖曳：用百分比存位置，換算時以舞台實際大小為準
  useEffect(() => {
    function move(e: PointerEvent) {
      const d = dragRef.current
      const stage = stageRef.current
      if (!d || !stage) return
      const r = stage.getBoundingClientRect()
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width - d.dx))
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height - d.dy))
      setLayers((ls) => ls.map((l) => (l.id === d.id ? { ...l, x, y } : l)))
    }
    function up() {
      dragRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  // 舞台會隨視窗寬度縮放，跟著更新高度，預覽字級才不會跑掉
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(([entry]) => setStageH(entry.contentRect.height))
    ro.observe(stage)
    return () => ro.disconnect()
  }, [])

  function startDrag(e: React.PointerEvent, l: Layer) {
    const stage = stageRef.current
    if (!stage) return
    const r = stage.getBoundingClientRect()
    dragRef.current = {
      id: l.id,
      dx: (e.clientX - r.left) / r.width - l.x,
      dy: (e.clientY - r.top) / r.height - l.y,
    }
    setActive(l.id)
  }

  function update(id: number, patch: Partial<Layer>) {
    setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  function download() {
    const img = imgRef.current
    if (!img) return
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

    for (const l of layers) {
      if (!l.text.trim()) continue
      const px = l.size * canvas.height
      ctx.font = `700 ${px}px ${FONT_STACK}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      ctx.lineWidth = Math.max(2, px * 0.14)
      ctx.strokeStyle = '#000'
      ctx.fillStyle = '#fff'

      const lines = wrapLines(ctx, l.text, canvas.width * WRAP_WIDTH)
      const lineH = px * 1.18
      const startY = l.y * canvas.height - ((lines.length - 1) * lineH) / 2
      lines.forEach((line, i) => {
        const x = l.x * canvas.width
        const y = startY + i * lineH
        ctx.strokeText(line, x, y)
        ctx.fillText(line, x, y)
      })
    }

    // 圖片沒帶 CORS 載入的話，canvas 會被污染，這裡會直接丟安全性錯誤
    try {
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `meme_${template.name.replace(/[^\w]+/g, '_')}.png`
        a.click()
        URL.revokeObjectURL(url)
      }, 'image/png')
    } catch {
      alert('匯出失敗：圖片跨網域被擋。重新整理頁面再試一次。')
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 p-4" onClick={onClose}>
      <div
        className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-[#0b0b12] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-slate-200">{template.name}</h3>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-200">
            關閉 ✕
          </button>
        </div>

        {/* 畫布：文字可以直接拖 */}
        <div
          ref={stageRef}
          className="relative select-none overflow-hidden rounded-xl bg-black"
          style={{ touchAction: 'none' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={template.url}
            alt={template.name}
            crossOrigin="anonymous"
            onLoad={() => setReady(true)}
            className="block w-full"
          />
          {layers.map((l) =>
            l.text.trim() ? (
              <div
                key={l.id}
                onPointerDown={(e) => startDrag(e, l)}
                className={`absolute cursor-move text-center font-bold leading-tight ${
                  active === l.id ? 'ring-1 ring-violet-400/60' : ''
                }`}
                style={{
                  left: `${l.x * 100}%`,
                  top: `${l.y * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  width: `${WRAP_WIDTH * 100}%`,
                  fontFamily: FONT_STACK,
                  fontSize: `${l.size * stageH}px`,
                  color: '#fff',
                  WebkitTextStroke: '0.06em #000',
                  paintOrder: 'stroke fill',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {l.text}
              </div>
            ) : null
          )}
        </div>

        {/* 每一格的文字與字級 */}
        <div className="mt-4 space-y-3">
          {layers.map((l, i) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-xs text-slate-600">{i + 1}.</span>
              <input
                value={l.text}
                onChange={(e) => update(l.id, { text: e.target.value })}
                onFocus={() => setActive(l.id)}
                placeholder="這一格要寫什麼"
                className="min-w-48 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-violet-400"
              />
              <input
                type="range"
                min={3}
                max={16}
                value={Math.round(l.size * 100)}
                onChange={(e) => update(l.id, { size: Number(e.target.value) / 100 })}
                className="w-24"
                title="字級"
              />
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={download}
            disabled={!ready}
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            下載圖片
          </button>
          <span className="text-xs text-slate-500">文字可以直接拖動；拉桿調字級。下載後到 Threads 附圖。</span>
        </div>
      </div>
    </div>
  )
}
