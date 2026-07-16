'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { WEREWOLF_BLIND_TEST_2_EVENTS, WEREWOLF_BLIND_TEST_2_TRANSCRIPT } from '@/lib/werewolf-test-data'

// ---- 型別（跟 lib/werewolf.ts 對齊）----
type Seat = { id: string; player?: string; claim?: string; out?: boolean }
type Board = {
  players: number
  wolves: number
  roles: string
  seats: Seat[]
  note?: string
  mySeat?: string // 我本人的座位（明身份）
  myRole?: string
}
type RosterPlayer = { id: string; name: string; note?: string; isMe?: boolean }
type SeatVerdict = { seat: string; roleGuess: string; suspicion: number; reason: string }
type WorldAnalysis = {
  assumedSeer: string
  wolfPit: string[]
  consistency: number
  seats: { seat: string; suspicion: number; reason: string; goodAlternative: string }[]
  hardContradictions: string[]
  supportingEvidence: string[]
  counterEvidence: string[]
  summary: string
}
type SpeechAudit = {
  seat: string
  evidence: {
    id: string
    phase: string
    quote: string
    finding: string
    severity: 'hard' | 'medium' | 'weak' | 'none'
    wolfInterpretation: string
    goodInterpretation: string
  }[]
  timelineVerdict: string
  consistencyVerdict: string
}
type Judgement = {
  seats: SeatVerdict[]
  topWolves: string[]
  overall: string
  confidence: number
  worlds?: WorldAnalysis[]
  selectedWorld?: string
  speechAudits?: SpeechAudit[]
}
type Lesson = { id: string; ts: number; gameId?: string; title: string; insight: string }
type Truth = { seat: string; role: string; isWolf: boolean }
type Phase = 'setup' | 'live' | 'review'
type SpeechDirection = 'asc' | 'desc'
type SheriffStage = 'speech' | 'vote' | 'runoffSpeech' | 'runoffVote' | 'deathReport' | 'daySetup' | 'daySpeech' | 'dayVote' | 'done'
type LiveFlow = {
  sheriffSeats: string[]
  firstSpeaker: string
  direction: SpeechDirection
  ready: boolean
  stage: SheriffStage
  spokenSeats: string[]
  votes: Record<string, string>
  runoffCandidates: string[]
  sheriffWinner: string
  deathSeats: string[]
  dayVotes: Record<string, string>
}
type Game = {
  id: string
  createdAt: number
  board: Board
  transcript: string
  events?: string[]
  notes?: string[]
  judgement: Judgement | null
  truth: Truth[] | null
  result?: string
  accuracy: number | null
}

const LS = {
  lessons: 'wn_lessons',
  games: 'wn_games',
  current: 'wn_current',
  roster: 'wn_roster',
  staleTranscriptCleared: 'wn_stale_transcript_cleared_20260716',
  blindTest2Seeded: 'wn_blind_test_2_seeded_20260716',
}
// 發言長度不固定（通常約兩分鐘）：切段主要靠「點發言者」手動切，
// 這裡只是保險上限，避免單段過長
const MAX_SEGMENT_MS = 150000

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
function load<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val))
  } catch {}
}
function makeSeats(n: number, prev: Seat[]): Seat[] {
  return Array.from({ length: n }, (_, i) => prev[i] ?? { id: `${i + 1}號` })
}
function speechPhaseLabel(stage: SheriffStage): string {
  if (stage === 'speech') return '警上'
  if (stage === 'runoffSpeech') return '警上 PK'
  if (stage === 'daySpeech') return '第一天警下'
  return '發言'
}
function speechesForSeat(transcript: string, seat: string): { phase: string; text: string }[] {
  if (!seat) return []
  return transcript
    .split(/(?=^(?:【[^】]+】)?\d+號：)/m)
    .map((block) => {
      const tagged = block.match(/^【([^】]+)】(\d+號)：([\s\S]*)$/)
      if (tagged) return { phase: tagged[1], seat: tagged[2], text: tagged[3].trim() }
      const legacy = block.match(/^(\d+號)：([\s\S]*)$/)
      return legacy ? { phase: '未分類', seat: legacy[1], text: legacy[2].trim() } : null
    })
    .filter((item): item is { phase: string; seat: string; text: string } => Boolean(item && item.seat === seat && item.text))
    .map(({ phase, text }) => ({ phase, text }))
}
function emptyBoard(): Board {
  return { players: 12, wolves: 4, roles: '狼人x3、狼王、預言家、女巫、獵人、守衛、平民x4', seats: makeSeats(12, []), note: '' }
}
function emptyLiveFlow(): LiveFlow {
  return {
    sheriffSeats: [],
    firstSpeaker: '',
    direction: 'asc',
    ready: false,
    stage: 'speech',
    spokenSeats: [],
    votes: {},
    runoffCandidates: [],
    sheriffWinner: '',
    deathSeats: [],
    dayVotes: {},
  }
}

// 常見 12 人板子預設。點了會覆蓋板子設定（座位指派保留可再編輯）。
// note 會帶特殊角色技能說明，讓 AI 判狼時看得懂這些角色——內容可依你們的實際規則修改。
const PRESETS: { name: string; players: number; wolves: number; roles: string; note: string }[] = [
  {
    name: '孤獨少女',
    players: 12,
    wolves: 4,
    roles: '狼人x4、預言家、女巫、獵人、守衛、孤獨少女（暗戀者）、平民x3',
    note: '孤獨少女（暗戀者）為變動陣營：首夜最先睜眼選一名玩家為暗戀對象，獲勝條件與對象一致——對象陣營勝她就勝。她不知道對象的底牌，對象也不知道自己被暗戀。守衛每晚守護一人免疫狼刀，不可連守同一人。判讀時注意：少女的發言會傾向保護/跟隨某個特定玩家，且她自己不確定站哪邊，發言常搖擺。',
  },
  {
    name: '血月獵魔人',
    players: 12,
    wolves: 4,
    roles: '狼人x3、赤月使徒、預言家、女巫、獵魔人、愚者、平民x4',
    note: '赤月使徒屬狼陣營，可自爆：自爆後直接進入黑夜，當晚所有好人技能被封印；若是最後一隻被放逐的狼可多活到隔天白天。獵魔人從第二晚起每晚可狩獵一人：獵到狼則狼隔天出局，獵到好人則獵魔人自己隔天出局；女巫毒藥對獵魔人無效。愚者被放逐時翻牌免除放逐，之後無投票權也不能被投票、不能接警徽，但可發言。',
  },
  {
    name: '狼王守衛',
    players: 12,
    wolves: 4,
    roles: '狼人x3、狼王、預言家、女巫、獵人、守衛、平民x4',
    note: '狼王出局時（夜間被刀或白天被放逐）可發動狼王爪帶走一名玩家；被女巫毒出局或自爆時不能發動。守衛每晚守護一人免疫狼刀，不可連守同一人；同守同救會奶穿。',
  },
  {
    name: '狼王攝夢人',
    players: 12,
    wolves: 4,
    roles: '狼人x3、狼王、預言家、女巫、獵人、攝夢人、平民x4',
    note: '狼王出局時（夜間被刀或白天被放逐）可發動狼王爪帶走一名玩家；被毒或自爆不能發動。攝夢人每晚夢遊一名玩家使其當晚免疫狼刀，不可連續兩晚夢遊同一人；攝夢人出局當晚被夢遊者一同出局。',
  },
  {
    name: '石像鬼守墓人',
    players: 12,
    wolves: 4,
    roles: '狼人x3、石像鬼、預言家、女巫、獵人、守墓人、平民x4',
    note: '石像鬼屬狼陣營但不與狼互知身分，每晚可查驗一名玩家的具體身分（狼隊的預言家）。守墓人每晚得知當天白天被放逐玩家的陣營。',
  },
]

// 單一座位鈕（實戰畫面左右兩排用）。speak 模式點擊切換發言者；out 模式點擊標記出局。
function SeatButton({
  seat,
  isMe,
  active,
  onClick,
  gradient,
  inputStyle,
}: {
  seat: Seat
  isMe: boolean
  active: boolean
  onClick: () => void
  gradient: string
  inputStyle: React.CSSProperties
}) {
  const style: React.CSSProperties = seat.out
    ? { background: 'rgba(255,255,255,0.02)', color: '#475569', border: '1px solid rgba(255,255,255,0.04)' }
    : active
      ? { background: gradient, color: '#fff' }
      : { ...inputStyle, color: isMe ? '#c4b5fd' : '#e2e8f0' }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active || seat.out}
      aria-label={`${seat.id}${seat.player ? ` ${seat.player}` : ''}${active ? '，正在發言' : ''}${seat.out ? '，已出局' : ''}`}
      className={`relative min-h-14 rounded-xl px-2 py-2 text-left transition-all active:scale-95 ${active ? 'ring-2 ring-violet-300/70 shadow-lg shadow-violet-950/50' : ''}`}
      style={{ ...style, opacity: seat.out ? 0.5 : 1 }}
    >
      {active && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-400 animate-pulse" />}
      <div className="flex items-center gap-1 text-sm font-semibold">
        {seat.out && '💀'}
        <span style={seat.out ? { textDecoration: 'line-through' } : undefined}>{seat.id}</span>
        {isMe && <span className="text-xs">★</span>}
      </div>
      {seat.player && <div className="text-[11px] opacity-80 truncate">{seat.player}</div>}
      {seat.claim && <div className="text-[11px] opacity-70 truncate">「{seat.claim}」</div>}
    </button>
  )
}

