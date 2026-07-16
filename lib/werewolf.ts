import { getGroqClient, GROQ_MODEL } from '@/lib/groq'

// 狼人殺筆記：全部走 Groq。
// - 轉錄：whisper-large-v3-turbo（快、便宜、中文可用）
// - 判狼 / 復盤：llama-3.3-70b-versatile（跟工具箱其他工具同一顆）

const WHISPER_MODEL = 'whisper-large-v3-turbo'

// ---- 型別（跟前端共用同一份形狀）----

export type Seat = {
  id: string // 座位標籤，例如 "1號"
  player?: string // 名冊玩家名（固定牌友，跨局累積行為檔案用）
  claim?: string // 跳身分：對局中玩家聲稱的身分（例：跳預言家）
  out?: boolean // 已出局
}

export type Board = {
  players: number
  wolves: number // 狼人數量（判狼時 topWolves 取這麼多個）
  roles: string // 這局有哪些身分，自由文字，例如「狼人x3、預言家、女巫、獵人、守衛、平民x3」
  seats: Seat[]
  note?: string // 額外情境（幾晚、有沒有出過刀、板子特殊規則）
  mySeat?: string // 使用者本人的座位（明身份，不用判）
  myRole?: string // 使用者本人的真實身份
}

export type SeatVerdict = {
  seat: string
  roleGuess: string
  suspicion: number // 0–100，越高越像狼
  reason: string
}

export type Judgement = {
  seats: SeatVerdict[]
  topWolves: string[] // 有足夠證據的疑狼座位；資訊不足時可以少於狼人數
  overall: string
  confidence: number // 0–100
  worlds?: WorldAnalysis[]
  selectedWorld?: string
}

export type WorldAnalysis = {
  assumedSeer: string
  wolfPit: string[]
  consistency: number
  seats: { seat: string; suspicion: number; reason: string; goodAlternative: string }[]
  hardContradictions: string[]
  supportingEvidence: string[]
  counterEvidence: string[]
  summary: string
}

export type Lesson = {
  title: string
  insight: string
}

// ---- 轉錄 ----

export async function transcribeAudio(file: File): Promise<string> {
  const client = getGroqClient()
  const res = await client.audio.transcriptions.create({
    file,
    model: WHISPER_MODEL,
    language: 'zh',
    // 讓 whisper 輸出正體中文用語、少一點簡繁混雜
    prompt: '這是一段狼人殺遊戲的中文發言逐字稿，包含玩家發言、投票、報身分。',
    response_format: 'json',
  })
  return (res.text ?? '').trim()
}

// ---- 轉錄（含語氣標註，走 Gemini：音檔直接餵多模態模型）----

const GEMINI_MODEL = 'gemini-2.5-flash'

const TONE_PROMPT = `把這段狼人殺遊戲的中文發言轉成繁體中文逐字稿。

重要：除了文字內容，把你從聲音裡聽出來的語氣線索用全形括號標在對應語句旁，例如：
（停頓很久）（語速突然變快）（笑）（遲疑）（音量變小）（激動）（結巴）（不耐煩）

規則：
- 只標你真的聽得出來的，不要腦補；平穩正常的語句不用標
- 如果聽得出是不同人講話，用「說話者A：」「說話者B：」開頭區分；聽不出來就不標
- 只輸出逐字稿本身，不要任何開場白、說明或總結`

