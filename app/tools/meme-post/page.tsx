import Link from 'next/link'
import MemeBoard from './MemeBoard'

export const metadata = { title: '梗圖配文控制台' }

export default function MemePostPage() {
  return (
    <main className="relative max-w-5xl mx-auto px-4 sm:px-6 py-12">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl sm:text-3xl font-semibold text-white tracking-[-0.02em]">梗圖配文控制台</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
      </div>
      <p className="text-slate-400 mb-8">
        挑一張梗圖，AI 看圖解讀之後，從官網文章和今天的科技新聞裡找出最搭的內容，寫好 Threads 草稿一鍵發文。
      </p>
      <MemeBoard />
    </main>
  )
}
