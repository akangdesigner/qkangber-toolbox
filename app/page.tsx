import Link from 'next/link'

const tools = [
  { href: '/news', title: '新聞轉發控制台', desc: '看候選新聞、改草稿、直接發 Threads 或複製自己發', ready: true },
  { href: '/haixun', title: 'Threads 海巡控制台', desc: '審核候選、編輯草稿、一鍵核准發送', ready: true },
  { href: '/tools/html-editor', title: 'HTML 文章編輯器', desc: '草稿轉圖床、一鍵發布到 Google Sheets', ready: true },
  { href: '/tools/social-post', title: '社群貼文產生器', desc: '長文拆成主貼文＋第一則留言', ready: true },
]

export default function Dashboard() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-2xl font-semibold text-white">Q kangber 工具箱</h1>
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        {tools.map((t) => (
          <Link
            key={t.title}
            href={t.ready ? t.href : '#'}
            className={`rounded-xl border border-white/10 bg-white/[0.03] p-5 transition-colors ${
              t.ready ? 'hover:border-violet-400/50 hover:bg-white/[0.06]' : 'opacity-50 pointer-events-none'
            }`}
          >
            <h2 className="text-white font-medium mb-1">{t.title}</h2>
            <p className="text-sm text-slate-400">{t.desc}</p>
          </Link>
        ))}
      </div>
    </main>
  )
}
