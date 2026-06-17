// 直接從前端工具站把貼文發到 Threads（@q_kangber，取代 n8n 工作流 B）
// token：以 .env.local 的 THREADS_ACCESS_TOKEN 為種子，之後存進 .threads-token.json，
// 每隔幾天用 refresh_access_token 自動續期（每次 +60 天），不碰公司 stacktools。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

type ThreadsCreds = { token: string; userId: string }

const TOKEN_FILE = path.join(process.cwd(), '.threads-token.json')
const REFRESH_AFTER_MS = 10 * 24 * 60 * 60 * 1000 // 每 10 天碰一次（長期 token 須 >24h 才能續）

type TokenStore = { token: string; savedAt: number }

function loadStore(): TokenStore | null {
  try {
    if (existsSync(TOKEN_FILE)) return JSON.parse(readFileSync(TOKEN_FILE, 'utf8'))
  } catch {
    /* 壞掉就當沒有，重種 */
  }
  return null
}

function saveStore(s: TokenStore) {
  try {
    writeFileSync(TOKEN_FILE, JSON.stringify(s))
  } catch {
    /* 寫不進去就算了，至少這次還能用 */
  }
}

// 長期 token 續期（須 >24h 老），成功回新 token，失敗回 null
async function refreshLongLived(token: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`,
      { cache: 'no-store' }
    )
    const j = await r.json().catch(() => ({}))
    return j.access_token || null
  } catch {
    return null
  }
}

async function resolveUserId(token: string): Promise<string> {
  if (process.env.THREADS_USER_ID) return process.env.THREADS_USER_ID
  const r = await fetch(`https://graph.threads.net/v1.0/me?fields=id&access_token=${encodeURIComponent(token)}`, {
    cache: 'no-store',
  })
  const me = await r.json().catch(() => ({}))
  if (!r.ok || !me.id) throw new Error('Threads token 失效或取不到帳號 ID：' + JSON.stringify(me))
  return me.id
}

async function getCreds(): Promise<ThreadsCreds> {
  const seed = process.env.THREADS_ACCESS_TOKEN || ''
  let store = loadStore()

  // 第一次：用 .env.local 的 token 種下去
  if (!store) {
    if (!seed) throw new Error('尚未設定 THREADS_ACCESS_TOKEN：請在 .env.local 填入 @q_kangber 的 Threads token')
    store = { token: seed, savedAt: Date.now() }
    saveStore(store)
  }

  // 隔一段時間自動續期（每次續成功 = 再延 60 天）
  if (Date.now() - store.savedAt > REFRESH_AFTER_MS) {
    const fresh = await refreshLongLived(store.token)
    store = { token: fresh || store.token, savedAt: Date.now() }
    saveStore(store)
  }

  try {
    const userId = await resolveUserId(store.token)
    return { token: store.token, userId }
  } catch (e) {
    // 存的 token 掛了 → 回退用 .env.local 的種子 token 重種一次
    if (seed && seed !== store.token) {
      store = { token: seed, savedAt: Date.now() }
      saveStore(store)
      const userId = await resolveUserId(seed)
      return { token: seed, userId }
    }
    throw e
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function postToThreads({ text, imageUrl }: { text: string; imageUrl?: string }) {
  if (!text || !text.trim()) throw new Error('貼文內容是空的')
  const { token, userId } = await getCreds()

  // 1) 建立容器（有圖片連結就發 IMAGE，否則純文字 TEXT）
  const base = `https://graph.threads.net/v1.0/${userId}/threads`
  const params = new URLSearchParams()
  const useImg = !!(imageUrl && imageUrl.trim())
  params.set('media_type', useImg ? 'IMAGE' : 'TEXT')
  if (useImg) params.set('image_url', imageUrl!.trim())
  params.set('text', text)
  params.set('access_token', token)

  const cRes = await fetch(`${base}?${params.toString()}`, { method: 'POST' })
  const cJson = await cRes.json().catch(() => ({}))
  if (!cRes.ok || !cJson.id) throw new Error('建立容器失敗：' + JSON.stringify(cJson))

  // 2) 發布（容器可能還沒就緒，retry 幾次）
  const pubUrl = `https://graph.threads.net/v1.0/${userId}/threads_publish`
  let lastErr: unknown = null
  for (let i = 0; i < 5; i++) {
    const pp = new URLSearchParams({ creation_id: String(cJson.id), access_token: token })
    const pRes = await fetch(`${pubUrl}?${pp.toString()}`, { method: 'POST' })
    const pJson = await pRes.json().catch(() => ({}))
    if (pRes.ok && pJson.id) {
      const id = String(pJson.id)
      let permalink = ''
      try {
        const pl = await fetch(
          `https://graph.threads.net/v1.0/${id}?fields=permalink&access_token=${encodeURIComponent(token)}`
        )
        const plj = await pl.json()
        permalink = plj.permalink || ''
      } catch {
        // permalink 拿不到就算了，發布本身已成功
      }
      return { id, permalink }
    }
    lastErr = pJson
    await sleep(3000)
  }
  throw new Error('發布失敗：' + JSON.stringify(lastErr))
}
