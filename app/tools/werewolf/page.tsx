'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

// ---- 型別（跟 lib/werewolf.ts 對齊）----
type Seat = { id: string; player?: string; claim?: string }
type Board = {
  players: number
  wolves: number
  roles: string
  seats: Seat[]
  note?: string
  mySeat?: string // 我本人的座位（明身份）
  myRole?: string
}
type RosterPlayer = { id: string; name: string; note?: string }
type SeatVerdict = { seat: string; roleGuess: string; suspicion: number; reason: string }
type Judgement = { seats: SeatVerdict[]; topWolves: string[]; overall: string; confidence: number }
type Lesson = { id: string; ts: number; gameId?: string; title: string; insight: string }
type Truth = { seat: string; role: string; isWolf: boolean }
type Game = {
  id: string
  createdAt: number
  board: Board
  transcript: string
  events?: string[]
  judgement: Judgement | null
  truth: Truth[] | null
  result?: string
  accuracy: number | null
}

const LS = { lessons: 'wn_lessons', games: 'wn_games', current: 'wn_current', roster: 'wn_roster' }
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
  return Array.from({ length: n }, (_, i) => prev[i] ?? { id: `${i + 1}號`, claim: '' })
}
function emptyBoard(): Board {
  return { players: 9, wolves: 3, roles: '狼人x3、預言家、女巫、獵人、平民x3', seats: makeSeats(9, []), note: '' }
}

// 常見 12 人板子預設。點了會覆蓋板子設定（座位自報保留可再編輯）。
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

