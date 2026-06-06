import Link from 'next/link'

const tools = [
  { href: '/haixun', title: 'Threads 海巡控制台', desc: '審核候選、編輯草稿、一鍵核准發送', ready: true },
  { href: '#', title: 'HTML 文章編輯器', desc: '（階段 2 搬移中）', ready: false },
  { href: '#', title: '社群貼文產生器', desc: '（階段 2 搬移中）', ready: false },
]

export default function Dashboard() {
  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-10">
        <h1 className="text-2xl font-semibold text-white">Q kangber 工具箱</h1>
        <form action="/api/logout" method="post">
          <button className="text-sm text-slate-400 hover:text-slate-200" formAction="/api/logout">登出</button>
        </form>
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