// Gemini 文字對話（回 JSON）——GROQ_API_KEY 沒設定時判狼/復盤的備援引擎
async function geminiChatJSON(system: string, user: string, maxTokens: number): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GROQ_API_KEY 與 GEMINI_API_KEY 都未設定')
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        // Gemini 2.5 的思考 token 也計入 maxOutputTokens：
        // 給思考一個固定預算（夠推理用），答案空間另外保留，避免思考吃光輸出額度
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: maxTokens + 3072,
          thinkingConfig: { thinkingBudget: 2048 },
        },
      }),
    },
  )
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Gemini 分析失敗（${res.status}）：${errBody.slice(0, 200)}`)
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
  }
  const cand = json.candidates?.[0]
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('')
  if (!text) throw new Error(`Gemini 沒有回傳內容（finishReason: ${cand?.finishReason ?? '未知'}）`)
  return text
}

async function openRouterChatJSON(system: string, user: string, maxTokens: number, temperature: number): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('OPENROUTER_API_KEY 未設定')
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini'
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'Q Kangber Werewolf Notes',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`OpenRouter 分析失敗（${res.status}）：${errBody.slice(0, 240)}`)
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const text = json.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('OpenRouter 沒有回傳內容')
  return text
}

// 統一入口：有 Groq 用 Groq，否則退 Gemini
async function chatJSON(system: string, user: string, maxTokens: number, temperature: number): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) {
    return openRouterChatJSON(system, user, maxTokens, temperature)
  }
  if (process.env.GROQ_API_KEY) {
    const client = getGroqClient()
    const completion = await client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: maxTokens,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    })
    return completion.choices[0]?.message?.content ?? '{}'
  }
  return geminiChatJSON(system, user, maxTokens)
}

export async function transcribeWithTone(file: File): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY 未設定')

  const buf = Buffer.from(await file.arrayBuffer())
  const mime = file.type || 'audio/webm'

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: mime, data: buf.toString('base64') } },
              { text: TONE_PROMPT },
            ],
          },
        ],
      }),
    },
  )

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Gemini 轉錄失敗（${res.status}）：${errBody.slice(0, 200)}`)
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim()
  return text
}

// ---- 即時筆記：每段逐字稿進來，AI 萃取所有有用的對局資訊 ----

const NOTES_SYSTEM = `你是狼人殺場邊記錄員。每收到一段新發言，就萃取「對判狼有用的資訊」記成筆記。所有輸出一律使用繁體中文。

值得記的（有用資訊都算）：
- 跳身分／認身分：「2號跳預言家，報4號查殺」
- 質疑與指控：「3號質疑2號跳得太急」
- 站邊與包庇：「5號無條件幫7號說話」
- 前後矛盾：「9號先說沒想法，後又堅定投4號」
- 條件矛盾：「2號認為5號不像真預言家、又投3號的查殺8號，卻無替代解釋地否認5、8雙狼」
- 時間軸矛盾：「2號用投票後才出現的7號發言，回頭解釋自己更早的警長票理由」
- 投票意向、退水、警徽流宣告
- 明顯的情緒異常（逐字稿的語氣標註）：「6號被點名後明顯遲疑」

規則：
- 每條筆記一句話，以座位號開頭，具體、中性、不下結論（判狼是別人的事）
- 只記「新資訊」——已有筆記裡寫過的不要重複
- 寒暄、過場、無資訊量的話不記
- 沒有新資訊就回空陣列，寧缺勿濫

只輸出 JSON：{"notes":["...","..."]}`

export async function takeNotes(payload: {
  segment: string
  seats: { id: string; player?: string }[]
  existingNotes: string[]
}): Promise<string[]> {
  const { segment, seats, existingNotes } = payload
  const seatIds = seats.map((s) => s.id)
  const user = `座位列表：${seatIds.join('、')}
${seats.some((s) => s.player) ? `座位對應玩家：${seats.filter((s) => s.player).map((s) => `${s.id}=${s.player}`).join('、')}（發言若用名字稱呼，換算回座位號記錄）` : ''}

已有筆記（不要重複記）：
${existingNotes.length ? existingNotes.slice(-30).map((n, i) => `${i + 1}. ${n}`).join('\n') : '（還沒有）'}

新發言片段：
${segment}

萃取新筆記，只回傳 JSON。`
  const raw = await chatJSON(NOTES_SYSTEM, user, 800, 0.2)
  const parsed = JSON.parse(raw) as { notes?: string[] }
  return (parsed.notes ?? []).filter((n) => typeof n === 'string' && n.trim())
}

// ---- 判狼 ----

