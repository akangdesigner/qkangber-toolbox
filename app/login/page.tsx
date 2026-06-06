'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setErr('')
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    setLoading(false)
    if (res.ok) {
      router.push(params.get('next') || '/')
      router.refresh()
    } else {
      setErr('密碼錯誤')
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-xs flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-white">Q kangber 工具箱</h1>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="密碼"
        autoFocus
        className="rounded-lg bg-white/5 border border-white/10 px-4 py-2.5 text-sm outline-none focus:border-violet-400"
      />
      {err && <p className="text-sm text-red-400">{err}</p>}
      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2.5 text-sm font-medium text-white transition-colors"
      >
        {loading ? '登入中…' : '登入'}
      </button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  )
}
