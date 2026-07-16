import Link from 'next/link'

const tools = [
  { href: '/watch', title: '自選股健檢', desc: '輸入台股代號，盤後日K自動算均線/KD/MACD，紅綠燈看多空', ready: true },
  { href: '/news', title: '新聞轉發控制台', desc: '看候選新聞、改草稿、直接發 Threads 或複製自己發', ready: true },
  { href: '/tools/social-post', title: '社群貼文產生器', desc: '長文拆成主貼文＋第一則留言', ready: true },
  { href: '/tools/idea-spark', title: '創業靈感雷達', desc: '時事點子庫（n8n 每天掃民生新聞評工具化/商機）＋Show HN 靈感', ready: true },
  { href: '/tools/memory-bot', title: '思念機器人', desc: '匯入真實 LINE 對話，跟「像那個人」的 AI 聊天（v0）', ready: true },
  { href: '/tools/werewolf', title: '狼人殺筆記', desc: '錄音自動轉逐字稿，AI 判狼＋賽後復盤，教訓越存越準', ready: true },
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