function lessonsBlock(lessons: Lesson[]): string {
  if (!lessons.length) return '（目前還沒有累積的教訓，用你自己的判斷。）'
  // 只帶最近 40 條，避免 context 爆掉
  const recent = lessons.slice(-40)
  return recent.map((l, i) => `${i + 1}. 【${l.title}】${l.insight}`).join('\n')
}

const JUDGE_SYSTEM = `你是頂尖的狼人殺（werewolf / 天黑請閉眼）分析師，專門從發言逐字稿判斷誰是狼人。所有輸出一律使用繁體中文（台灣用語）。

你熟悉 12 人標準局流程，包含警長競選環節：
- 首日有「警上」（上警競選警長的玩家輪流發言）與「警下」（未上警玩家發言）之分。上警陣容與退水（中途退出競選）時機是重要訊號：預言家通常上警，狼隊常派 1-2 人上警搶警徽或衝票
- 警長有 1.5 票並可歸票（總結歸票意見），警長的歸票方向與身分傾向高度相關
- 警徽流：自稱預言家者宣布「我死後警徽給X號」，警徽流指向可用來驗證其身分真偽
- 票型是硬證據：狼隊常抱團投票、跟票沖票、或故意分票保狼；「倒鉤」（狼投狼）用來做身分。分析投票時把每輪票型跟發言立場交叉比對，言行不一致者高度可疑

分析時重點看：
- 發言邏輯有沒有矛盾、有沒有幫特定人洗白或帶節奏
- 自報身分的可信度、跳身分的時機與動機
- 投票行為跟站隊、有沒有互相包庇的狼隊跡象
- 情緒與話術：過度防禦、模糊焦點、假裝好人邏輯

逐字稿裡可能有使用者現場標註的語氣線索，通常寫在全形或半形括號裡，例如（停頓很久）（笑）（急著撇清）（結巴）（聲音變小）。這些是在場的人親耳聽到的副語言訊號，非常珍貴——務必納入推理並在 reason 中引用。例如「被質問時停頓很久才否認」比「否認」的資訊量大得多。

你會拿到「過往教訓」——那是這位使用者過去對局復盤後總結出來、針對他們常玩的板子/牌友風格的修正筆記。請把這些教訓當成先驗知識，優先納入判斷、修正你的直覺。

【證據紀律——違反任何一條都算分析失敗】
- 嚴格區分三種資訊：「確定事實」「玩家自稱／查驗宣稱」「你的推測」。玩家說自己是預言家、報某人查殺，都只是宣稱，不能寫成已確認事實。
- 除非使用者明牌、角色翻牌或戰況明確記錄真實身分，絕對不可斷言任何人是平民、神職或狼人。roleGuess 不確定時寫「未知／偏好」或「未知／偏狼」。
- 本房規預設「出局不翻身分」：夜間倒牌、白天被放逐都只代表玩家離場，絕不代表其陣營或底牌已確認。除非戰況明確另記「翻牌為某身分」或特殊角色依技能公開翻牌，否則所有出局者身分仍是未知。
- 多數玩家把某人放逐，只能證明當輪票型與集體選擇，不能證明被放逐者是狼。不得使用「被票出所以狼面高」「若不是好人就極可能是狼」等循環推論。
- 出局玩家仍要保留在疑狼分析與 topWolves 候選中；AI判斷的是本局狼人組成，不是只找目前存活的狼。
- 「警長」只是職務，不代表平民或好人。不得因當選警長就替他定義陣營或底牌。
- 「唯一跳預言家」只代表目前沒有對跳；未上警後才跳確實反常，但單獨不足以判定悍跳狼，必須結合查驗、發言一致性與票型。
- 投給同一位警長只代表當輪站邊相同，是弱關聯；沒有互保、沖票、改票或言行矛盾時，不得據此打成狼隊。
- 被某位自稱預言家的玩家報查殺，不會自動提高被查殺者的疑狼度；要先評估報查殺者可信度。
- 這是網路狼人殺：上警按鈕的快慢、點擊速度、連線延遲、麥克風狀況等操作表現一律不是身分證據。除非使用者明確記錄為場內可用資訊，否則不得引用。
- 每個高疑狼結論至少要有一條可定位的原始證據（某段發言或某輪票型）。沒有直接證據就降低 suspicion，不可用「可能是隊友」湊人數。
- 第一天資訊通常不完整：證據普通時 confidence 應落在 35–60；只有多項互相獨立且一致的硬證據才能超過 70。
- topWolves 只放 suspicion >= 60 且有具體證據的人，可以少於狼人總數，甚至為空。絕對不要為了湊滿狼人數硬塞人選。

【板型約束與條件一致性】
- 先讀身分配置，確認是否存在狂人、愚者等可能替狼隊假跳的第三方角色；不能套用板子裡不存在的角色作解釋。
- 對每個玩家建立「他若相信自己的話，必須同時相信什麼」的條件鏈，再拿他的投票與狼坑比較。
- 例如在沒有狂人的雙預言家對跳局：某玩家一方面指出B不像真預言家，另一方面投A報出的查殺，行動上就是偏信A；此時若他又無理由地拒絕把B與該查殺放進同一狼坑，屬於條件不一致，可能是在切割或保留隊友空間，不能被當成單純謹慎。
- 「不亂綁關係」只有在玩家提出替代世界（例如A也可能是假、B可能是被迫起跳的其他角色）時才算合理保留；若沒有替代世界，只是否認自己前提的必然推論，疑狼度應提高。
- 對每位玩家都檢查四項是否一致：真假預言家判斷、查殺／金水態度、口頭狼坑、實際投票。任兩項衝突時 reason 必須明確指出。

【時間軸與資訊可得性——優先級等同票型】
- 所有判斷必須依事件與發言的實際先後順序。玩家只能用「當時已經發生、已經聽到」的資訊解釋當時的行動。
- 玩家事後解釋警長票或放逐票時，逐項檢查他引用的理由在投票前是否已出現；若理由來自投票後的發言，這不是合理票型分析，而是時間軸不可能的事後補理由，疑狼度應顯著提高。
- 特別檢查發言順序：若A先發言、B後發言，A在下一次輪到自己之前不可能回應B。其他玩家不得聲稱A「當時沒有回應B」並把它當成更早投票的原始理由，除非A在投票前確實另有發言機會。
- 區分「我當時投票的理由」與「我現在聽完後更新的看法」。把後見資訊偽裝成當時理由，屬於可定位的硬矛盾，reason 必須直接指出前後事件。
- 分析每一張票前，先建立該投票者當時可見的發言集合；不可用投票後內容替早先票型合理化。

分析程序（在心裡按順序做完，再輸出結論）：
第一步・發言分類：把每個玩家的關鍵發言歸類——報身分／質問／指控／辯護／舉證／號召行動。狼的典型組合是「被指控時重辯護、少舉證，並快速把指控轉移到別人身上」；好人通常敢舉證、敢被質問。
第二步・二階推理（最重要）：對每個玩家問三個問題——「他想讓全場相信什麼？」「他在防著誰、怕誰起身分？」「他的發言實際上讓誰受益？」。狼的發言受益者往往是狼隊友；好人的發言受益者是資訊本身。
第三步・硬資訊交叉：把戰況記錄的票型、出局順序、警上陣容跟第二步的結論交叉驗證，言行不一致者疑點加重；狼刀的目標選擇也透露狼隊視角（他們怕誰）。
第四步・套用過往教訓修正，得出最終疑狼度。

只輸出 JSON，不要有任何多餘文字。格式：
{
  "seats": [
    { "seat": "座位標籤", "roleGuess": "你猜的身分", "suspicion": 0到100的整數, "reason": "一句話理由，具體引用發言" }
  ],
  "topWolves": ["有足夠證據的疑狼座位，由最可疑到次可疑排序；可以少於狼人數"],
  "overall": "整體局勢判讀，2到4句",
  "confidence": 0到100的整數（你對這次判斷的把握）
}`

