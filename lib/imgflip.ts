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

// 每個格式「每一格該放什麼」的說明。
//
// 為什麼要有：光給模型英文名稱，強模型自己知道格式怎麼用，弱模型不知道——
// llama-3.3-70b 挑了 Always Has Been 卻寫成兩句不相干的話，完全沒用到梗。
//
// 但只餵有說明的格式會砍掉太多好用的（三頭龍那種比較型格式就被砍過一次），
// 所以 100 個全部給，這張表只是替看得懂的加上護欄，其餘讓模型自己判斷。
// 覺得哪個格式常被寫壞，就往這裡加一條。
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
  'Three-headed Dragon': '1=上方標題，2、3=兩顆兇狠的頭代表的強者，4=中間那顆蠢頭代表的弱者。用來排比三個對象、嘲笑其中一個',
  'Mocking Spongebob': '1=別人講的話，2=用陰陽怪氣的語氣把同一句話複述一遍。2 要是 1 的嘲諷版',
  'Woman Yelling At Cat': '1=激動指控的一方在罵什麼，2=一臉無辜的貓的回應。是一來一往的對嗆',
  'Anakin Padme 4 Panel': '1=某人說的計畫，2=「對吧？」的追問，3=對方沉默微笑，4=「…對吧？」的不安追問。細思極恐用',
  "They're The Same Picture": '1、2=兩個被說成不一樣、其實一模一樣的東西，3=固定寫「都一樣啊」之類的吐槽',
  'Is This A Pigeon': '1=搞錯狀況的人，2=他指著的東西，3=他誤稱它是什麼。用來嘲諷認錯東西',
  'Epic Handshake': '1、2=兩個看似不同的陣營，3=他們握手達成的共同點。用來講殊途同歸',
  'UNO Draw 25 Cards': '1=一個他打死不願意做的事（做了就要抽 25 張牌），2 可留短。用來講寧可受罰也不做',
  'Sleeping Shaq': '1=沒反應、看不上眼的小事，2=讓他暴起的大事。用來講什麼才真的踩到線',
  "They don't know": '1=角落那個人的內心話「他們不知道我…」。用來講格格不入的自嗨',
  'Scooby doo mask reveal': '1=看似的兇手，2=動手掀面具的人，3=面具下的真兇，4=真兇的名字。用來揭穿真正原因',
  'Evil Kermit': '1=理智的自己說什麼，2=黑袍的自己慫恿什麼壞主意',
  'Boardroom Meeting Suggestion': '1=老闆問的問題，2、3=兩個正常建議，4=講真話結果被丟出窗外的那句',
  'spiderman pointing at spiderman': '1、2=兩個互相指責、其實一模一樣的對象',
  'Gus Fring we are not the same': '1=別人做的事，2=我做的（其實差不多但講得高高在上）。用來反諷優越感',
  'Pawn Stars Best I Can Do': '1=對方開的價或期望，2=「我最多只能給你這個」的殺價回應',
  'Flex Tape': '1=破了大洞的問題，2=拿膠帶亂貼的人，3=貼上去的爛解法。用來講治標不治本',
  'Futurama Fry': '1=「搞不清楚是…」，2=「還是…」。用來講兩種都有可能的困惑',
  'X, X Everywhere': '1=「X」，2=「到處都是 X」。用來講某東西氾濫',
  'Two Paths': '1=兩條路的岔口情境，2=好走但錯的那條，3=難走但對的那條',
  'The Scroll Of Truth': '1=卷軸上寫的殘酷真相，2=看到後崩潰丟掉的反應',
  'Bike Fall': '1=騎車的人是誰，2=他自己插進輪子的棍子是什麼，3=摔車後怪誰。用來講自找麻煩',
  'Grim Reaper Knocking Door': '1、2、3=死神連續敲的三扇門，最後一扇才是真正要命的那個',
  'Laughing Leo': '1=一件荒謬到只能舉杯大笑的事',
  "But That's None Of My Business": '1=指出別人的問題，2=「不過不干我的事啦」的裝無辜',
  'Marked Safe From': '1=「本日平安逃過」，2=逃過的那件災難',
  'Anime Girl Hiding from Terminator': '1=在追殺的終結者是什麼，2=躲在門後的人是誰',
  'Inhaling Seagull': '1、2、3=越喊越激動的鋪陳，4=聲嘶力竭喊出的那句重點',
  'Domino Effect': '1=一個看似無關的小骨牌，2=最後倒下的巨大後果',
  'Star Wars Yoda': '1=尤達說的一句倒裝的智慧話',
  'Mother Ignoring Kid Drowning In A Pool': '1=媽媽在專注的次要小事，2=被忽略、正在溺水的重要大事',
  'Squidward window': '1=在窗外羨慕看著的人是誰，2=窗內正在開心的人在做什麼',
  'Ancient Aliens': '1=一個把什麼都歸因於荒謬理由的說法',
  'Oprah You Get A': '1=在發放什麼，2=發給誰（「每個人都有」）。用來講到處濫發',
  'All My Homies Hate': '1=我們都愛的，2=我們都恨的',
  'Whisper and Goosebumps': '1=在耳邊輕聲說的一句話，2=聽了起雞皮疙瘩的反應',
  'Two guys on a bus': '1=看著窗外美景的人在想什麼，2=看著牆壁憂鬱的人在想什麼。同一件事的兩種心情',
  'Charlie Conspiracy (Always Sunny in Philidelphia)': '1=瘋狂比對線索的人在硬扯什麼陰謀論',
  'Who Killed Hannibal': '1=某人做了什麼，2=他自己驚訝地問「是誰做的？」，3=其實就是他自己',
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

  const templates = json.data.memes.map((m) => ({
    id: m.id,
    name: m.name,
    url: m.url,
    box_count: m.box_count,
    用法: 用法表.get(key(m.name)),
  }))
  cache = { data: templates, expires: Date.now() + CACHE_TTL }
  return templates
}
