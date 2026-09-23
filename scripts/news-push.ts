// 推到 LINE：熱度超過門檻的 AI 話題，加上申請得到的政府補助／徵件公告，沒推過的才推。
// 用法：npx tsx --env-file=.env scripts/news-push.ts [--dry]（--dry 只印不推，也不記錄）
// 由 Windows 工作排程器（見 scripts/news-push-task.vbs）每天跑幾次，不需要 dev server 在跑。
//
// 門檻 NEWS_PUSH_MIN_HEAT（預設 65）：用 2026-09-23 的訊號算，Jev 95、Claude Opus 5.5 69、GPT-6 Sol 67，
// 再下去的 GPT-6 Astra、Grok 4.7 都在 60 以下。65 等於「這週最紅的兩三件事」，不會變成洗版。
// 70 的話 Opus 5.5／GPT-6 同日發表這種大事會差一分沒推到。想調之前先跑 --dry 看會多出或少掉哪些。
//
// 成本：每跑一次要叫一次 LLM 併話題（gpt-4.1 約 US$0.07），有要推的話題才另外寫摘要。
// 一天 4 次約一個月 US$8，別排到每小時。
import { promises as fs } from 'fs'
import path from 'path'
import { govCandidates, trendingTopics, toCandidates } from '../lib/news-fetch'
import { lineConfigured, pushLine, type LineMessage } from '../lib/line'
import type { Candidate } from '../lib/news-fetch'

const MIN_HEAT = Number(process.env.NEWS_PUSH_MIN_HEAT || 65)
// 政府公告另一把尺：8 分以上＝「一人公司／中小企業申請得到的補助或徵件」（評分標準見 lib/news-fetch 的 GOV_PROMPT）。
// 板上是 7 分以上，推播更嚴一點，只推真的能申請的。公告一則只推一次（用網址當 key）。
const GOV_MIN_SCORE = Number(process.env.NEWS_PUSH_GOV_MIN_SCORE || 8)
const REPUSH_DAYS = 7 // 同一個話題 7 天內只推一次（話題本身會紅一整週，每次都推就是洗版）
const LOG = path.join(process.cwd(), 'data', 'news-push', 'pushed.json')
const dry = process.argv.includes('--dry')

type Pushed = Record<string, { 話題: string; 熱度: number; 推播時間: string }>

// 用查詢當 key（「Jev」「Claude Opus 5.5」）：話題名稱是 LLM 每次重寫的，同一件事這次叫「Jev 爆紅」下次叫「Jev 決策模型」
const keyOf = (查詢: string) => 查詢.trim().toLowerCase()

function formatGov(c: Candidate): LineMessage {
  const text = [
    `🏛 政府公告｜${c.標題}`,
    c.截止日 ? `⏰ 截止 ${c.截止日}` : '',
    '',
    c.摘要,
    '',
    `公告：${c.原文連結}`,
  ]
    .filter((l, i, a) => l || (i > 0 && a[i - 1]))
    .join('\n')
  return { type: 'text', text }
}

function format(c: Candidate): LineMessage {
  if (!c.熱度明細) return formatGov(c)
  const h = c.熱度明細
  const signals = [
    h.來源數 > 1 ? `${h.來源數} 個來源` : '',
    h.hn ? `HN ${h.hn} 分` : '',
    h.新聞 ? `${h.新聞} 篇報導` : '',
    h.搜尋 ? `搜尋量 Claude AI 的 ${Math.round(h.搜尋 * 100)}%` : '',
  ].filter(Boolean)
  const text = [
    `🔥 熱度 ${c.分數}｜${c.中文標題 || c.話題}`,
    signals.join('・'),
    '',
    c.摘要,
    '',
    `原文：${c.原文連結}`,
    c.中文報導 ? `中文報導：${c.中文報導.連結}` : '',
    c.適合改寫 && c.改寫建議 ? `\n✍️ ${c.改寫建議}` : '',
  ]
    .filter((l, i, a) => l || (i > 0 && a[i - 1])) // 拿掉連續空行
    .join('\n')
  return { type: 'text', text }
}

async function main() {
  const now = new Date()
  if (!dry && !lineConfigured()) throw new Error('.env 沒設 LINE_CHANNEL_ACCESS_TOKEN／LINE_USER_ID（先用 --dry 測）')
  const pushed: Pushed = JSON.parse(await fs.readFile(LOG, 'utf8').catch(() => '{}'))

  const [{ topics }, gov] = await Promise.all([trendingTopics(), govCandidates()])
  const hot = topics.filter((t) => t.熱度 >= MIN_HEAT)
  const recent = (key: string) => {
    const p = pushed[key]
    return p && now.getTime() - Date.parse(p.推播時間) <= REPUSH_DAYS * 86400_000
  }
  const fresh = hot.filter((t) => !recent(keyOf(t.查詢)))
  // 公告不設 7 天過期：同一則公告推過就永遠不再推
  const govFresh = gov.items.filter((c) => c.分數 >= GOV_MIN_SCORE && !pushed[c.原文連結])
  console.log(
    `[news-push] ${now.toISOString()} 話題 ${topics.length}，熱度 ≥ ${MIN_HEAT} 的 ${hot.length} 個` +
      `（${hot.map((t) => `${t.話題} ${t.熱度}`).join('、') || '無'}），沒推過的 ${fresh.length} 個；` +
      `政府公告 ${gov.items.length} 則過板上門檻，≥ ${GOV_MIN_SCORE} 分沒推過的 ${govFresh.length} 則${dry ? '（--dry）' : ''}`
  )
  if (!fresh.length && !govFresh.length) return

  const cands = [...(await toCandidates(fresh)), ...govFresh]
  const messages = cands.map(format)
  if (dry) {
    for (const m of messages) console.log('\n' + m.text)
    return
  }
  await pushLine(messages)
  for (const t of fresh) pushed[keyOf(t.查詢)] = { 話題: t.話題, 熱度: t.熱度, 推播時間: now.toISOString() }
  for (const c of govFresh) pushed[c.原文連結] = { 話題: c.標題, 熱度: c.分數, 推播時間: now.toISOString() }
  await fs.mkdir(path.dirname(LOG), { recursive: true })
  await fs.writeFile(LOG, JSON.stringify(pushed, null, 2))
  console.log(`[news-push] 推了 ${messages.length} 則`)
}

main().catch((e) => {
  console.error('[news-push] 失敗：', e)
  process.exitCode = 1 // 非零讓工作排程器知道要重跑
})