const WORLD_SYSTEM = `你是狼人殺「假設世界分析員」。使用者會指定一位自稱預言家的玩家；你必須暫時假設他是真預言家，其他對跳者是假跳，再檢查整局是否自洽。你不能因為被指定就替這個世界護航，你的任務是找出它需要付出多少矛盾成本。

規則：
- 出局不翻身分；被放逐不代表是狼。
- 「未翻身分」代表完全沒有公開底牌資訊，既不能證明查殺成立，也不能證明查殺失效；不得把未翻牌列為任何世界的矛盾或支持證據。
- 嚴格依時間軸，只能用當時已知資訊解釋當時票型。
- 使用板型中實際存在的角色，不得創造狂人等不存在的角色。
- 檢查每位玩家的預言家站邊、查殺／金水態度、口頭狼坑與實際投票是否一致。
- 狼坑數量等於板子狼人數，但必須列出每一位的證據與本世界最大的反證。
- 強制假設某位是真預言家後，他報出的金水／好人就是本世界確定好人，絕不可放進狼坑；他報出的查殺／狼人就是本世界確定狼，必須放進狼坑。若做不到，該世界分析無效。
- 另一位假預言家報出的查殺／金水全部只是策略性宣稱：目標可能是好人，也可能是狼隊友。不得因假預言家報某人查殺就認為兩人必須同狼，也不得把「狼查殺狼」當成本世界必須支付的矛盾；要依兩人的實際互動收益另外判斷。
- consistency 是這個「預言家為真」世界的整體自洽度，不是你對指定預言家身分的主觀喜好。

只輸出 JSON：
{
  "assumedSeer":"座位",
  "seats":[{"seat":"每一個座位都必須有","suspicion":0到100,"reason":"此世界下的疑點","goodAlternative":"若是好人的合理解釋"}],
  "wolfPit":["依全員疑狼度排序後產生的唯一完整狼坑"],
  "consistency":0到100,
  "hardContradictions":["時間軸或條件硬矛盾"],
  "supportingEvidence":["支持此世界的具體原文／票型"],
  "counterEvidence":["反對此世界的具體原文／票型"],
  "summary":"兩到四句總結"
}`