export default function WerewolfPage() {
  const [hydrated, setHydrated] = useState(false)
  const [tab, setTab] = useState<'game' | 'roster' | 'lessons' | 'history'>('game')
  const [phase, setPhase] = useState<Phase>('setup')

  // 本局狀態
  const [board, setBoard] = useState<Board>(emptyBoard)
  const [transcript, setTranscript] = useState('')
  const [transcriptDraft, setTranscriptDraft] = useState('')
  const transcriptDraftRef = useRef('')
  const [events, setEvents] = useState<string[]>([]) // 戰況記錄：出局/票型/警長…
  const [eventInput, setEventInput] = useState('')
  const [notes, setNotes] = useState<string[]>([]) // AI 場邊筆記（逐段自動萃取）
  const notesRef = useRef<string[]>([])

  // 實戰畫面：點座位的模式（發言切換/出局標記）、中間資訊流分頁
  const [seatMode, setSeatMode] = useState<'speak' | 'out'>('speak')
  const [feedTab, setFeedTab] = useState<'notes' | 'transcript' | 'events'>('notes')
  const feedRef = useRef<HTMLDivElement | null>(null)
  const [liveFlow, setLiveFlow] = useState<LiveFlow>(emptyLiveFlow)
  const [judgement, setJudgement] = useState<Judgement | null>(null)
  const [gameId, setGameId] = useState<string>(uid)

  // 目前發言者（錄音時點座位切換，逐字稿自動掛名）
  const [speaker, setSpeaker] = useState('')
  const speakerRef = useRef('')

  // 教訓庫 / 歷史 / 玩家名冊
  const [lessons, setLessons] = useState<Lesson[]>([])
  const [games, setGames] = useState<Game[]>([])
  const [roster, setRoster] = useState<RosterPlayer[]>([])
  const [rosterInput, setRosterInput] = useState('')

  // 復盤
  const [truth, setTruth] = useState<Truth[]>([])
  const [resultText, setResultText] = useState('')
  const [accuracyNote, setAccuracyNote] = useState('')

  // UI 狀態
  const [judging, setJudging] = useState(false)
  const [reflecting, setReflecting] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recMode, setRecMode] = useState<'mic' | 'tab'>('mic')
  const [toneMode, setToneMode] = useState(true) // 語氣標註（Gemini 聽音檔）
  const toneModeRef = useRef(true)
  const [error, setError] = useState('')

  // 錄音用 ref
  const recordingRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)

  // ---- 載入 localStorage ----
  useEffect(() => {
    setLessons(load<Lesson[]>(LS.lessons, []))
    setGames(load<Game[]>(LS.games, []))
    // 名冊：確保有一張「阿康之神」（使用者本人）的卡
    const r = load<RosterPlayer[]>(LS.roster, [])
    if (!r.some((p) => p.isMe)) {
      const seeded = [{ id: uid(), name: '阿康之神', isMe: true }, ...r]
      setRoster(seeded)
      save(LS.roster, seeded)
    } else {
      setRoster(r)
    }
    const cur = load<(Partial<Game> & { phase?: Phase }) | null>(LS.current, null)
    if (cur && cur.board) {
      const shouldClearStaleTranscript = localStorage.getItem(LS.staleTranscriptCleared) !== '1'
      const shouldSeedBlindTest = localStorage.getItem(LS.blindTest2Seeded) !== '1'
      const seededBoard = shouldSeedBlindTest
        ? { ...cur.board, seats: cur.board.seats.map((s) => ({ ...s, out: false })) }
        : cur.board
      setBoard(seededBoard)
      setTranscript(shouldSeedBlindTest ? WEREWOLF_BLIND_TEST_2_TRANSCRIPT : shouldClearStaleTranscript ? '' : (cur.transcript ?? ''))
      setEvents(shouldSeedBlindTest ? WEREWOLF_BLIND_TEST_2_EVENTS : (cur.events ?? []))
      setNotes(shouldClearStaleTranscript || shouldSeedBlindTest ? [] : (cur.notes ?? []))
      notesRef.current = shouldClearStaleTranscript || shouldSeedBlindTest ? [] : (cur.notes ?? [])
      setJudgement(shouldClearStaleTranscript || shouldSeedBlindTest ? null : (cur.judgement ?? null))
      const savedFlow = (cur as Partial<Game> & { liveFlow?: Partial<LiveFlow> }).liveFlow
      setLiveFlow(shouldSeedBlindTest
        ? {
            ...emptyLiveFlow(),
            ready: true,
            stage: 'dayVote',
            sheriffSeats: ['2號', '4號', '6號', '9號'],
            firstSpeaker: '7號',
            direction: 'asc',
            sheriffWinner: '6號',
            spokenSeats: seededBoard.seats.map((s) => s.id),
          }
        : { ...emptyLiveFlow(), ...savedFlow })
      setGameId(cur.id ?? uid())
      setPhase(shouldSeedBlindTest ? 'live' : (cur.phase ?? 'setup'))
      if (shouldClearStaleTranscript) {
        save(LS.current, { ...cur, transcript: '', notes: [], judgement: null })
        localStorage.setItem(LS.staleTranscriptCleared, '1')
      }
      if (shouldSeedBlindTest) {
        save(LS.current, {
          ...cur,
          board: seededBoard,
          transcript: WEREWOLF_BLIND_TEST_2_TRANSCRIPT,
          events: WEREWOLF_BLIND_TEST_2_EVENTS,
          notes: [],
          judgement: null,
          phase: 'live',
          liveFlow: {
            ...emptyLiveFlow(),
            ready: true,
            stage: 'dayVote',
            sheriffSeats: ['2號', '4號', '6號', '9號'],
            firstSpeaker: '7號',
            direction: 'asc',
            sheriffWinner: '6號',
            spokenSeats: seededBoard.seats.map((s) => s.id),
          },
        })
        localStorage.setItem(LS.blindTest2Seeded, '1')
      }
    }
    setHydrated(true)
  }, [])

  // ---- 自動存本局進度 ----
  useEffect(() => {
    if (!hydrated) return
    save(LS.current, { id: gameId, board, transcript, events, notes, judgement, phase, liveFlow })
  }, [hydrated, gameId, board, transcript, events, notes, judgement, phase, liveFlow])

  // ---- 資訊流有新內容就自動捲到底 ----
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [notes, events, feedTab])

  // ---- 「阿康之神」指派到哪格，那格就是我的座位 ----
  useEffect(() => {
    const meName = roster.find((p) => p.isMe)?.name
    const mySeat = meName ? board.seats.find((s) => s.player === meName)?.id : undefined
    if (board.mySeat !== mySeat) setBoard((b) => ({ ...b, mySeat }))
  }, [board.seats, board.mySeat, roster])

  // ---- 板子調整 ----
  function setPlayers(n: number) {
    const players = Math.max(2, Math.min(20, n || 0))
    setBoard((b) => ({ ...b, players, seats: makeSeats(players, b.seats) }))
  }
  function setSeat(i: number, patch: Partial<Seat>) {
    setBoard((b) => ({ ...b, seats: b.seats.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }))
  }
  function addEvent(text: string) {
    const value = text.trim()
    if (!value) return
    setEvents((prev) => [...prev, value])
    setEventInput('')
  }
  function applyPreset(p: (typeof PRESETS)[number]) {
    setBoard((b) => ({
      ...b,
      players: p.players,
      wolves: p.wolves,
      roles: p.roles,
      note: p.note,
      seats: makeSeats(p.players, b.seats),
    }))
  }

  // ---- 錄音：點發言者切段 ----
  async function startRecording() {
    setError('')
    try {
      let stream: MediaStream
      if (recMode === 'tab') {
        // 電腦分頁內錄：要在分享對話框勾「分享分頁音訊」
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        const audioTracks = display.getAudioTracks()
        if (audioTracks.length === 0) {
          display.getTracks().forEach((t) => t.stop())
          throw new Error('沒抓到分頁音訊——分享時請勾選「分享分頁音訊」，或改用麥克風模式')
        }
        display.getVideoTracks().forEach((t) => t.stop()) // 不需要畫面
        stream = new MediaStream(audioTracks)
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      }
      streamRef.current = stream
      recordingRef.current = true
      setRecording(true)
      recordSegment()
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法開始錄音（可能是權限被拒）')
      setRecording(false)
      recordingRef.current = false
    }
  }

  function recordSegment() {
    const stream = streamRef.current
    if (!stream || !recordingRef.current) return
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : ''
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    recorderRef.current = rec
    const segSpeaker = speakerRef.current // 這一段開始時的發言者
    const segPhase = speechPhaseLabel(liveFlow.stage)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: mime || 'audio/webm' })
      if (recordingRef.current) recordSegment() // 先無縫接下一段，轉錄慢慢跑
      if (blob.size > 1000) await sendForTranscription(blob, segSpeaker, segPhase)
    }
    rec.start()
    // 保險上限：單段太長就自動切（發言者不變）
    setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop()
    }, MAX_SEGMENT_MS)
  }

  // 換人發言：點座位 → 切掉當前段（掛上一位的名字）、開新段（掛新發言者）
  function switchSpeaker(next: string) {
    const previous = speakerRef.current
    if (previous && previous !== next) commitTranscriptDraft(previous)
    const same = speakerRef.current === next
    speakerRef.current = same ? '' : next // 再點一次同座位 = 取消掛名
    setSpeaker(speakerRef.current)
    if (recording && recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop() // onstop 會自動開新段（用新的 speakerRef）
    }
  }

  function commitTranscriptDraft(seat = speakerRef.current) {
    const text = transcriptDraftRef.current.trim()
    if (!seat || !text) return
    const entry = `【${speechPhaseLabel(liveFlow.stage)}】${seat}：${text}`
    setTranscript((current) => current ? `${current}\n${entry}` : entry)
    void autoTakeNotes(entry)
    transcriptDraftRef.current = ''
    setTranscriptDraft('')
  }

  function nextSpeaker() {
    const candidateIds = liveFlow.stage === 'daySpeech'
      ? board.seats.map((s) => s.id)
      : liveFlow.stage === 'runoffSpeech'
        ? liveFlow.runoffCandidates
        : liveFlow.sheriffSeats
    const available = board.seats.filter((s) => !s.out && candidateIds.includes(s.id))
    if (!available.length) return
    const justSpoken = speakerRef.current
    commitTranscriptDraft(justSpoken)
    const spoken = Array.from(new Set([...liveFlow.spokenSeats, justSpoken].filter(Boolean)))
    if (available.every((s) => spoken.includes(s.id))) {
      if (recording) stopRecording()
      speakerRef.current = ''
      setSpeaker('')
      if (liveFlow.stage === 'daySpeech') {
        setEvents((prev) => [...prev, '警長指定發言輪次完成'])
        setLiveFlow((flow) => ({ ...flow, spokenSeats: spoken, stage: 'dayVote', dayVotes: {} }))
        return
      }
      setLiveFlow((flow) => ({
        ...flow,
        spokenSeats: spoken,
        votes: {},
        stage: flow.stage === 'runoffSpeech' ? 'runoffVote' : 'vote',
      }))
      setFeedTab('events')
      return
    }
    const currentIndex = available.findIndex((s) => s.id === justSpoken)
    const step = liveFlow.direction === 'asc' ? 1 : -1
    let nextIndex = currentIndex
    do {
      nextIndex = nextIndex < 0
        ? Math.max(0, available.findIndex((s) => s.id === liveFlow.firstSpeaker))
        : (nextIndex + step + available.length) % available.length
    } while (spoken.includes(available[nextIndex].id))
    setLiveFlow((flow) => ({ ...flow, spokenSeats: spoken }))
    switchSpeaker(available[nextIndex].id)
    if (!recording) void startRecording()
  }

  function setSheriffVote(voter: string, target: string) {
    setLiveFlow((flow) => ({ ...flow, votes: { ...flow.votes, [voter]: target } }))
  }

  async function finishSheriffVote() {
    const candidates = liveFlow.stage === 'runoffVote' ? liveFlow.runoffCandidates : liveFlow.sheriffSeats
    const counts = Object.values(liveFlow.votes).reduce<Record<string, number>>((acc, target) => {
      if (target !== '棄票') acc[target] = (acc[target] ?? 0) + 1
      return acc
    }, {})
    const maxVotes = Math.max(0, ...candidates.map((id) => counts[id] ?? 0))
    const leaders = candidates.filter((id) => (counts[id] ?? 0) === maxVotes && maxVotes > 0)
    const roundLabel = liveFlow.stage === 'runoffVote' ? '警長第二輪票型' : '警長第一輪票型'
    const voteLine = board.seats
      .filter((s) => liveFlow.votes[s.id])
      .map((s) => `${s.id}→${liveFlow.votes[s.id]}`)
      .join('、')
    setEvents((prev) => [...prev, `${roundLabel}：${voteLine || '無投票紀錄'}`])

    if (leaders.length > 1) {
      const ordered = board.seats.filter((s) => leaders.includes(s.id)).map((s) => s.id)
      if (liveFlow.direction === 'desc') ordered.reverse()
      const first = ordered[0]
      setEvents((prev) => [...prev, `警長平票：${leaders.join('、')}，進入PK發言`])
      setLiveFlow((flow) => ({
        ...flow,
        stage: 'runoffSpeech',
        runoffCandidates: leaders,
        spokenSeats: [],
        votes: {},
        firstSpeaker: first,
      }))
      speakerRef.current = first
      setSpeaker(first)
      setSeatMode('speak')
      if (!recording) await startRecording()
      return
    }

    const winner = leaders[0]
    setEvents((prev) => [...prev, winner ? `警長當選：${winner}` : '警長投票：無人當選'])
    setLiveFlow((flow) => ({ ...flow, stage: winner ? 'deathReport' : 'done', sheriffWinner: winner ?? '', votes: {}, firstSpeaker: '', spokenSeats: [], deathSeats: [] }))
  }

  function confirmDeathReport(safeNight: boolean) {
    if (!safeNight && liveFlow.deathSeats.length === 0) {
      setError('請勾選倒牌玩家，或選擇平安夜')
      return
    }
    setError('')
    if (safeNight) {
      setEvents((prev) => [...prev, '昨夜死訊：平安夜'])
    } else {
      setEvents((prev) => [...prev, `昨夜死訊：${liveFlow.deathSeats.join('、')}倒牌`])
      setBoard((b) => ({
        ...b,
        seats: b.seats.map((s) => liveFlow.deathSeats.includes(s.id) ? { ...s, out: true } : s),
      }))
    }
    setLiveFlow((flow) => ({ ...flow, stage: 'daySetup', firstSpeaker: '' }))
  }

  async function beginDaySpeech() {
    const alive = board.seats.filter((s) => !s.out)
    const sheriffIndex = alive.findIndex((s) => s.id === liveFlow.sheriffWinner)
    if (sheriffIndex < 0 || alive.length < 2) {
      setError('警長已出局，或場上沒有足夠的存活玩家')
      return
    }
    const step = liveFlow.direction === 'asc' ? 1 : -1
    const firstSpeaker = alive[(sheriffIndex + step + alive.length) % alive.length].id
    setEvents((prev) => [
      ...prev,
      `警長${liveFlow.sheriffWinner}指定：${liveFlow.direction === 'asc' ? '警右' : '警左'}開始，${firstSpeaker}首位發言`,
    ])
    setLiveFlow((flow) => ({ ...flow, stage: 'daySpeech', spokenSeats: [], firstSpeaker }))
    speakerRef.current = firstSpeaker
    setSpeaker(firstSpeaker)
    setSeatMode('speak')
    if (!recording) await startRecording()
  }

  function setDayVote(voter: string, target: string) {
    setLiveFlow((flow) => ({ ...flow, dayVotes: { ...flow.dayVotes, [voter]: target } }))
  }

  function finishDayVote() {
    const alive = board.seats.filter((s) => !s.out)
    const counts = Object.entries(liveFlow.dayVotes).reduce<Record<string, number>>((acc, [voter, target]) => {
      if (target !== '棄票') acc[target] = (acc[target] ?? 0) + (voter === liveFlow.sheriffWinner ? 1.5 : 1)
      return acc
    }, {})
    const maxVotes = Math.max(0, ...alive.map((s) => counts[s.id] ?? 0))
    const leaders = alive.filter((s) => (counts[s.id] ?? 0) === maxVotes && maxVotes > 0).map((s) => s.id)
    const voteLine = alive
      .filter((s) => liveFlow.dayVotes[s.id])
      .map((s) => `${s.id}${s.id === liveFlow.sheriffWinner ? '(警長)' : ''}→${liveFlow.dayVotes[s.id]}`)
      .join('、')
    const result = leaders.length === 1
      ? `${leaders[0]}放逐出局（${maxVotes}票）`
      : leaders.length > 1
        ? `${leaders.join('、')}平票（${maxVotes}票）`
        : '無人被放逐'
    setEvents((prev) => [...prev, `第一天放逐票型：${voteLine || '無投票紀錄'}`, `第一天放逐結果：${result}`])
    if (leaders.length === 1) {
      setBoard((b) => ({ ...b, seats: b.seats.map((s) => s.id === leaders[0] ? { ...s, out: true } : s) }))
    }
    setLiveFlow((flow) => ({ ...flow, stage: 'done' }))
  }

  async function beginLiveFlow() {
    if (!liveFlow.firstSpeaker) {
      setError('請先選擇首位發言者')
      return
    }
    const sheriffEvent = liveFlow.sheriffSeats.length
      ? `上警名單：${liveFlow.sheriffSeats.join('、')}`
      : '上警名單：無人上警'
    const orderEvent = `首位發言：${liveFlow.firstSpeaker}，${liveFlow.direction === 'asc' ? '順序' : '逆序'}發言`
    setEvents((prev) => [
      ...prev.filter((e) => !e.startsWith('上警名單：') && !e.startsWith('首位發言：')),
      sheriffEvent,
      orderEvent,
    ])
    setLiveFlow((flow) => ({ ...flow, ready: true, stage: 'speech', spokenSeats: [], votes: {}, runoffCandidates: [], sheriffWinner: '', deathSeats: [], dayVotes: {} }))
    speakerRef.current = liveFlow.firstSpeaker
    setSpeaker(liveFlow.firstSpeaker)
    setSeatMode('speak')
    if (!recording) await startRecording()
  }

  function stopRecording() {
    recordingRef.current = false
    setRecording(false)
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  async function sendForTranscription(blob: Blob, segSpeaker?: string, segPhase = speechPhaseLabel(liveFlow.stage)) {
    setTranscribing(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('audio', blob, 'segment.webm')
      fd.append('mode', toneModeRef.current ? 'tone' : 'plain')
      const res = await fetch('/api/tools/werewolf', { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '轉錄失敗')
      const text = (json.text ?? '').trim()
      if (text) {
        // 有指定發言者 → 自動掛名
        const entry = segSpeaker ? `【${segPhase}】${segSpeaker}：${text}` : text
        setTranscript((t) => (t ? t + '\n' + entry : entry))
        void autoTakeNotes(entry) // AI 背景做筆記，不擋轉錄
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '轉錄失敗')
    } finally {
      setTranscribing(false)
    }
  }

  // AI 場邊筆記：轉錄完一段就萃取所有有用資訊（跳身分、質疑、站邊、矛盾…）。
  // 靜默失敗（筆記只是輔助，不要跳錯誤打斷對局）；筆記可手動刪。
  async function autoTakeNotes(segment: string) {
    try {
      const res = await fetch('/api/tools/werewolf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'notes',
          segment,
          seats: board.seats.map((s) => ({ id: s.id, player: s.player })),
          existingNotes: notesRef.current,
        }),
      })
      const json = await res.json()
      if (!res.ok || !Array.isArray(json.notes) || json.notes.length === 0) return
      notesRef.current = [...notesRef.current, ...json.notes]
      setNotes(notesRef.current)
    } catch {
      // 靜默：筆記失敗不影響主流程
    }
  }

  async function onUploadAudio(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) await sendForTranscription(file)
    e.target.value = ''
  }

  // ---- 判狼 ----
  async function runJudge() {
    if (!transcript.trim()) {
      setError('還沒有逐字稿')
      return
    }
    setJudging(true)
    setError('')
    try {
      const res = await fetch('/api/tools/werewolf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'judge',
          board,
          transcript,
          events,
          notes,
          lessons: lessons.map((l) => ({ title: l.title, insight: l.insight })),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '判狼失敗')
      setJudgement(json.judgement)
    } catch (err) {
      setError(err instanceof Error ? err.message : '判狼失敗')
    } finally {
      setJudging(false)
    }
  }

  // ---- 復盤 ----
  function toggleTruthWolf(seat: string) {
    setTruth((prev) => {
      const found = prev.find((t) => t.seat === seat)
      if (found) return prev.map((t) => (t.seat === seat ? { ...t, isWolf: !t.isWolf } : t))
      return [...prev, { seat, role: '', isWolf: true }]
    })
  }
  function setTruthRole(seat: string, role: string) {
    setTruth((prev) => {
      const found = prev.find((t) => t.seat === seat)
      if (found) return prev.map((t) => (t.seat === seat ? { ...t, role } : t))
      return [...prev, { seat, role, isWolf: false }]
    })
  }
  function truthFor(seat: string): Truth {
    return truth.find((t) => t.seat === seat) ?? { seat, role: '', isWolf: false }
  }

  function computeAccuracy(): number | null {
    if (!judgement) return null
    // 我自己的座位不算——AI 不判使用者本人
    const actualWolves = truth.filter((t) => t.isWolf && t.seat !== board.mySeat).map((t) => t.seat)
    if (actualWolves.length === 0) return null
    const predicted = judgement.topWolves.slice(0, actualWolves.length)
    const hits = predicted.filter((p) => actualWolves.includes(p)).length
    return Math.round((hits / actualWolves.length) * 100)
  }

  async function runReflect() {
    const filledTruth = board.seats.map((s) => {
      const t = truthFor(s.id)
      // 我的座位自動帶入明身份
      if (s.id === board.mySeat && !t.role && board.myRole) return { ...t, role: board.myRole }
      return t
    })
    if (!filledTruth.some((t) => t.isWolf)) {
      setError('復盤前先標出這局真正的狼是誰')
      return
    }
    setReflecting(true)
    setError('')
    try {
      const res = await fetch('/api/tools/werewolf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reflect',
          board,
          transcript,
          events,
          prediction: judgement,
          truth: filledTruth,
          result: resultText,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? '復盤失敗')
      setAccuracyNote(json.accuracyNote ?? '')

      const acc = computeAccuracy()
      // 存教訓
      const newLessons: Lesson[] = (json.lessons ?? []).map((l: { title: string; insight: string }) => ({
        id: uid(),
        ts: Date.now(),
        gameId,
        title: l.title,
        insight: l.insight,
      }))
      const mergedLessons = [...lessons, ...newLessons]
      setLessons(mergedLessons)
      save(LS.lessons, mergedLessons)

      // 存這局到歷史
      const game: Game = {
        id: gameId,
        createdAt: Date.now(),
        board,
        transcript,
        events,
        notes,
        judgement,
        truth: filledTruth,
        result: resultText,
        accuracy: acc,
      }
      const mergedGames = [game, ...games.filter((g) => g.id !== gameId)]
      setGames(mergedGames)
      save(LS.games, mergedGames)
    } catch (err) {
      setError(err instanceof Error ? err.message : '復盤失敗')
    } finally {
      setReflecting(false)
    }
  }

  function newGame() {
    if (!confirm('開新的一局？目前這局若還沒復盤存檔會清掉。')) return
    if (recording) stopRecording()
    setBoard(emptyBoard())
    setTranscript('')
    setTranscriptDraft('')
    transcriptDraftRef.current = ''
    setEvents([])
    setEventInput('')
    setNotes([])
    notesRef.current = []
    setJudgement(null)
    setTruth([])
    setResultText('')
    setAccuracyNote('')
    setGameId(uid())
    setSpeaker('')
    speakerRef.current = ''
    setLiveFlow(emptyLiveFlow())
    setPhase('setup')
  }

  function deleteLesson(id: string) {
    const next = lessons.filter((l) => l.id !== id)
    setLessons(next)
    save(LS.lessons, next)
  }

  // ---- 備份匯出/匯入 ----
  function exportBackup() {
    const data = { lessons, games, roster, exportedAt: Date.now() }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `狼人殺筆記備份_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
  function importBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result))
        if (Array.isArray(data.lessons)) {
          setLessons(data.lessons)
          save(LS.lessons, data.lessons)
        }
        if (Array.isArray(data.games)) {
          setGames(data.games)
          save(LS.games, data.games)
        }
        if (Array.isArray(data.roster)) {
          setRoster(data.roster)
          save(LS.roster, data.roster)
        }
        alert('匯入完成')
      } catch {
        alert('檔案格式不對')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const avgAccuracy =
    games.filter((g) => g.accuracy != null).length > 0
      ? Math.round(
          games.filter((g) => g.accuracy != null).reduce((s, g) => s + (g.accuracy ?? 0), 0) /
            games.filter((g) => g.accuracy != null).length,
        )
      : null

  const aliveCount = board.seats.filter((s) => !s.out).length

  // ---- 樣式 helper ----
  const cardStyle = { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }
  const inputStyle = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }
  const gradient = 'linear-gradient(135deg, #6366f1, #8b5cf6)'

  return (
    <main className={`relative mx-auto px-3 sm:px-6 py-5 sm:py-8 transition-[max-width] ${tab === 'game' && phase === 'live' ? 'max-w-5xl' : 'max-w-2xl'}`}>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl sm:text-3xl font-semibold text-white tracking-[-0.02em]">狼人殺筆記</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
      </div>

      {/* 分頁 */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {([['game', '本局'], ['roster', `名冊 ${roster.length}`], ['lessons', `教訓庫 ${lessons.length}`], ['history', `歷史 ${games.length}`]] as const).map(
          ([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="px-4 py-2 rounded-full text-sm font-medium transition-colors"
              style={
                tab === key
                  ? { background: gradient, color: '#fff' }
                  : { background: 'rgba(255,255,255,0.04)', color: '#94a3b8' }
              }
            >
              {label}
            </button>
          ),
        )}
      </div>

      {error && (
        <div
          className="mb-5 rounded-xl px-4 py-3 text-sm text-red-400"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)' }}
        >
          {error}
        </div>
      )}

      {/* ============ 本局 ============ */}
      {tab === 'game' && (
        <div className="space-y-5">
          {/* 階段指示 */}
          <div className="flex items-center gap-2 text-sm">
            {(
              [
                ['setup', '① 開局設定'],
                ['live', '② 實戰'],
                ['review', '③ 復盤'],
              ] as const
            ).map(([p, label], i) => (
              <span key={p} className="flex items-center gap-2">
                {i > 0 && <span className="text-slate-700">→</span>}
                <button
                  onClick={() => setPhase(p)}
                  className="px-3 py-1 rounded-full text-xs font-medium"
                  style={
                    phase === p
                      ? { background: 'rgba(139,92,246,0.2)', color: '#c4b5fd', border: '1px solid rgba(139,92,246,0.4)' }
                      : { color: '#64748b' }
                  }
                >
                  {label}
                </button>
              </span>
            ))}
            <button onClick={newGame} className="ml-auto text-xs text-slate-500 hover:text-slate-300 underline decoration-dotted">
              開新一局
            </button>
          </div>

          {/* ======== 階段一：開局設定 ======== */}
          {phase === 'setup' && (
            <>
              <section className="rounded-2xl p-4" style={cardStyle}>
                <h2 className="text-white font-medium mb-3">板子</h2>
                <div className="flex flex-wrap gap-2 mb-4">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => applyPreset(p)}
                      className="px-3 py-1.5 rounded-full text-xs transition-colors"
                      style={
                        board.roles === p.roles
                          ? { background: gradient, color: '#fff' }
                          : { ...inputStyle, color: '#94a3b8' }
                      }
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <label className="text-sm text-slate-400">
                    玩家人數
                    <input
                      type="number"
                      value={board.players}
                      onChange={(e) => setPlayers(Number(e.target.value))}
                      className="mt-1 w-full rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                      style={inputStyle}
                    />
                  </label>
                  <label className="text-sm text-slate-400">
                    狼人數量
                    <input
                      type="number"
                      value={board.wolves}
                      onChange={(e) => setBoard((b) => ({ ...b, wolves: Math.max(1, Number(e.target.value) || 1) }))}
                      className="mt-1 w-full rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                      style={inputStyle}
                    />
                  </label>
                </div>
                <label className="text-sm text-slate-400 block mb-3">
                  身分配置
                  <input
                    value={board.roles}
                    onChange={(e) => setBoard((b) => ({ ...b, roles: e.target.value }))}
                    className="mt-1 w-full rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                    style={inputStyle}
                  />
                </label>
                <textarea
                  value={board.note ?? ''}
                  onChange={(e) => setBoard((b) => ({ ...b, note: e.target.value }))}
                  placeholder="板規／特殊角色技能說明（點預設會自動帶入，可修改）"
                  rows={3}
                  className="w-full rounded-lg px-3 py-2 text-slate-300 text-xs placeholder-slate-600 focus:outline-none leading-relaxed"
                  style={inputStyle}
                />
              </section>

              <section className="rounded-2xl p-4" style={cardStyle}>
                <h2 className="text-white font-medium mb-1">我（阿康之神）</h2>
                <p className="text-xs text-slate-500 mb-3">
                  在下方座位指派把「阿康之神」放到你的座位，那格就是你
                  {board.mySeat ? <span className="text-violet-300">（目前：{board.mySeat}★）</span> : <span className="text-amber-400">（還沒指派）</span>}
                  。身份填了 AI 就當確定資訊推理。
                </p>
                <label className="text-sm text-slate-400 block">
                  我的真實身份
                  <input
                    value={board.myRole ?? ''}
                    onChange={(e) => setBoard((b) => ({ ...b, myRole: e.target.value || undefined }))}
                    placeholder="例：女巫（明牌給 AI，其他跳女巫的必為假跳）"
                    className="mt-1 w-full rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none"
                    style={inputStyle}
                  />
                </label>
              </section>

              <section className="rounded-2xl p-4" style={cardStyle}>
                <h2 className="text-white font-medium mb-1">座位指派</h2>
                <p className="text-xs text-slate-500 mb-3">
                  把名冊玩家指派到座位（教訓會綁定玩家跨局累積）。
                  {roster.length === 0 && (
                    <button onClick={() => setTab('roster')} className="ml-1 text-violet-400 underline decoration-dotted">
                      先去登記牌友 →
                    </button>
                  )}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {board.seats.map((s, i) => (
                    <div key={i} className="flex gap-1.5 items-center">
                      <span className={`w-12 text-sm shrink-0 ${board.mySeat === s.id ? 'text-violet-300' : 'text-white'}`}>
                        {s.id}{board.mySeat === s.id ? '★' : ''}
                      </span>
                      <select
                        value={s.player ?? ''}
                        onChange={(e) => setSeat(i, { player: e.target.value || undefined })}
                        className="flex-1 min-w-0 rounded-lg px-2 py-1.5 text-sm focus:outline-none"
                        style={{ ...inputStyle, color: s.player ? '#c4b5fd' : '#64748b' }}
                      >
                        <option value="">（路人）</option>
                        {roster.map((p) => (
                          <option key={p.id} value={p.name}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </section>

              <button
                onClick={() => setPhase('live')}
                className="w-full py-3 rounded-full text-white font-medium"
                style={{ background: gradient }}
              >
                開始對局 →
              </button>
            </>
          )}

          {/* ======== 階段二：實戰 ======== */}
          {phase === 'live' && (
            <>
              {!liveFlow.ready ? (
                <section className="rounded-2xl p-4 sm:p-5" style={{ ...cardStyle, border: '1px solid rgba(139,92,246,0.28)' }}>
                  <div className="mb-5">
                    <p className="text-xs font-medium text-violet-300">實戰開始前</p>
                    <h2 className="mt-1 text-lg font-semibold text-white">設定本輪發言流程</h2>
                    <p className="mt-1 text-xs text-slate-500">完成後會從首位發言者開始錄音，之後只要按「下一位」。</p>
                  </div>

                  <div className="mb-5">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-sm font-medium text-slate-200">1. 上警名單</p>
                      <button
                        type="button"
                        onClick={() => setLiveFlow((f) => ({ ...f, sheriffSeats: f.sheriffSeats.length === board.seats.length ? [] : board.seats.map((s) => s.id) }))}
                        className="text-xs text-slate-500 hover:text-slate-300"
                      >
                        {liveFlow.sheriffSeats.length === board.seats.length ? '全部取消' : '全部選取'}
                      </button>
                    </div>
                    <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5">
                      {board.seats.map((s) => {
                        const selected = liveFlow.sheriffSeats.includes(s.id)
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setLiveFlow((f) => ({
                              ...f,
                              sheriffSeats: selected ? f.sheriffSeats.filter((id) => id !== s.id) : [...f.sheriffSeats, s.id],
                            }))}
                            className="rounded-lg px-2 py-2 text-xs font-medium transition-colors"
                            style={selected ? { background: gradient, color: '#fff' } : { ...inputStyle, color: '#94a3b8' }}
                          >
                            {s.id}{selected ? ' ✓' : ''}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="text-sm font-medium text-slate-200">
                      2. 首位發言者
                      <select
                        value={liveFlow.firstSpeaker}
                        onChange={(e) => setLiveFlow((f) => ({ ...f, firstSpeaker: e.target.value }))}
                        className="mt-2 w-full rounded-lg px-3 py-2.5 text-sm focus:outline-none"
                        style={{ ...inputStyle, color: liveFlow.firstSpeaker ? '#fff' : '#64748b' }}
                      >
                        <option value="">請選座位</option>
                        {board.seats.filter((s) => liveFlow.sheriffSeats.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.id}{s.player ? `・${s.player}` : ''}</option>)}
                      </select>
                    </label>

                    <div>
                      <p className="text-sm font-medium text-slate-200">3. 發言順序</p>
                      <div className="mt-2 grid grid-cols-2 overflow-hidden rounded-lg" style={inputStyle}>
                        {([['asc', '順序 →'], ['desc', '逆序 ←']] as const).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setLiveFlow((f) => ({ ...f, direction: value }))}
                            className="px-3 py-2.5 text-sm"
                            style={liveFlow.direction === value ? { background: gradient, color: '#fff' } : { color: '#94a3b8' }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={beginLiveFlow}
                    className="mt-5 w-full rounded-full py-3 text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: gradient }}
                    disabled={!liveFlow.firstSpeaker || !liveFlow.sheriffSeats.includes(liveFlow.firstSpeaker)}
                  >
                    開始錄音・{liveFlow.firstSpeaker || '首位'}發言 →
                  </button>
                </section>
              ) : (
                <section className="sticky top-2 z-20 rounded-2xl p-3 shadow-2xl shadow-slate-950/70 backdrop-blur-xl" style={{ background: 'rgba(15,17,32,0.94)', border: '1px solid rgba(139,92,246,0.35)' }}>
                  {(liveFlow.stage === 'speech' || liveFlow.stage === 'runoffSpeech' || liveFlow.stage === 'daySpeech') ? <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-slate-500">
                        {liveFlow.stage === 'daySpeech' ? `警長 ${liveFlow.sheriffWinner} 指定發言` : liveFlow.stage === 'runoffSpeech' ? '平票 PK 發言' : '警上發言'}
                      </p>
                      <p className="truncate text-lg font-semibold text-white">🎙 {speaker || liveFlow.firstSpeaker}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (recording) stopRecording()
                        setLiveFlow((f) => ({ ...f, ready: false }))
                      }}
                      className="shrink-0 text-xs text-slate-500 hover:text-white"
                    >
                      修改流程
                    </button>
                    <button
                      type="button"
                      onClick={nextSpeaker}
                      className="shrink-0 rounded-full px-5 py-2.5 text-sm font-semibold text-white active:scale-95"
                      style={{ background: gradient }}
                    >
                      下一位 {liveFlow.direction === 'asc' ? '→' : '←'}
                    </button>
                  </div> : (
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] text-slate-500">警長競選</p>
                        <p className="truncate text-base font-semibold text-white">
                          {liveFlow.stage === 'done' ? '✓ 第一天投票完成' : liveFlow.stage === 'dayVote' ? '第一天放逐票型登記' : liveFlow.stage === 'deathReport' ? '等待宣布昨夜死訊' : liveFlow.stage === 'daySetup' ? `警長 ${liveFlow.sheriffWinner} 指定發言順序` : liveFlow.stage === 'runoffVote' ? '第二輪票型登記' : '第一輪票型登記'}
                        </p>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {(liveFlow.stage === 'vote' || liveFlow.stage === 'runoffVote') && (
                <section className="rounded-2xl p-4 sm:p-5" style={{ ...cardStyle, border: '1px solid rgba(245,158,11,0.25)' }}>
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-amber-300">{liveFlow.stage === 'runoffVote' ? '第二輪投票' : '警長投票'}</p>
                      <h2 className="mt-1 text-lg font-semibold text-white">登記誰投給誰</h2>
                      <p className="mt-1 text-xs text-slate-500">警上玩家不投票；每位警下玩家選候選人或棄票。</p>
                    </div>
                    <span className="shrink-0 rounded-full px-2.5 py-1 text-xs text-slate-400" style={inputStyle}>
                      已記 {Object.keys(liveFlow.votes).length}/{board.seats.filter((s) => !liveFlow.sheriffSeats.includes(s.id) && !s.out).length}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {board.seats.filter((s) => !liveFlow.sheriffSeats.includes(s.id) && !s.out).map((voter) => {
                      const candidates = liveFlow.stage === 'runoffVote' ? liveFlow.runoffCandidates : liveFlow.sheriffSeats
                      return (
                        <div key={voter.id} className="flex items-center gap-2">
                          <span className="w-12 shrink-0 text-sm font-medium text-white">{voter.id}</span>
                          <div className="flex flex-1 gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
                            {[...candidates, '棄票'].map((target) => (
                              <button
                                key={target}
                                type="button"
                                onClick={() => setSheriffVote(voter.id, target)}
                                className="shrink-0 rounded-lg px-3 py-2 text-xs font-medium"
                                style={liveFlow.votes[voter.id] === target
                                  ? target === '棄票'
                                    ? { background: 'rgba(100,116,139,.35)', color: '#fff', border: '1px solid rgba(148,163,184,.4)' }
                                    : { background: gradient, color: '#fff' }
                                  : { ...inputStyle, color: '#94a3b8' }}
                              >
                                {target === '棄票' ? target : `投 ${target}`}
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => void finishSheriffVote()}
                    className="mt-5 w-full rounded-full py-3 text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg,#d97706,#f59e0b)' }}
                    disabled={Object.keys(liveFlow.votes).length === 0}
                  >
                    完成計票
                  </button>
                </section>
              )}

              {liveFlow.stage === 'deathReport' && (
                <section className="rounded-2xl p-4 sm:p-5" style={{ ...cardStyle, border: '1px solid rgba(239,68,68,0.25)' }}>
                  <div className="mb-4">
                    <p className="text-xs font-medium text-red-300">警長 {liveFlow.sheriffWinner} 已當選</p>
                    <h2 className="mt-1 text-lg font-semibold text-white">宣布昨夜死訊</h2>
                    <p className="mt-1 text-xs text-slate-500">選擇平安夜，或勾選所有倒牌玩家；倒牌者會自動標記出局。</p>
                  </div>

                  <button
                    type="button"
                    onClick={() => confirmDeathReport(true)}
                    className="mb-4 w-full rounded-xl py-3 text-sm font-semibold text-emerald-300"
                    style={{ background: 'rgba(34,197,94,.09)', border: '1px solid rgba(34,197,94,.22)' }}
                  >
                    ☀️ 平安夜・無人倒牌
                  </button>

                  <p className="mb-2 text-xs font-medium text-slate-400">或勾選倒牌玩家</p>
                  <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                    {board.seats.filter((s) => !s.out).map((s) => {
                      const selected = liveFlow.deathSeats.includes(s.id)
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setLiveFlow((flow) => ({
                            ...flow,
                            deathSeats: selected ? flow.deathSeats.filter((id) => id !== s.id) : [...flow.deathSeats, s.id],
                          }))}
                          className="rounded-lg px-2 py-2.5 text-xs font-medium"
                          style={selected
                            ? { background: 'linear-gradient(135deg,#dc2626,#f97316)', color: '#fff' }
                            : { ...inputStyle, color: '#94a3b8' }}
                        >
                          {selected ? '💀 ' : ''}{s.id}
                        </button>
                      )
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => confirmDeathReport(false)}
                    disabled={liveFlow.deathSeats.length === 0}
                    className="mt-4 w-full rounded-full py-3 text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg,#dc2626,#f97316)' }}
                  >
                    確認死訊{liveFlow.deathSeats.length ? `・${liveFlow.deathSeats.join('、')}倒牌` : ''}
                  </button>
                </section>
              )}

              {liveFlow.stage === 'daySetup' && (
                <section className="rounded-2xl p-4 sm:p-5" style={{ ...cardStyle, border: '1px solid rgba(34,197,94,0.25)' }}>
                  <div className="mb-5">
                    <p className="text-xs font-medium text-emerald-300">警長 {liveFlow.sheriffWinner} 已拿到警徽</p>
                    <h2 className="mt-1 text-lg font-semibold text-white">登記警長指定的發言順序</h2>
                    <p className="mt-1 text-xs text-slate-500">選擇警左或警右開始；系統會從警長相鄰的存活玩家開始錄音，倒牌者自動跳過。</p>
                  </div>

                  <div>
                    <p className="text-sm font-medium text-slate-200">警長指定</p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {([['desc', '← 警左開始'], ['asc', '警右開始 →']] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setLiveFlow((f) => ({ ...f, direction: value }))}
                          className="rounded-xl px-3 py-4 text-sm font-semibold"
                          style={liveFlow.direction === value ? { background: gradient, color: '#fff' } : { ...inputStyle, color: '#94a3b8' }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void beginDaySpeech()}
                    className="mt-5 w-full rounded-full py-3 text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg,#059669,#22c55e)' }}
                  >
                    開始{liveFlow.direction === 'asc' ? '警右' : '警左'}發言錄音 →
                  </button>
                </section>
              )}

              {liveFlow.stage === 'dayVote' && (
                <section className="rounded-2xl p-4 sm:p-5" style={{ ...cardStyle, border: '1px solid rgba(239,68,68,0.25)' }}>
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-red-300">第一天白天</p>
                      <h2 className="mt-1 text-lg font-semibold text-white">登記放逐票型</h2>
                      <p className="mt-1 text-xs text-slate-500">逐一登記存活玩家投給誰；警長票會自動按 1.5 票計算。</p>
                    </div>
                    <span className="shrink-0 rounded-full px-2.5 py-1 text-xs text-slate-400" style={inputStyle}>
                      已記 {Object.keys(liveFlow.dayVotes).length}/{board.seats.filter((s) => !s.out).length}
                    </span>
                  </div>

                  <div className="space-y-2">
                    {board.seats.filter((s) => !s.out).map((voter) => (
                      <div key={voter.id} className="flex items-center gap-2">
                        <span className={`w-16 shrink-0 text-sm font-medium ${voter.id === liveFlow.sheriffWinner ? 'text-amber-300' : 'text-white'}`}>
                          {voter.id}{voter.id === liveFlow.sheriffWinner ? ' ♛' : ''}
                        </span>
                        <div className="flex flex-1 gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
                          {[...board.seats.filter((s) => !s.out).map((s) => s.id), '棄票'].map((target) => (
                            <button
                              key={target}
                              type="button"
                              onClick={() => setDayVote(voter.id, target)}
                              className="shrink-0 rounded-lg px-3 py-2 text-xs font-medium"
                              style={liveFlow.dayVotes[voter.id] === target
                                ? target === '棄票'
                                  ? { background: 'rgba(100,116,139,.35)', color: '#fff', border: '1px solid rgba(148,163,184,.4)' }
                                  : { background: 'linear-gradient(135deg,#dc2626,#f97316)', color: '#fff' }
                                : { ...inputStyle, color: '#94a3b8' }}
                            >
                              {target === '棄票' ? target : `投 ${target}`}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={finishDayVote}
                    disabled={Object.keys(liveFlow.dayVotes).length === 0}
                    className="mt-5 w-full rounded-full py-3 text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg,#dc2626,#f97316)' }}
                  >
                    完成第一天投票・開始 AI 判狼
                  </button>
                </section>
              )}

              {liveFlow.ready && (liveFlow.stage === 'speech' || liveFlow.stage === 'runoffSpeech' || liveFlow.stage === 'daySpeech') && (
                <>
              {/* 錄音控制（只在發言階段顯示） */}
              <section className="rounded-2xl p-3" style={cardStyle}>
                <div className="flex flex-wrap gap-2 items-center">
                  <div className="flex rounded-full overflow-hidden text-xs" style={inputStyle}>
                    {(['mic', 'tab'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setRecMode(m)}
                        disabled={recording}
                        className="px-3 py-1.5"
                        style={recMode === m ? { background: gradient, color: '#fff' } : { color: '#94a3b8' }}
                      >
                        {m === 'mic' ? '🎤' : '💻'}
                      </button>
                    ))}
                  </div>
                  {!recording ? (
                    <button
                      onClick={startRecording}
                      className="px-4 py-1.5 rounded-full text-white text-sm font-medium"
                      style={{ background: gradient }}
                    >
                      開始錄音
                    </button>
                  ) : (
                    <button
                      onClick={stopRecording}
                      className="px-4 py-1.5 rounded-full text-white text-sm font-medium"
                      style={{ background: 'linear-gradient(135deg,#ef4444,#f97316)' }}
                    >
                      ■ 停止
                    </button>
                  )}
                  <label className="px-3 py-1.5 rounded-full text-slate-300 text-xs cursor-pointer" style={inputStyle}>
                    上傳音檔
                    <input type="file" accept="audio/*" onChange={onUploadAudio} className="hidden" />
                  </label>
                  <button
                    onClick={() => {
                      const next = !toneMode
                      setToneMode(next)
                      toneModeRef.current = next
                    }}
                    className="px-3 py-1.5 rounded-full text-xs"
                    style={
                      toneMode
                        ? { background: 'rgba(139,92,246,0.15)', color: '#c4b5fd', border: '1px solid rgba(139,92,246,0.35)' }
                        : { ...inputStyle, color: '#64748b' }
                    }
                    title="開啟時音檔交給 Gemini 聽，逐字稿會自動標語氣（停頓/遲疑/笑…）；關閉時走 whisper 純文字"
                  >
                    {toneMode ? '🎭 語氣' : '語氣關'}
                  </button>
                  <span className="ml-auto text-xs text-slate-500">存活 {aliveCount}/{board.players}</span>
                  {recording && <span className="text-xs text-red-400 animate-pulse">● 錄音中</span>}
                  {transcribing && <span className="text-xs text-violet-300">轉錄中…</span>}
                </div>
              </section>

              {/* 座位模式切換 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">點座位：</span>
                <div className="flex rounded-full overflow-hidden text-xs" style={inputStyle}>
                  <button
                    onClick={() => setSeatMode('speak')}
                    className="px-3 py-1.5"
                    style={seatMode === 'speak' ? { background: gradient, color: '#fff' } : { color: '#94a3b8' }}
                  >
                    🎙 切換發言者
                  </button>
                  <button
                    onClick={() => setSeatMode('out')}
                    className="px-3 py-1.5"
                    style={seatMode === 'out' ? { background: 'linear-gradient(135deg,#ef4444,#f97316)', color: '#fff' } : { color: '#94a3b8' }}
                  >
                    💀 標記出局
                  </button>
                </div>
                {speaker && seatMode === 'speak' && <span className="text-xs text-violet-300">現在發言：{speaker}</span>}
              </div>

              {/* 遊戲桌面：左右座位＋中間資訊流（照網易狼人殺實戰畫面排版） */}
              <section className="rounded-2xl p-2 sm:p-3" style={cardStyle}>
                <div className="grid grid-cols-[minmax(72px,1fr)_minmax(148px,2.4fr)_minmax(72px,1fr)] gap-1.5 sm:gap-3">
                  {/* 左：1-6 號 */}
                  <div className="flex flex-col gap-1.5">
                    {board.seats.slice(0, 6).map((s, idx) => (
                      <SeatButton
                        key={s.id}
                        seat={s}
                        isMe={board.mySeat === s.id}
                        active={seatMode === 'speak' && speaker === s.id}
                        onClick={() => (seatMode === 'speak' ? switchSpeaker(s.id) : setSeat(idx, { out: !s.out }))}
                        gradient={gradient}
                        inputStyle={inputStyle}
                      />
                    ))}
                  </div>

                  {/* 中：資訊流 */}
                  <div className="rounded-xl flex flex-col h-[25rem] sm:h-[30rem] min-w-0 overflow-hidden" style={{ background: 'rgba(0,0,0,0.2)' }}>
                    <div className="flex text-xs shrink-0">
                      {(
                        [
                          ['notes', `🗒 筆記 ${notes.length}`],
                          ['transcript', '逐字稿'],
                          ['events', `戰況 ${events.length}`],
                        ] as const
                      ).map(([k, label]) => (
                        <button
                          key={k}
                          onClick={() => setFeedTab(k)}
                            className="flex-1 min-w-0 py-2 px-1 font-medium truncate"
                          style={
                            feedTab === k
                              ? { background: 'rgba(139,92,246,0.15)', color: '#c4b5fd', borderBottom: '2px solid #8b5cf6' }
                              : { color: '#64748b' }
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    <div ref={feedRef} className="flex-1 overflow-y-auto p-2 space-y-1.5">
                      {feedTab === 'notes' && (
                        notes.length === 0 ? (
                          <p className="text-xs text-slate-600 text-center mt-6">開始錄音後 AI 筆記會自動長出來</p>
                        ) : (
                          notes.map((n, i) => (
                            <div key={i} className="flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-xs" style={inputStyle}>
                              <span className="flex-1 text-slate-300 leading-relaxed">{n}</span>
                              <button
                                onClick={() => {
                                  notesRef.current = notesRef.current.filter((_, idx) => idx !== i)
                                  setNotes(notesRef.current)
                                }}
                                className="text-slate-600 hover:text-red-400 shrink-0"
                              >
                                ✕
                              </button>
                            </div>
                          ))
                        )
                      )}

                      {feedTab === 'transcript' && (
                        speaker ? (
                          <div className="flex h-full min-h-[18rem] flex-col gap-2">
                            <div className="flex items-center justify-between px-1">
                              <p className="text-xs font-semibold text-violet-300">{speaker}・{speechPhaseLabel(liveFlow.stage)}</p>
                              <span className="text-[10px] text-slate-600">切換下一位時自動存入</span>
                            </div>

                            {speechesForSeat(transcript, speaker).length > 0 && (
                              <div className="max-h-36 space-y-1.5 overflow-y-auto rounded-lg p-2" style={inputStyle}>
                                {speechesForSeat(transcript, speaker).map((speech, index) => (
                                  <div key={index} className="text-xs leading-relaxed text-slate-400">
                                    <span className="mr-1 rounded bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-300">{speech.phase}</span>
                                    {speech.text}
                                  </div>
                                ))}
                              </div>
                            )}

                            <textarea
                              value={transcriptDraft}
                              onChange={(e) => {
                                transcriptDraftRef.current = e.target.value
                                setTranscriptDraft(e.target.value)
                              }}
                              placeholder={`只貼${speaker}的「${speechPhaseLabel(liveFlow.stage)}」發言；按「下一位」會自動存檔。`}
                              className="min-h-32 flex-1 resize-none rounded-lg px-2.5 py-2 text-xs leading-relaxed text-white placeholder-slate-600 focus:outline-none font-mono"
                              style={{ background: 'rgba(255,255,255,.025)', border: '1px solid rgba(255,255,255,.06)' }}
                            />
                            <button
                              type="button"
                              onClick={() => commitTranscriptDraft(speaker)}
                              disabled={!transcriptDraft.trim()}
                              className="rounded-lg py-2 text-xs font-medium text-white disabled:opacity-30"
                              style={{ background: gradient }}
                            >
                              存入 {speaker}・{speechPhaseLabel(liveFlow.stage)}
                            </button>
                          </div>
                        ) : (
                          <p className="mt-8 text-center text-xs text-slate-600">先點一個座位，再貼該玩家的獨立發言稿</p>
                        )
                      )}

                      {feedTab === 'events' && (
                        <>
                          <form
                            onSubmit={(e) => {
                              e.preventDefault()
                              const t = eventInput.trim()
                              if (!t) return
                              addEvent(t)
                            }}
                            className="flex gap-1 mb-1.5"
                          >
                            <input
                              value={eventInput}
                              onChange={(e) => setEventInput(e.target.value)}
                              placeholder="死訊／票型／警長…"
                              className="flex-1 min-w-0 rounded-lg px-2 py-1.5 text-white text-xs placeholder-slate-600 focus:outline-none"
                              style={inputStyle}
                            />
                            <button type="submit" className="px-2.5 rounded-lg text-white text-xs font-medium shrink-0" style={{ background: gradient }}>
                              記
                            </button>
                          </form>
                          {eventInput && (
                            <p className="mb-1.5 text-[10px] text-slate-600">補完內容後按「記」，會連同類型一起存入。</p>
                          )}
                          {events.length === 0 ? (
                            <p className="text-xs text-slate-600 text-center mt-6">回報死訊/票型/警長歸屬…判狼時優先度比發言高</p>
                          ) : (
                            events.map((ev, i) => (
                              <div key={i} className="flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-xs" style={inputStyle}>
                                <span className="text-slate-500 shrink-0">{i + 1}.</span>
                                <span className="flex-1 text-slate-300">{ev}</span>
                                <button
                                  onClick={() => setEvents((prev) => prev.filter((_, idx) => idx !== i))}
                                  className="text-slate-600 hover:text-red-400 shrink-0"
                                >
                                  ✕
                                </button>
                              </div>
                            ))
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* 右：7-12 號 */}
                  <div className="flex flex-col gap-1.5">
                    {board.seats.slice(6, 12).map((s, idx) => (
                      <SeatButton
                        key={s.id}
                        seat={s}
                        isMe={board.mySeat === s.id}
                        active={seatMode === 'speak' && speaker === s.id}
                        onClick={() => (seatMode === 'speak' ? switchSpeaker(s.id) : setSeat(idx + 6, { out: !s.out }))}
                        gradient={gradient}
                        inputStyle={inputStyle}
                      />
                    ))}
                    {/* 13 人以上的座位（少見）放右欄下方 */}
                    {board.seats.slice(12).map((s, idx) => (
                      <SeatButton
                        key={s.id}
                        seat={s}
                        isMe={board.mySeat === s.id}
                        active={seatMode === 'speak' && speaker === s.id}
                        onClick={() => (seatMode === 'speak' ? switchSpeaker(s.id) : setSeat(idx + 12, { out: !s.out }))}
                        gradient={gradient}
                        inputStyle={inputStyle}
                      />
                    ))}
                  </div>
                </div>
              </section>
                </>
              )}

              {liveFlow.stage === 'done' && <>
              {/* 第一天白天投票完成後才開放判狼 */}
              <section className="rounded-2xl p-4" style={cardStyle}>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-white font-medium">AI 判狼</h2>
                  <button
                    onClick={runJudge}
                    disabled={judging}
                    className="px-5 py-2 rounded-full text-white text-sm font-medium disabled:opacity-40"
                    style={{ background: gradient }}
                  >
                    {judging ? '分析中…' : '判狼'}
                  </button>
                </div>
                {judgement && (
                  <div className="space-y-3">
                    {judgement.speechAudits && judgement.speechAudits.some((audit) => audit.evidence.length > 0) && (
                      <details className="rounded-xl p-3" style={inputStyle}>
                        <summary className="cursor-pointer text-sm font-semibold text-white">
                          逐人逐句審查（判狼證據來源）
                        </summary>
                        <div className="mt-3 space-y-3">
                          {judgement.speechAudits.map((audit) => (
                            <div key={audit.seat} className="border-t border-white/5 pt-2 first:border-0 first:pt-0">
                              <p className="text-sm font-medium text-violet-300">{audit.seat}</p>
                              <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                                時間軸：{audit.timelineVerdict}｜一致性：{audit.consistencyVerdict}
                              </p>
                              {audit.evidence.map((entry) => (
                                <div key={entry.id} className="mt-2 rounded-lg bg-black/20 p-2">
                                  <div className="flex items-center gap-2 text-[10px]">
                                    <span className={entry.severity === 'hard' ? 'text-red-300' : entry.severity === 'medium' ? 'text-amber-300' : 'text-slate-500'}>
                                      {entry.id}・{entry.severity}
                                    </span>
                                    <span className="text-slate-600">{entry.phase}</span>
                                  </div>
                                  <p className="mt-1 text-xs text-slate-300">「{entry.quote}」</p>
                                  <p className="mt-1 text-xs leading-relaxed text-slate-400">{entry.finding}</p>
                                  <p className="mt-1 text-[11px] leading-relaxed text-red-300/70">狼面：{entry.wolfInterpretation}</p>
                                  <p className="text-[11px] leading-relaxed text-emerald-300/70">好人面：{entry.goodInterpretation}</p>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                    {judgement.worlds && judgement.worlds.length === 2 && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {judgement.worlds.map((world) => {
                          const selected = judgement.selectedWorld === world.assumedSeer
                          return (
                            <div
                              key={world.assumedSeer}
                              className="rounded-xl p-3"
                              style={selected
                                ? { background: 'rgba(139,92,246,.12)', border: '1px solid rgba(139,92,246,.4)' }
                                : { ...inputStyle, opacity: .82 }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-white">假設 {world.assumedSeer} 真預言家</p>
                                <span className={`text-xs ${selected ? 'text-violet-300' : 'text-slate-500'}`}>
                                  自洽 {world.consistency}{selected ? '・採用' : ''}
                                </span>
                              </div>
                              <p className="mt-2 text-xs text-red-300">🐺 {world.wolfPit.join('、') || '未形成狼坑'}</p>
                              <p className="mt-2 text-xs leading-relaxed text-slate-400">{world.summary}</p>
                              {world.hardContradictions.length > 0 && (
                                <div className="mt-2 border-t border-white/5 pt-2">
                                  <p className="mb-1 text-[10px] text-amber-300">此世界硬矛盾</p>
                                  {world.hardContradictions.slice(0, 3).map((item, index) => (
                                    <p key={index} className="text-[11px] leading-relaxed text-slate-500">• {item}</p>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                    <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.08)' }}>
                      <p className="text-xs text-violet-300 mb-1">有足夠證據的疑狼名單（把握 {judgement.confidence}%）</p>
                      <p className="text-white font-medium">🐺 {judgement.topWolves.join('、') || '目前證據不足，不硬點狼'}</p>
                      <p className="text-sm text-slate-300 mt-2">{judgement.overall}</p>
                    </div>
                    <div className="space-y-1.5">
                      {[...judgement.seats].sort((a, b) => b.suspicion - a.suspicion).map((s) => (
                        <div key={s.seat} className="flex items-start gap-3 rounded-lg px-3 py-2" style={inputStyle}>
                          <div className="w-14 shrink-0">
                            <span className="text-white text-sm">{s.seat}</span>
                          </div>
                          <div className="w-10 shrink-0 text-right">
                            <span
                              className="text-sm font-semibold"
                              style={{ color: s.suspicion >= 60 ? '#f87171' : s.suspicion >= 35 ? '#fbbf24' : '#4ade80' }}
                            >
                              {s.suspicion}
                            </span>
                          </div>
                          <div className="flex-1">
                            <p className="text-xs text-slate-400">猜 {s.roleGuess}</p>
                            <p className="text-sm text-slate-300">{s.reason}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <button
                onClick={() => setPhase('review')}
                className="w-full py-3 rounded-full text-white font-medium"
                style={{ background: 'linear-gradient(135deg,#0ea5e9,#6366f1)' }}
              >
                對局結束，進入復盤 →
              </button>
              </>}
            </>
          )}

          {/* ======== 階段三：復盤 ======== */}
          {phase === 'review' && (
            <>
              <section className="rounded-2xl p-4" style={cardStyle}>
                <h2 className="text-white font-medium mb-1">賽後復盤</h2>
                <p className="text-xs text-slate-500 mb-3">
                  標出真正的身分、勾出狼。存檔後 AI 比對預測生成教訓，之後判狼更準。
                </p>
                <div className="space-y-2 mb-3">
                  {board.seats.map((s) => {
                    const t = truthFor(s.id)
                    return (
                      <div key={s.id} className="flex gap-2 items-center">
                        <span className="w-20 text-sm text-white shrink-0">
                          {s.id}{s.player ? `·${s.player}` : ''}{board.mySeat === s.id ? '★' : ''}
                        </span>
                        <input
                          value={t.role}
                          onChange={(e) => setTruthRole(s.id, e.target.value)}
                          placeholder={s.id === board.mySeat && board.myRole ? `${board.myRole}（自動帶入）` : '真實身分'}
                          className="flex-1 rounded-lg px-3 py-1.5 text-white text-sm placeholder-slate-600 focus:outline-none"
                          style={inputStyle}
                        />
                        <button
                          onClick={() => toggleTruthWolf(s.id)}
                          className="px-3 py-1.5 rounded-lg text-sm font-medium shrink-0"
                          style={
                            t.isWolf
                              ? { background: 'rgba(239,68,68,0.15)', color: '#f87171', border: '1px solid rgba(239,68,68,0.3)' }
                              : { ...inputStyle, color: '#64748b' }
                          }
                        >
                          {t.isWolf ? '🐺 狼' : '好人'}
                        </button>
                      </div>
                    )
                  })}
                </div>
                <input
                  value={resultText}
                  onChange={(e) => setResultText(e.target.value)}
                  placeholder="賽果（例：好人陣營勝／狼屠邊）"
                  className="w-full rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none mb-3"
                  style={inputStyle}
                />
                <button
                  onClick={runReflect}
                  disabled={reflecting}
                  className="w-full py-2.5 rounded-full text-white text-sm font-medium disabled:opacity-40"
                  style={{ background: gradient }}
                >
                  {reflecting ? '復盤中…' : '存檔並生成教訓'}
                </button>
                {accuracyNote && (
                  <div className="mt-3 rounded-lg p-3 text-sm text-slate-300" style={{ background: 'rgba(139,92,246,0.08)' }}>
                    {computeAccuracy() != null && (
                      <p className="text-white font-medium mb-1">本局命中率：{computeAccuracy()}%</p>
                    )}
                    {accuracyNote}
                    <p className="text-xs text-slate-500 mt-2">教訓已存入教訓庫；按上方「開新一局」開始下一場。</p>
                  </div>
                )}
              </section>
              <button onClick={() => setPhase('live')} className="text-sm text-slate-400 hover:text-slate-200 underline decoration-dotted">
                ← 回實戰（補逐字稿/戰況）
              </button>
            </>
          )}
        </div>
      )}

      {/* ============ 玩家名冊 ============ */}
      {tab === 'roster' && (
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            登記固定牌友。開局時把人指派到座位，復盤的教訓會寫「這個人」的行為規律（不是座位號），跨局累積成行為檔案。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const name = rosterInput.trim()
              if (!name || roster.some((p) => p.name === name)) return
              const next = [...roster, { id: uid(), name }]
              setRoster(next)
              save(LS.roster, next)
              setRosterInput('')
            }}
            className="flex gap-2"
          >
            <input
              value={rosterInput}
              onChange={(e) => setRosterInput(e.target.value)}
              placeholder="玩家名／綽號（例：阿明）"
              className="flex-1 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none"
              style={inputStyle}
            />
            <button type="submit" className="px-5 rounded-lg text-white text-sm font-medium" style={{ background: gradient }}>
              登記
            </button>
          </form>
          {roster.map((p) => {
            // 跨局統計：出場數、當狼數、被 AI 抓中數
            const played = games.filter((g) => g.board.seats.some((s) => s.player === p.name))
            const wolfGames = played.filter((g) =>
              g.truth?.some((t) => t.isWolf && g.board.seats.find((s) => s.id === t.seat)?.player === p.name),
            )
            const caught = wolfGames.filter((g) => {
              const seat = g.board.seats.find((s) => s.player === p.name)
              return seat && g.judgement?.topWolves.includes(seat.id)
            })
            const playerLessons = lessons.filter((l) => l.insight.includes(p.name) || l.title.includes(p.name))
            return (
              <div key={p.id} className="rounded-xl px-4 py-3" style={cardStyle}>
                <div className="flex items-center justify-between">
                  <span className="text-white font-medium">
                    {p.name}
                    {p.isMe && <span className="ml-2 text-xs text-violet-300">★ 我本人</span>}
                  </span>
                  {!p.isMe && (
                    <button
                      onClick={() => {
                        const next = roster.filter((r) => r.id !== p.id)
                        setRoster(next)
                        save(LS.roster, next)
                      }}
                      className="text-xs text-slate-600 hover:text-red-400"
                    >
                      刪除
                    </button>
                  )}
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  出場 {played.length} 局 ・ 當狼 {wolfGames.length} 次
                  {wolfGames.length > 0 && ` ・ AI 抓中 ${caught.length}/${wolfGames.length}`}
                  {playerLessons.length > 0 && ` ・ 相關教訓 ${playerLessons.length} 條`}
                </p>
                {playerLessons.slice(-2).map((l) => (
                  <p key={l.id} className="text-xs text-violet-300/80 mt-1.5">📌 {l.insight}</p>
                ))}
              </div>
            )
          })}
          {roster.length === 0 && <p className="text-center text-sm text-slate-600 mt-6">還沒登記任何牌友。</p>}
        </div>
      )}

      {/* ============ 教訓庫 ============ */}
      {tab === 'lessons' && (
        <div className="space-y-3">
          {lessons.length === 0 && <p className="text-center text-sm text-slate-600 mt-10">還沒有教訓，玩幾局復盤後就會累積。</p>}
          {[...lessons].reverse().map((l) => (
            <div key={l.id} className="rounded-xl px-4 py-3" style={cardStyle}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-white font-medium text-sm">{l.title}</p>
                  <p className="text-sm text-slate-400 mt-1">{l.insight}</p>
                </div>
                <button onClick={() => deleteLesson(l.id)} className="text-xs text-slate-600 hover:text-red-400 shrink-0">
                  刪除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ============ 歷史 ============ */}
      {tab === 'history' && (
        <div className="space-y-3">
          {avgAccuracy != null && (
            <div className="rounded-xl px-4 py-3 mb-2" style={{ background: 'rgba(139,92,246,0.08)' }}>
              <p className="text-sm text-slate-300">
                平均命中率 <span className="text-white font-semibold text-lg">{avgAccuracy}%</span>（{games.filter((g) => g.accuracy != null).length} 局）
              </p>
            </div>
          )}
          {games.length === 0 && <p className="text-center text-sm text-slate-600 mt-10">還沒有存檔的對局。</p>}
          {games.map((g) => (
            <div key={g.id} className="rounded-xl px-4 py-3" style={cardStyle}>
              <div className="flex items-center justify-between">
                <span className="text-sm text-white">
                  {new Date(g.createdAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
                {g.accuracy != null && (
                  <span
                    className="text-sm font-semibold"
                    style={{ color: g.accuracy >= 67 ? '#4ade80' : g.accuracy >= 34 ? '#fbbf24' : '#f87171' }}
                  >
                    命中 {g.accuracy}%
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                {g.board.players}人 {g.board.roles}
                {g.result ? ` ・ ${g.result}` : ''}
              </p>
              {g.truth && (
                <p className="text-xs text-slate-400 mt-1">
                  真狼：{g.truth.filter((t) => t.isWolf).map((t) => t.seat).join('、')}
                  {g.judgement && ` ／ AI 指認：${g.judgement.topWolves.join('、')}`}
                </p>
              )}
            </div>
          ))}

          <div className="flex gap-2 pt-4 border-t border-white/5">
            <button onClick={exportBackup} className="flex-1 py-2 rounded-full text-slate-300 text-sm" style={inputStyle}>
              匯出備份
            </button>
            <label className="flex-1 py-2 rounded-full text-slate-300 text-sm text-center cursor-pointer" style={inputStyle}>
              匯入備份
              <input type="file" accept="application/json" onChange={importBackup} className="hidden" />
            </label>
          </div>
        </div>
      )}
    </main>
  )
}
