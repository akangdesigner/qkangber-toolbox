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
  用法?: string
}

// 只餵這幾個格式給 AI，而且附上每一格該放什麼。
//
// 原因：光給模型 100 個英文名稱，強模型（gpt-4.1）自己知道格式怎麼用，
// 但正式站的 llama-3.3-70b 不知道——它挑了 Always Has Been 卻寫成兩句
// 不相干的話，完全沒用到那個梗。與其讓它亂猜，不如限縮成看得懂的經典款
// 並把用法講明。要加格式就往這裡加。
const 格式用法: Record<string, string> = {
  'Drake Hotline Bling': '1=嫌棄地拒絕的東西，2=滿意地選擇的東西。用來表態「不要這個，要那個」',
  'Two Buttons': '1、2=兩個難以取捨的按鈕選項，3=在冒汗猶豫的人是誰。用來講兩難',
  'Distracted Boyfriend': '1=見異思遷的人，2=他原本該忠於的舊選擇（女友），3=讓他分心的新歡。用來講移情別戀',
  'Expanding Brain': '4 格由淺入深，腦越來越亮。1=正常做法，2、3=越來越花俏，4=看似最高深其實最荒謬。用來反諷',
  'Always Has Been': '1=震驚的發問「等等，X 一直都是 Y？」，2=冷冷回一句「一直都是」。必須是這個問答結構',
  'One Does Not Simply': '一句話拆成兩半。1=「你沒辦法就這樣…」的前半，2=接續的後半。合起來要是通順的一句話',
  'Surprised Pikachu': '1、2=自己做了某件必然導致壞結果的事，3=結果真的發生後一臉震驚。震驚要是自找的',
  'Panik Kalm Panik': '1=慌，2=以為沒事鬆一口氣，3=發現更慘更慌。情緒是慌→安→更慌',
  'Hide the Pain Harold': '1=表面上說沒事的場面話，2=心裡真正的痛苦。反差就是笑點',
  'Clown Applying Makeup': '4 格越畫越像小丑。1→4 是一步步把自己變蠢的過程，最後承認自己是小丑',
  'Buff Doge vs. Cheems': '1、2=強壯狗代表的「以前／別人」有多猛，3、4=弱狗代表的「現在／自己」有多慘',
  "Gru's Plan": '1、2、3=自信滿滿的三步計畫，4=看到第三步發現自己搞砸了。4 跟 3 是同一件事但表情崩潰',
  'Bell Curve': '1=左端笨的人的說法，2=中間自作聰明的長篇大論，3=右端高手的說法。1 跟 3 講的要是同一句話',
  'Monkey Puppet': '1=尷尬的處境，2=默默轉頭裝沒事。用來閃躲不想面對的問題',
  'Trade Offer': '1=固定寫「交易條件」之類的開場，2=我提供什麼，3=你提供什麼',
  'Change My Mind': '1=一句欠揍但有道理的斷言。2 可留短。用來拋出爭議觀點',
  'Tuxedo Winnie The Pooh': '1=樸素的講法，2=同一件事講得很高級假掰。用來嘲諷包裝',
  'Waiting Skeleton': '1=在等什麼，2=等到變白骨。用來嘲諷等太久',
  'This Is Fine': '1=周圍已經燒起來的慘況，2=「這樣很好啊」的自欺。用來講擺爛面對災難',
  'Sad Pablo Escobar': '1、2、3=一個人孤單地等、越等越落寞。用來講沒人理的寂寞',
  'Batman Slapping Robin': '1=講了蠢話的人說的話，2=巴下去的人的回嗆。是一來一往的對話',
  'Running Away Balloon': '1=想抓住的東西，2=正在逃走的人，3、4、5=其他阻礙。格數多，每格都要有東西',
  'Left Exit 12 Off Ramp': '1=正在直行的正道，2=突然要切出去的歪路，3=開車硬切的人是誰',
  'Disaster Girl': '1=背後燒起來的災難，2=前景那個滿意微笑的縱火者是誰',
  'Roll Safe Think About It': '1=一句「只要…就不會…」的偽聰明歪理。用來講自作聰明的邏輯',
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

  // 名稱在 Imgflip 偶爾會變（標點、大小寫），比對時把非字母都去掉
  const key = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  const 用法表 = new Map(Object.entries(格式用法).map(([k, v]) => [key(k), v]))

  const templates = json.data.memes
    .map((m) => ({
      id: m.id,
      name: m.name,
      url: m.url,
      box_count: m.box_count,
      用法: 用法表.get(key(m.name)),
    }))
    .filter((t): t is Template & { 用法: string } => Boolean(t.用法))

  if (templates.length === 0) throw new Error('Imgflip 模板對不上任何已知格式')
  cache = { data: templates, expires: Date.now() + CACHE_TTL }
  return templates
}
