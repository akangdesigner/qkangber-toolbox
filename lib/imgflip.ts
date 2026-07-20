// Imgflip 的公開模板清單（免費、免認證）。
//
// 這裡只拿「空白模板」當推薦素材，不呼叫它的 caption_image 合成圖，原因：
// 1. caption_image 要帳號密碼，而且字型只有 Impact/Arial，Impact 沒有中文字符，
//    官方也沒有 CJK 支援的說明——很可能渲出豆腐方塊
// 2. get_memes 不回傳文字框座標，自己用 canvas 畫只能做上下字，
//    套到 Drake（右側上下兩格）或 Two Buttons（三個定點）就會歪掉
// 所以合成交給人手動做（memes.tw 產生器在瀏覽器裡是正常的），
// AI 負責的是「挑哪個格式 + 每一格寫什麼」。

export type Template = {
  id: string
  name: string
  url: string
  box_count: number
}

type CacheEntry = { data: Template[]; expires: number }
let cache: CacheEntry | null = null
const CACHE_TTL = 6 * 60 * 60 * 1000 // 模板清單幾乎不變，快取久一點

export async function fetchTemplates(): Promise<Template[]> {
  if (cache && cache.expires > Date.now()) return cache.data

  const res = await fetch('https://api.imgflip.com/get_memes', {
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`Imgflip 回應 ${res.status}`)
  const json = (await res.json()) as {
    success?: boolean
    data?: { memes?: { id: string; name: string; url: string; box_count: number }[] }
  }
  if (!json.success || !json.data?.memes) throw new Error('Imgflip 回傳格式錯誤')

  const templates = json.data.memes.map((m) => ({
    id: m.id,
    name: m.name,
    url: m.url,
    box_count: m.box_count,
  }))
  cache = { data: templates, expires: Date.now() + CACHE_TTL }
  return templates
}
