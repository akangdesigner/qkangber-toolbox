'use client'

import { useState } from 'react'

type Candidate = {
  rowNumber: number
  日期: string
  類型: string
  分數: string
  作者: string
  貼文ID: string
  貼文連結: string
  貼文內容: string
  AI回覆草稿: string
  狀態: string
}

const typeColor: Record<string, string> = {
  潛在客戶: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  同行同好: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
}

export default function HaixunBoard({ initial }: { initial: Candidate[] }) {
  const [rows, setRows] = useState<Candidate[]>(initial)
  const [drafts, setDrafts] = useState<Record<number, string>>(
    Object.fromEntries(initial.map((c) => [c.rowNumber, c.AI回覆草稿]))
  )
  const [busy, setBusy] = useState<number | null>(null)

  const pending = rows.filter((r) => r.狀態 === '待審')
  const approved = rows.filter((r) => r.狀態 === '核准')

  async function act(c: Candidate, 狀態: string) {
    setBusy(c.rowNumber)
    const 草稿 = drafts[c.rowNumber] ?? c.AI回覆草稿
    const res = await fetch('/api/haixun', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowNumber: c.rowNumber, 草稿, 狀態 }),
    })
    setBusy(null)
    if (res.ok) {
      setRows((prev) => prev.map((r) => (r.rowNumber === c.rowNumber ? { ...r, 狀態, AI回覆草稿: 草稿 } : r)))
    } else {
      alert('更新失敗')
    }
  }

  if (pending.length === 0 && approved.length === 0) {
    return <p className="text-sm text-slate-500">目前沒有待審候選。海巡跑完後會出現在這裡。</p>
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-4">待審（{pending.length}）</h2>
        <div className="space-y-4">
          {pending.map((c) => (
            <article key={c.rowNumber} className="rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex items-center gap-2 mb-3 text-xs">
                <span className={`px-2 py-0.5 rounded-full border ${typeColor[c.類型] || 'bg-white/10 text-slate-300 border-white/20'}`}>
                  {c.類型}
                </span>
                <span className="text-slate-500">分數 {c.分數}</span>
                <span className="text-slate-500">{c.作者}</span>
                {c.貼文連結 && (
                  <a href={c.貼文連結} target="_blank" rel="noreferrer" className="ml-auto text-violet-400 hover:text-violet-300">
                    看原文 ↗
                  </a>
                )}
              </div>
              <p className="text-sm text-slate-300 mb-3 whitespace-pre-wrap">{c.貼文內容}</p>
              <textarea
                value={drafts[c.rowNumber] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [c.rowNumber]: e.target.value }))}
                rows={3}
                className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-slate-200 outline-none focus:border-violet-400 resize-y"
                placeholder="回覆草稿…"
              />
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => act(c, '核准')}
                  disabled={busy === c.rowNumber}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-1.5 text-sm font-medium text-white"
                >
                  {busy === c.rowNumber ? '處理中…' : '核准發送'}
                </button>
                <button
                  onClick={() => act(c, '略過')}
                  disabled={busy === c.rowNumber}
                  className="rounded-lg bg-white/5 hover:bg-white/10 disabled:opacity-50 px-4 py-1.5 text-sm text-slate-300"
                >
                  略過
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {approved.length > 0 && (
        <section>
          <h2 className="text-xs uppercase tracking-widest text-slate-500 mb-4">已核准・等 n8n 發送（{approved.length}）</h2>
          <div className="space-y-2">
            {approved.map((c) => (
              <div key={c.rowNumber} className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-2.5 text-sm text-slate-400">
                <span className="text-slate-500">{c.作者}</span> · {c.AI回覆草稿.slice(0, 60)}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
