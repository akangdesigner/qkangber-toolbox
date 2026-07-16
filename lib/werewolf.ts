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
  topWolves: string[] // 最像狼的座位，已排序，長度 ≈ board.wolves
  overall: string
  confidence: number // 0–100
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

// 統一入口：有 Groq 用 Groq，否則退 Gemini
async function chatJSON(system: string, user: string, maxTokens: number, temperature: number): Promise<string> {
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
  "topWolves": ["最像狼的座位標籤，由最可疑到次可疑排序，數量等於這局的狼人數"],
  "overall": "整體局勢判讀，2到4句",
  "confidence": 0到100的整數（你對這次判斷的把握）
}`

export async function judge(payload: {
  board: Board
  transcript: string
  lessons: Lesson[]
  events?: string[]
}): Promise<Judgement> {
  const { board, transcript, lessons, events = [] } = payload

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

【過往教訓（先驗知識，優先納入）】
${lessonsBlock(lessons)}

【發言逐字稿】
${transcript}

請依上述資訊判狼，只回傳 JSON。戰況記錄中的出局與票型是硬資訊，優先度高於發言內容。topWolves 請剛好給 ${board.wolves} 個座位，且只能從還未確認出局的玩家中挑（除非戰況顯示已出局者翻牌前你想標註）。`

  const raw = await chatJSON(JUDGE_SYSTEM, userContent, 3000, 0.4)
  const parsed = JSON.parse(raw) as Partial<Judgement>
  return {
    seats: Array.isArray(parsed.seats) ? parsed.seats : [],
    topWolves: Array.isArray(parsed.topWolves) ? parsed.topWolves : [],
    overall: parsed.overall ?? '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
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
