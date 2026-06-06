import Link from 'next/link'
import { getCandidates } from '@/lib/sheets'
import HaixunBoard from './HaixunBoard'

export const dynamic = 'force-dynamic'

export default async function HaixunPage() {
  let candidates: Awaited<ReturnType<typeof getCandidates>> = []
  let error = ''
  try {
    candidates = await getCandidates()
  } catch (e) {
    error = String(e)
  }

  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-semibold text-white">Threads 海巡控制台</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
      </div>
      <p className="text-sm text-slate-500 mb-8">
        改完草稿按「核准」，n8n 工作流 B 會自動發出回覆。
      </p>
      {error ? (
        <p className="text-sm text-red-400">讀取失敗：{error}</p>
      ) : (
        <HaixunBoard initial={candidates} />
      )}
    </main>
  )
}
