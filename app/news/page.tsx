import Link from 'next/link'
import { getPostedLog } from '@/lib/news'
import NewsBoard from './NewsBoard'

export const dynamic = 'force-dynamic'

export default async function NewsPage() {
  let history: Awaited<ReturnType<typeof getPostedLog>> = []
  let error = ''
  try {
    history = await getPostedLog()
  } catch (e) {
    error = String(e)
  }

  return (
    <main className="max-w-5xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-semibold text-white">新聞轉發控制台</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
      </div>
      <p className="text-sm text-slate-500 mb-8">
        按「抓最新新聞」抓兩天內的科技新聞（候選只留在這頁、不存表）。挑風格改完按「發這則」貼到 Threads，發出去的才會記錄。
      </p>
      {error && <p className="text-sm text-red-400 mb-4">發文紀錄讀取失敗：{error}</p>}
      <NewsBoard history={history} />
    </main>
  )
}