const ARBITER_SYSTEM = `你是狼人殺世界裁判。你會收到兩份彼此獨立、各自假設不同預言家為真的分析。你只能比較兩份世界與原始證據，不得創造第三套故事，也不得因多數票把出局者認成狼。

本房規出局不翻身分。「未翻身分」等於沒有新增任何身分資訊，不能據此說查殺成立或失效，也不能列為矛盾。
被判為假預言家的玩家所報查殺／金水沒有真實性約束，不能據此斷言他與目標同陣營或不同陣營。

比較順序：
1. 時間軸不可能與後見資訊倒填（最重）
2. 板型不允許的角色解釋
3. 預言家真假、查殺／金水、狼坑與票型的條件矛盾
4. 狼隊互動是否有實際收益，而非只因同票就綁狼
5. 每個疑點是否存在合理好人替代解釋

裁判必須選擇矛盾較少的一個世界，但可表示兩邊接近。每位高疑狼玩家必須引用可定位證據。confidence 最高80；第一天證據不足時最高65。

只輸出 JSON：
{
  "selectedWorld":"採用的真預言家座位",
  "seats":[{"seat":"座位","roleGuess":"未知／偏好或未知／偏狼","suspicion":0到100,"reason":"具體理由"}],
  "topWolves":["最多板子狼人數，證據不足可少列"],
  "overall":"說明為何這個世界比另一個自洽，以及最大不確定性",
  "confidence":0到80
}`

function findSeerClaimants(transcript: string, seatIds: string[]): string[] {
  return seatIds.filter((seat) => {
    const escaped = seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const blocks = transcript.match(new RegExp(`(?:【[^】]+】)?${escaped}：[^\\n]*`, 'g')) ?? []
    return blocks.some((block) => /(?:我跳預言家|我(?:才|就)?是(?:真)?預言家)/.test(block))
  })
}

