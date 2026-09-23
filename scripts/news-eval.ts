// 新聞板驗收：拿「那週真正紅的話題」對照新聞板的熱度排序，算召回率。
// 用法：npx tsx scripts/news-eval.ts [data/news-eval/某天.json]（預設用最新一份）
//
// 為什麼要有這支：新聞抓取改了十幾版，每版只驗「抓到幾則、每條來源收下幾則」，
// 從來沒問過「這週最紅的東西有沒有上板」——2026-09-23 一對，9 個熱門話題只上 2 個，最熱的 Jev 沒上。
// 改 lib/news-fetch.ts 或 lib/news-trending.ts 之前後都要跑一次，把數字寫進 commit message。
//
// 注意：對照檔是某一週的標準答案，隔越久來源裡的文章越少（7 天窗口），分數會自然往下掉。
// 過了那週就另外寫一份新的，不要拿舊的硬比。
import { promises as fs } from 'fs'
import path from 'path'
import { trendingTopics } from '../lib/news-fetch'

type Fixture = {
  第一名: string
  前幾名內: number
  召回門檻: number
  話題: { 名稱: string; 比對: string }[]
}

const TOP_N = 12 // 跟 lib/news-fetch 的 WRITE_CAP 一樣：板上看得到的就是前 12 個

async function main() {
  const dir = path.join(process.cwd(), 'data', 'news-eval')
  const file = process.argv[2] || path.join(dir, (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort().pop()!)
  const fx = JSON.parse(await fs.readFile(file, 'utf8')) as Fixture
  console.log(`[eval] 對照檔 ${path.basename(file)}`)

  const t0 = Date.now()
  const { topics, articles, 來源 } = await trendingTopics()
  console.log(`[eval] 抓到 ${articles} 篇 → ${topics.length} 個話題（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
  const broken = 來源.filter((s) => s.狀態 !== 'ok' || s.收下 === 0)
  if (broken.length) console.log(`[eval] 沒收到東西的來源：${broken.map((s) => `${s.名稱}(${s.狀態})`).join('、')}`)

  const trendsOK = topics.some((t) => t.明細.搜尋 !== null)
  if (!trendsOK) console.log('[eval] ⚠ Google Trends 沒抓到（被擋？），熱度只用 HN＋新聞兩個訊號')

  console.log('\n排名  熱度   HN分(篇)    新聞  搜尋  來源  話題（查詢；#＝事件，*＝籠統、沒拿去外部搜）')
  topics.slice(0, 25).forEach((t, i) => {
    const h = t.明細
    console.log(
      `${String(i + 1).padStart(3)}   ${String(t.熱度).padStart(3)}   ${String(h.hn).padStart(5)}(${String(h.hn篇數).padStart(2)})   ${String(h.新聞).padStart(4)}  ${
        h.搜尋 === null ? '  - ' : h.搜尋.toFixed(2)
      }  ${String(h.來源數).padStart(3)}   ${t.話題}（${t.查詢}${t.種類 === '名稱' ? '' : t.種類 === '事件' ? '#' : '*'}）`
    )
  })

  // 話題名稱、查詢，或話題底下任何一篇文章的標題配得到就算。
  // 只比話題名稱太嚴：Enigma 被併進「GPT-6 Astra 重大應用」，名稱裡沒有 Enigma，但它確實上板了。
  const rankOf = (re: string) => {
    const r = new RegExp(re, 'i')
    const i = topics.findIndex((t) => r.test(`${t.話題} ${t.查詢} ${t.必含}`) || t.文章.some((a) => r.test(a.標題)))
    return i === -1 ? null : i + 1
  }
  console.log(`\n標準答案（板上看得到＝前 ${TOP_N} 名）：`)
  let hit = 0
  let firstRank: number | null = null
  for (const e of fx.話題) {
    const r = rankOf(e.比對)
    if (e.名稱 === fx.第一名) firstRank = r
    const ok = r !== null && r <= TOP_N
    if (ok) hit++
    const t = r === null ? null : topics[r - 1]
    console.log(
      `  ${ok ? '✅' : '❌'} ${e.名稱}：${
        t ? `第 ${r} 名（${t.話題}｜查詢「${t.查詢}」必含「${t.必含}」${t.種類}｜熱度 ${t.熱度}）` : '沒有這個話題'
      }`
    )
  }
  const pass1 = firstRank !== null && firstRank <= 1
  const passRecall = hit >= fx.召回門檻
  console.log(`\n召回率 ${hit}/${fx.話題.length}（門檻 ${fx.召回門檻}）${passRecall ? '✅' : '❌'}`)
  console.log(`${fx.第一名} 排第 ${firstRank ?? '—'} 名（要第 1）${pass1 ? '✅' : '❌'}`)
  process.exitCode = pass1 && passRecall ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 2
})