export default function WerewolfPage() {
  const [tab, setTab] = useState<'game' | 'roster' | 'lessons' | 'history'>('game')

  // 本局狀態
  const [board, setBoard] = useState<Board>(emptyBoard)
  const [transcript, setTranscript] = useState('')
  const [events, setEvents] = useState<string[]>([]) // 戰況記錄：出局/票型/警長…
  const [eventInput, setEventInput] = useState('')
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
    setRoster(load<RosterPlayer[]>(LS.roster, []))
    const cur = load<Partial<Game> | null>(LS.current, null)
    if (cur && cur.board) {
      setBoard(cur.board)
      setTranscript(cur.transcript ?? '')
      setEvents(cur.events ?? [])
      setJudgement(cur.judgement ?? null)
      setGameId(cur.id ?? uid())
    }
  }, [])

  // ---- 自動存本局進度 ----
  useEffect(() => {
    save(LS.current, { id: gameId, board, transcript, events, judgement })
  }, [gameId, board, transcript, events, judgement])

  // ---- 板子調整 ----
  function setPlayers(n: number) {
    const players = Math.max(2, Math.min(20, n || 0))
    setBoard((b) => ({ ...b, players, seats: makeSeats(players, b.seats) }))
  }
  function setSeat(i: number, patch: Partial<Seat>) {
    setBoard((b) => ({ ...b, seats: b.seats.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) }))
  }
  function applyPreset(p: (typeof PRESETS)[number]) {
    setBoard((b) => ({
      players: p.players,
      wolves: p.wolves,
      roles: p.roles,
      note: p.note,
      seats: makeSeats(p.players, b.seats),
    }))
  }

  // ---- 錄音：自動分段轉錄 ----
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
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: mime || 'audio/webm' })
      if (recordingRef.current) recordSegment() // 先無縫接下一段，轉錄慢慢跑
      if (blob.size > 1000) await sendForTranscription(blob, segSpeaker)
    }
    rec.start()
    // 保險上限：單段太長就自動切（發言者不變）
    setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop()
    }, MAX_SEGMENT_MS)
  }

  // 換人發言：點座位 → 切掉當前段（掛上一位的名字）、開新段（掛新發言者）
  function switchSpeaker(next: string) {
    const same = speakerRef.current === next
    speakerRef.current = same ? '' : next // 再點一次同座位 = 取消掛名
    setSpeaker(speakerRef.current)
    if (recording && recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop() // onstop 會自動開新段（用新的 speakerRef）
    }
  }

  function stopRecording() {
    recordingRef.current = false
    setRecording(false)
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  async function sendForTranscription(blob: Blob, segSpeaker?: string) {
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
        const entry = segSpeaker ? `${segSpeaker}：${text}` : text
        setTranscript((t) => (t ? t + '\n' + entry : entry))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '轉錄失敗')
    } finally {
      setTranscribing(false)
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
    setBoard(emptyBoard())
    setTranscript('')
    setEvents([])
    setEventInput('')
    setJudgement(null)
    setTruth([])
    setResultText('')
    setAccuracyNote('')
    setGameId(uid())
    setSpeaker('')
    speakerRef.current = ''
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

  // ---- 樣式 helper ----
  const cardStyle = { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }
  const inputStyle = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }
  const gradient = 'linear-gradient(135deg, #6366f1, #8b5cf6)'

  return (
    <main className="relative max-w-2xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl sm:text-3xl font-semibold text-white tracking-[-0.02em]">狼人殺筆記</h1>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">← 回工具箱</Link>
      </div>
      <p className="text-slate-400 mb-6 text-sm">
        錄音自動轉逐字稿 → 標發言者 → AI 判狼 → 賽後復盤比對，教訓越存越多，判得越準。
      </p>

      {/* 分頁 */}
      <div className="flex gap-2 mb-6">
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
          {/* 板子設定 */}
          <section className="rounded-2xl p-4" style={cardStyle}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white font-medium">① 板子設定</h2>
              <button onClick={newGame} className="text-xs text-slate-400 hover:text-slate-200 underline decoration-dotted">
                開新一局
              </button>
            </div>
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
            <div className="grid grid-cols-2 gap-3 mb-3 rounded-xl p-3" style={{ background: 'rgba(139,92,246,0.06)' }}>
              <label className="text-sm text-slate-400">
                ★ 我的座位
                <select
                  value={board.mySeat ?? ''}
                  onChange={(e) => setBoard((b) => ({ ...b, mySeat: e.target.value || undefined }))}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-white text-sm focus:outline-none"
                  style={inputStyle}
                >
                  <option value="">（未設定）</option>
                  {board.seats.map((s) => (
                    <option key={s.id} value={s.id}>{s.id}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm text-slate-400">
                我的真實身份（明牌給 AI 當推理起點）
                <input
                  value={board.myRole ?? ''}
                  onChange={(e) => setBoard((b) => ({ ...b, myRole: e.target.value || undefined }))}
                  placeholder="例：女巫"
                  className="mt-1 w-full rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none"
                  style={inputStyle}
                />
              </label>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-slate-500">
                座位／指派名冊玩家（教訓會綁定玩家跨局累積）／自報身分
                {roster.length === 0 && (
                  <button onClick={() => setTab('roster')} className="ml-2 text-violet-400 underline decoration-dotted">
                    先去登記牌友 →
                  </button>
                )}
              </p>
              {board.seats.map((s, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={s.id}
                    onChange={(e) => setSeat(i, { id: e.target.value })}
                    className={`w-16 rounded-lg px-2 py-2 text-sm focus:outline-none ${board.mySeat === s.id ? 'text-violet-300' : 'text-white'}`}
                    style={inputStyle}
                  />
                  <select
                    value={s.player ?? ''}
                    onChange={(e) => setSeat(i, { player: e.target.value || undefined })}
                    className="w-28 rounded-lg px-2 py-2 text-sm focus:outline-none"
                    style={{ ...inputStyle, color: s.player ? '#c4b5fd' : '#64748b' }}
                  >
                    <option value="">（路人）</option>
                    {roster.map((p) => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  <input
                    value={s.claim ?? ''}
                    onChange={(e) => setSeat(i, { claim: e.target.value })}
                    placeholder="自報身分"
                    className="flex-1 min-w-0 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none"
                    style={inputStyle}
                  />
                </div>
              ))}
            </div>
            <input
              value={board.note ?? ''}
              onChange={(e) => setBoard((b) => ({ ...b, note: e.target.value }))}
              placeholder="情境備註（第幾晚、出過刀沒、特殊規則…）"
              className="mt-3 w-full rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none"
              style={inputStyle}
            />
          </section>

          {/* 逐字稿 / 錄音 */}
          <section className="rounded-2xl p-4" style={cardStyle}>
            <h2 className="text-white font-medium mb-3">② 逐字稿</h2>
            <div className="flex flex-wrap gap-2 mb-3 items-center">
              <div className="flex rounded-full overflow-hidden text-xs" style={inputStyle}>
                {(['mic', 'tab'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setRecMode(m)}
                    disabled={recording}
                    className="px-3 py-1.5"
                    style={recMode === m ? { background: gradient, color: '#fff' } : { color: '#94a3b8' }}
                  >
                    {m === 'mic' ? '🎤 麥克風' : '💻 分頁內錄'}
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
                  ■ 停止錄音
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
                {toneMode ? '🎭 語氣標註 開' : '語氣標註 關'}
              </button>
              {recording && <span className="text-xs text-red-400 animate-pulse">● 錄音中</span>}
              {transcribing && <span className="text-xs text-violet-300">轉錄中…</span>}
            </div>
            {recording && (
              <div className="mb-3 rounded-xl p-3" style={{ background: 'rgba(139,92,246,0.06)' }}>
                <p className="text-xs text-slate-400 mb-2">
                  誰在發言？換人時點一下座位 → 上一段自動送轉錄並掛名（再點同座位＝取消掛名）
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {board.seats.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => switchSpeaker(s.id)}
                      className="px-3 py-1.5 rounded-full text-xs font-medium"
                      style={
                        speaker === s.id
                          ? { background: gradient, color: '#fff' }
                          : { ...inputStyle, color: '#94a3b8' }
                      }
                    >
                      {s.id}{s.player ? `·${s.player}` : ''}{board.mySeat === s.id ? '★' : ''}
                    </button>
                  ))}
                </div>
                {speaker && <p className="text-xs text-violet-300 mt-2">🎙 現在發言：{speaker}</p>}
              </div>
            )}
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              placeholder={'逐字稿會自動長在這裡。\n建議手動標上發言者，例如：\n1號：我是預言家，昨晚驗2號金水…\n3號：我覺得1號跳得太急'}
              rows={10}
              className="w-full rounded-lg px-3 py-3 text-white text-sm placeholder-slate-600 focus:outline-none font-mono leading-relaxed"
              style={inputStyle}
            />
          </section>

          {/* 戰況記錄 */}
          <section className="rounded-2xl p-4" style={cardStyle}>
            <h2 className="text-white font-medium mb-1">③ 戰況記錄</h2>
            <p className="text-xs text-slate-500 mb-3">
              實時回報硬資訊：昨晚誰出局、票型、警上陣容、警長歸屬、退水…判狼時這些優先度比發言高。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const t = eventInput.trim()
                if (!t) return
                setEvents((prev) => [...prev, t])
                setEventInput('')
              }}
              className="flex gap-2 mb-3"
            >
              <input
                value={eventInput}
                onChange={(e) => setEventInput(e.target.value)}
                placeholder="例：第一晚 5號出局／首日票型 1,3,7投5；5被放逐／警長給4號"
                className="flex-1 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none"
                style={inputStyle}
              />
              <button
                type="submit"
                className="px-4 rounded-lg text-white text-sm font-medium"
                style={{ background: gradient }}
              >
                記錄
              </button>
            </form>
            {events.length > 0 && (
              <div className="space-y-1.5">
                {events.map((ev, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-lg px-3 py-2 text-sm" style={inputStyle}>
                    <span className="text-slate-500 text-xs shrink-0 mt-0.5">{i + 1}.</span>
                    <span className="flex-1 text-slate-300">{ev}</span>
                    <button
                      onClick={() => setEvents((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-xs text-slate-600 hover:text-red-400 shrink-0"
                    >
                      刪
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 判狼 */}
          <section className="rounded-2xl p-4" style={cardStyle}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-white font-medium">④ AI 判狼</h2>
              <button
                onClick={runJudge}
                disabled={judging}
                className="px-5 py-2 rounded-full text-white text-sm font-medium disabled:opacity-40"
                style={{ background: gradient }}
              >
                {judging ? '分析中…' : '開始判狼'}
              </button>
            </div>
            {judgement && (
              <div className="space-y-3">
                <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.08)' }}>
                  <p className="text-xs text-violet-300 mb-1">最可疑的狼（把握 {judgement.confidence}%）</p>
                  <p className="text-white font-medium">🐺 {judgement.topWolves.join('、') || '—'}</p>
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
                        <p className="text-xs text-slate-400">
                          猜 {s.roleGuess}
                        </p>
                        <p className="text-sm text-slate-300">{s.reason}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* 復盤 */}
          <section className="rounded-2xl p-4" style={cardStyle}>
            <h2 className="text-white font-medium mb-1">⑤ 賽後復盤</h2>
            <p className="text-xs text-slate-500 mb-3">標出真正的身分，勾掉是狼的座位。存檔後 AI 會比對並生成教訓，之後判狼會更準。</p>
            <div className="space-y-2 mb-3">
              {board.seats.map((s) => {
                const t = truthFor(s.id)
                return (
                  <div key={s.id} className="flex gap-2 items-center">
                    <span className="w-14 text-sm text-white shrink-0">{s.id}</span>
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
              </div>
            )}
          </section>
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
                  <span className="text-white font-medium">{p.name}</span>
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