function findClaimedCheck(transcript: string, seer: string): { target?: string; alignment?: 'good' | 'wolf' } {
  const escaped = seer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blocks = transcript.match(new RegExp(`(?:【[^】]+】)?${escaped}：[^\\n]*`, 'g')) ?? []
  for (const block of blocks) {
    const match = block.match(/驗(?:了)?(\d+號)(?:是|為)?(好人|金水|狼人|狼|查殺)/)
    if (match) return { target: match[1], alignment: /好人|金水/.test(match[2]) ? 'good' : 'wolf' }
  }
  return {}
}

export async function judge(payload: {
  board: Board
  transcript: string
  lessons: Lesson[]
  events?: string[]
  notes?: string[]
}): Promise<Judgement> {
  const { board, transcript, lessons, events = [], notes = [] } = payload

  const seatList = board.seats
    .map((s) => {
      const parts = [s.id]
      if (s.player) parts.push(`玩家：${s.player}`)
      if (s.claim) parts.push(`跳身分：${s.claim}`)
      if (s.out) parts.push('已出局')
      if (board.mySeat && s.id === board.mySeat) parts.push('★使用者本人')
      return `- ${parts.join('，')}`
    })
    .join('\n')

  const myInfo =
    board.mySeat && board.myRole
      ? `【使用者本人（確定資訊）】
使用者本人坐在 ${board.mySeat}，真實身份是「${board.myRole}」。這是 100% 確定的事實，據此推理：
- 任何與此衝突的自報都是假跳（例如使用者是女巫，則其他跳女巫的必為假）
- 不要把 ${board.mySeat} 列入 topWolves，也不用給他疑狼度分析（seats 陣列中他的 suspicion 填 0、reason 填「使用者本人，身份已知」）
`
      : ''

  const eventsBlock = events.length
    ? events.map((e, i) => `${i + 1}. ${e}`).join('\n')
    : '（尚無回報）'

  const userContent = `【板子】
玩家人數：${board.players}
狼人數量：${board.wolves}
身分配置：${board.roles}
${board.note ? `情境備註：${board.note}\n` : ''}
【座位/玩家】
座位標了「玩家：某某」的是固定牌友，過往教訓中提到該玩家名字的規律直接適用於他。
${seatList}

${myInfo}

【戰況記錄（使用者實時回報：出局、票型、警長歸屬、警上警下陣容等，按時間順序）】
${eventsBlock}

【場邊即時筆記（AI 逐段整理的觀察，按時間順序）】
${notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '（無）'}

【過往教訓（先驗知識，優先納入）】
${lessonsBlock(lessons)}

【發言逐字稿】
${transcript}

請依上述資訊判狼，只回傳 JSON。戰況記錄中的出局與票型是硬資訊，但票型仍須結合投票當時的發言與動機。topWolves 最多 ${board.wolves} 人，只能放有具體證據且 suspicion >= 60 的座位；資訊不足就少列，絕對不要湊數。`

  const claimants = findSeerClaimants(transcript, board.seats.map((s) => s.id)).slice(0, 2)
  if (claimants.length === 2) {
    const worldPrompts = claimants.map((assumedSeer) => `${userContent}\n\n【本次強制假設】${assumedSeer}是真預言家，另一位對跳者是假跳。請盤出此世界完整狼坑並誠實列出硬矛盾。`)
    const worldRaw = await Promise.all(worldPrompts.map((prompt) => chatJSON(WORLD_SYSTEM, prompt, 2200, 0.1)))
    const worlds = worldRaw.map((raw, index) => {
      const parsed = JSON.parse(raw) as Partial<WorldAnalysis>
      const assumedSeer = claimants[index]
      const opposingSeer = claimants.find((seat) => seat !== assumedSeer)
      const claimedCheck = findClaimedCheck(transcript, assumedSeer)
      const parsedSeats = Array.isArray(parsed.seats) ? parsed.seats : []
      const scoreBySeat = new Map(parsedSeats.map((item) => [item.seat, item]))
      const seats = board.seats.map((boardSeat) => {
        const item = scoreBySeat.get(boardSeat.id)
        let suspicion = Math.max(0, Math.min(100, Number(item?.suspicion) || 0))
        let reason = item?.reason ?? '模型未提供具體理由'
        if (boardSeat.id === assumedSeer) {
          suspicion = 0
          reason = '本世界強制假設的真預言家'
        } else if (boardSeat.id === opposingSeer) {
          suspicion = Math.max(85, suspicion)
          reason = `本世界的對跳假預言家；${reason}`
        } else if (boardSeat.id === claimedCheck.target && claimedCheck.alignment === 'good') {
          suspicion = 0
          reason = '本世界真預言家的金水'
        } else if (boardSeat.id === claimedCheck.target && claimedCheck.alignment === 'wolf') {
          suspicion = 100
          reason = '本世界真預言家的查殺'
        }
        return {
          seat: boardSeat.id,
          suspicion,
          reason,
          goodAlternative: item?.goodAlternative ?? '',
        }
      })
      const wolfPit = seats
        .filter((seat) => seat.seat !== board.mySeat && seat.suspicion > 0)
        .sort((a, b) => b.suspicion - a.suspicion)
        .slice(0, board.wolves)
        .map((seat) => seat.seat)
      return {
        assumedSeer,
        wolfPit,
        consistency: Math.max(0, Math.min(100, Number(parsed.consistency) || 0)),
        seats,
        hardContradictions: Array.isArray(parsed.hardContradictions) ? parsed.hardContradictions : [],
        supportingEvidence: Array.isArray(parsed.supportingEvidence) ? parsed.supportingEvidence : [],
        counterEvidence: Array.isArray(parsed.counterEvidence) ? parsed.counterEvidence : [],
        summary: parsed.summary ?? '',
      } satisfies WorldAnalysis
    })
    const arbitration = `${userContent}\n\n【世界A】\n${JSON.stringify(worlds[0], null, 2)}\n\n【世界B】\n${JSON.stringify(worlds[1], null, 2)}\n\n只比較這兩個世界，選擇矛盾成本較低者並輸出最終判斷。`
    const finalRaw = await chatJSON(ARBITER_SYSTEM, arbitration, 3000, 0.1)
    const finalParsed = JSON.parse(finalRaw) as Partial<Judgement>
    const selectedWorld = finalParsed.selectedWorld && claimants.includes(finalParsed.selectedWorld)
      ? finalParsed.selectedWorld
      : worlds.slice().sort((a, b) => b.consistency - a.consistency)[0]?.assumedSeer
    const selectedCheck = selectedWorld ? findClaimedCheck(transcript, selectedWorld) : {}
    const seats = (Array.isArray(finalParsed.seats) ? finalParsed.seats : []).map((seat) => {
      if (seat.seat !== selectedCheck.target) return seat
      return selectedCheck.alignment === 'wolf'
        ? { ...seat, roleGuess: '此世界的查殺', suspicion: Math.max(90, Number(seat.suspicion) || 0) }
        : { ...seat, roleGuess: '此世界的金水', suspicion: 0 }
    })
    const validSeatIds = new Set(board.seats.filter((s) => s.id !== board.mySeat).map((s) => s.id))
    const supported = new Set(seats.filter((s) => Number(s.suspicion) >= 60).map((s) => s.seat))
    let topWolves = (Array.isArray(finalParsed.topWolves) ? finalParsed.topWolves : [])
      .filter((seat, index, all) => validSeatIds.has(seat) && supported.has(seat) && all.indexOf(seat) === index)
    if (selectedCheck.target && selectedCheck.alignment === 'good') {
      topWolves = topWolves.filter((seat) => seat !== selectedCheck.target)
    }
    if (selectedCheck.target && selectedCheck.alignment === 'wolf' && !topWolves.includes(selectedCheck.target)) {
      topWolves.unshift(selectedCheck.target)
    }
    topWolves = topWolves.slice(0, board.wolves)
    return {
      seats,
      topWolves,
      overall: finalParsed.overall ?? '',
      confidence: Math.max(0, Math.min(80, Number(finalParsed.confidence) || 0)),
      worlds,
      selectedWorld,
    }
  }

  const raw = await chatJSON(JUDGE_SYSTEM, userContent, 3000, 0.15)
  const parsed = JSON.parse(raw) as Partial<Judgement>
  const seats = Array.isArray(parsed.seats) ? parsed.seats : []
  const validSeatIds = new Set(board.seats.filter((s) => s.id !== board.mySeat).map((s) => s.id))
  const supported = new Set(seats.filter((s) => Number(s.suspicion) >= 60).map((s) => s.seat))
  const topWolves = (Array.isArray(parsed.topWolves) ? parsed.topWolves : [])
    .filter((seat, index, all) => validSeatIds.has(seat) && supported.has(seat) && all.indexOf(seat) === index)
    .slice(0, board.wolves)
  const rawConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0
  return {
    seats,
    topWolves,
    overall: parsed.overall ?? '',
    confidence: Math.max(0, Math.min(topWolves.length < board.wolves ? 65 : 100, rawConfidence)),
  }
}

