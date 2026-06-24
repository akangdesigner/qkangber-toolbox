import Link from 'next/link'

export const metadata = { title: '看盤技術課程懶人包｜Q kangber 工具箱' }

// 今天聊的台股技術分析重點整理，當複習筆記用。純靜態內容。
export default function LearnPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-12 text-slate-300">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h1 className="text-2xl sm:text-3xl font-semibold text-white">看盤技術課程懶人包</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-white">← 回工具箱</Link>
      </div>
      <p className="text-sm text-slate-400 mb-3">
        新手學買台股個股的技術分析重點整理，搭配
        <Link href="/watch" className="text-violet-300 hover:text-violet-200"> 自選股健檢 </Link>
        工具一起用。以下是觀念與紀律，不是投資建議。
      </p>

      {/* 三句心法 */}
      <Section title="先記住三句心法">
        <ul className="space-y-2">
          <Bullet><b className="text-white">趨勢 &gt; 指標 &gt; 單根 K 線</b>：方向看錯，再會看指標也沒用。</Bullet>
          <Bullet><b className="text-white">順勢、不追高、設停損</b>：新手活得久才有機會賺大波段。</Bullet>
          <Bullet><b className="text-white">會等就贏過大半人</b>：便宜的好股會再出現，追高賠錢才是真損失。</Bullet>
        </ul>
      </Section>

      {/* 看盤三層 */}
      <Section title="看盤的三層架構（由大到小）">
        <Table
          head={['層次', '看什麼', '回答的問題']}
          rows={[
            ['① 趨勢', '均線、多空排列', '能不能做多？'],
            ['② 動能', 'MACD', '方向有沒有轉強？'],
            ['③ 時機', 'KD、K 線、量', '什麼時候進場？'],
          ]}
        />
        <Callout>新手最常犯的錯：只盯最小那層（K 線跳動），卻忘了先看最大的趨勢。</Callout>
      </Section>

      {/* 均線 */}
      <Section title="均線（趨勢主工具）">
        <p className="mb-3">均線＝過去 N 天的平均成交價，代表「大家的平均成本」。股價站在均線之上＝多數人賺錢、心態穩。</p>
        <Table
          head={['均線', '俗稱', '用途']}
          rows={[
            ['5 日', '週線', '短線（貼著股價跑，日線圖參考性低）'],
            ['20 日', '月線', '波段重要支撐'],
            ['60 日', '季線', '多空分界線，最常看'],
          ]}
        />
        <ul className="mt-3 space-y-2">
          <Bullet><b className="text-white">多頭排列</b>：股價 &gt; 週線 &gt; 月線 &gt; 季線，四條像扶梯往上＝最強勢。</Bullet>
          <Bullet><b className="text-white">站上季線</b>＝偏多可做多；<b className="text-white">跌破季線</b>＝結構轉弱該避開。</Bullet>
          <Bullet>均線「<b className="text-white">方向往上翹</b>」比數值更重要。</Bullet>
        </ul>
      </Section>

      {/* KD */}
      <Section title="KD（判斷現在偏貴/偏便宜）">
        <p className="mb-2">把股價換算成 0~100 的位置分數。計算鏈：</p>
        <p className="mb-3 rounded-lg bg-white/[0.04] px-4 py-2 text-sm">
          每日高低收 → <b className="text-white">RSV</b>（今日收盤在最近 9 天高低區間的位置，很跳）
          → 平滑一次 → <b className="text-amber-300">K（快線）</b>
          → 再平滑一次 → <b className="text-indigo-300">D（慢線）</b>
        </p>
        <Table
          head={['狀態', '條件', '意思']}
          rows={[
            ['超買', 'K ≥ 80', '短線過熱、偏貴，可能回檔'],
            ['超賣', 'K ≤ 20', '短線過冷、偏便宜，可能反彈'],
            ['黃金交叉', 'K 由下穿過 D', '偏多訊號（低檔出現最有用）'],
            ['死亡交叉', 'K 由上跌破 D', '偏空訊號（高檔出現要當心）'],
          ]}
        />
        <Callout type="warn">
          <b>鈍化陷阱</b>：超強的股票 K 會黏在 80 以上一直不下來，這時別看到超買就急著賣——KD 在單邊行情會失靈，要配合均線方向看。
        </Callout>
      </Section>

      {/* MACD */}
      <Section title="MACD（判斷中期動能強弱）">
        <ul className="space-y-2">
          <Bullet><b className="text-white">柱狀體（OSC）</b>在 0 軸之上且變長＝多方力氣變強；翻到 0 軸之下＝轉空。</Bullet>
          <Bullet>比 KD 慢、比較不會騙，適合<b className="text-white">確認大方向</b>。</Bullet>
          <Bullet>經典組合：<b className="text-white">MACD 確認方向轉強，KD 抓精準進場點</b>。</Bullet>
        </ul>
      </Section>

      {/* 停損 */}
      <Section title="停損（最重要的一課）">
        <p className="mb-3">停損不是因為「它一定不會彈」，是因為「你賭不起它萬一不彈」。賠錢的數學是不對稱的：</p>
        <Table
          head={['你賠了', '要漲回多少才回本']}
          rows={[
            ['−10%', '+11%'],
            ['−20%', '+25%'],
            ['−50%', '+100%（翻倍！）'],
            ['−90%', '+900%'],
          ]}
        />
        <ul className="mt-3 space-y-2">
          <Bullet><b className="text-white">進場前就設好停損價</b>（例如跌破季線就走），用規則綁住情緒。</Bullet>
          <Bullet>用技術面進場，就用技術面停損——<b className="text-white">別賠錢了才改口說要存股</b>。</Bullet>
          <Bullet><b className="text-white">乖離回歸</b>：股價漲太遠離均線，歷史上幾乎都會回去找均線，只是早晚。</Bullet>
        </ul>
      </Section>

      {/* 三種角度 */}
      <Section title="「好股票」和「太高」是兩個問題">
        <Table
          head={['角度', '在問', '看什麼', '工具能判？']}
          rows={[
            ['基本面', '公司好不好？', 'EPS、營收成長、產業地位', '✗ 自己查財報'],
            ['技術面', '短線貴不貴？', '距季線%（乖離）、KD 超買', '✓'],
            ['估值面', '長線值不值？', '本益比 PE、PB、殖利率', '✓'],
          ]}
        />
        <Callout>
          完整判斷＝<b className="text-white">好公司 ＋ 不貴（技術回檔／估值合理）</b>。緯穎是「好公司、估值還好，但技術乖離 +180% 太高」的例子——問題在時機，不在公司。
        </Callout>
        <p className="mt-3 text-sm">
          <b className="text-white">本益比 PE</b>＝願意用幾年獲利換這張股票，越高越貴；成長股天生偏高，要<b className="text-white">跟同業、跟自己歷史比</b>。
          <b className="text-white"> 殖利率</b>＝買進價能領到的現金股利報酬率，存股族看這個。
        </p>
      </Section>

      {/* 選股 SOP */}
      <Section title="選股 SOP（搭配工具）">
        <ol className="space-y-2 list-decimal list-inside marker:text-violet-400">
          <li>自己生候選名單（你懂的產業 / 大型權值股 / 0050 成分），或用工具「選股掃描」。</li>
          <li>初篩：只留 <b className="text-white">站上季線＋多頭排列</b> 的（紅綠燈綠燈）。</li>
          <li>抓時機：找<b className="text-white">剛回檔靠近均線（距季線% 小）＋ KD 降到低檔</b> 的。</li>
          <li>確認：KD 低檔黃金交叉、MACD 柱沒翻空。</li>
          <li>進場<b className="text-white">同時設停損</b>（跌破季線就走）。</li>
        </ol>
      </Section>

      {/* 買點徽章 */}
      <Section title="工具的買點徽章對照">
        <Table
          head={['徽章', '白話']}
          rows={[
            ['🟢 接近買點', '好股＋剛回檔，價格漂亮，可考慮'],
            ['🔵 強勢偏貴', '好股但漲多了，現在追是高點，等回檔'],
            ['🟡 盤整觀望', '方向未明，先別動'],
            ['🔴 轉弱避開', '跌破季線／空頭，別碰'],
          ]}
        />
      </Section>

      {/* 心理與常識 */}
      <Section title="心態與基本常識">
        <ul className="space-y-2">
          <Bullet><b className="text-white">FOMO（怕錯過）</b>是散戶頭號殺手——它只在股票漲一大段後發作，驅使你追在最高點。</Bullet>
          <Bullet><b className="text-white">ETF（00 開頭）</b>＝一籃子股票，賭國運、不會一夜歸零；<b className="text-white">個股（4 碼）</b>＝賭單一公司，波動大要做功課。</Bullet>
          <Bullet><b className="text-white">少年股神的反義詞是「畢業」</b>：別重壓、別開槓桿、用賠得起的小錢練紀律。</Bullet>
        </ul>
      </Section>

      <p className="mt-10 text-xs text-slate-500">
        本頁為技術分析觀念整理，非投資建議；技術分析是提高勝率的工具，不保證獲利。
      </p>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 border-l-2 border-violet-400 pl-3 text-lg font-semibold text-white">{title}</h2>
      {children}
    </section>
  )
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="text-violet-400">›</span>
      <span>{children}</span>
    </li>
  )
}

function Callout({ children, type = 'info' }: { children: React.ReactNode; type?: 'info' | 'warn' }) {
  const cls = type === 'warn' ? 'border-amber-500/30 bg-amber-500/[0.06]' : 'border-violet-500/30 bg-violet-500/[0.06]'
  return <div className={`mt-3 rounded-lg border ${cls} px-4 py-3 text-sm`}>{children}</div>
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-white/[0.04] text-left text-slate-400">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/5">
              {r.map((c, j) => (
                <td key={j} className={`px-3 py-2 ${j === 0 ? 'text-white whitespace-nowrap' : ''}`}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