// ---- 復盤：比對預測 vs 真相，生成教訓 ----

const REFLECT_SYSTEM = `你是狼人殺覆盤教練。使用者玩完一局，提供了：這局的板子、發言逐字稿、AI 當時的判狼預測、以及真正的身分（真相）。所有輸出一律使用繁體中文（台灣用語）。

你的任務：比對「預測」和「真相」，找出 AI 判錯在哪、哪些發言訊號被高估或低估，總結成幾條「可重複使用的教訓」，讓下一局判得更準。

教訓要具體、可操作，針對這群牌友/這個板子的風格。不要寫「要多觀察」這種空話，要寫「X 這種發言其實是狼在假裝好人邏輯」這種能直接套用的規律。

重要：座位若有登記玩家名（固定牌友），教訓一律寫「玩家名」而不是座位號——座位每局都換、人是固定的。例如寫「阿明當狼時會刻意少發言、被質問才長篇辯護」，不要寫「3號當狼時…」。這樣教訓才能跨局累積成每個玩家的行為檔案。沒登記玩家名的座位才用歸納式寫法（不指名）。

只輸出 JSON，不要多餘文字。格式：
{
  "accuracyNote": "一句話講這次判得準不準、主要錯在哪",
  "lessons": [
    { "title": "短標題（6到12字）", "insight": "一到兩句具體可套用的規律" }
  ]
}
lessons 給 2 到 4 條就好，寧缺勿濫。`

export async function reflect(payload: {
  board: Board
  transcript: string
  prediction: Judgement | null
  truth: { seat: string; role: string; isWolf: boolean }[]
  result?: string // 好人陣營 / 狼人陣營 勝，或其他備註
  events?: string[]
}): Promise<{ accuracyNote: string; lessons: Lesson[] }> {
  const { board, transcript, prediction, truth, result, events = [] } = payload

  const playerOf = new Map(board.seats.map((s) => [s.id, s.player]))
  const truthList = truth
    .map((t) => {
      const p = playerOf.get(t.seat)
      return `- ${t.seat}${p ? `（玩家：${p}）` : ''}：${t.role}${t.isWolf ? '（狼）' : ''}`
    })
    .join('\n')

  const predList = prediction
    ? prediction.seats
        .map((s) => `- ${s.seat}：疑狼度 ${s.suspicion}，猜 ${s.roleGuess}`)
        .join('\n') + `\n最終指認的狼：${prediction.topWolves.join('、')}`
    : '（這局沒有 AI 預測紀錄）'

  const userContent = `【板子】玩家 ${board.players}、狼 ${board.wolves}、配置：${board.roles}

【戰況記錄】
${events.length ? events.map((e, i) => `${i + 1}. ${e}`).join('\n') : '（無）'}

【發言逐字稿】
${transcript}

【AI 當時的判狼預測】
${predList}

【真正身分（真相）】
${truthList}
${result ? `\n【賽果】${result}` : ''}

請比對預測與真相，生成教訓，只回傳 JSON。`

  const raw = await chatJSON(REFLECT_SYSTEM, userContent, 1500, 0.5)
  const parsed = JSON.parse(raw) as { accuracyNote?: string; lessons?: Lesson[] }
  return {
    accuracyNote: parsed.accuracyNote ?? '',
    lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
  }
}
