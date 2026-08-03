# 思念機器人 — v0（驗證帶入感）

最小可跑的一塊：用真實 LINE 匯出對話，做出「講話像那個人」的聊天，**先不碰 LINE 串接、向量庫、多租戶**。
目的：在蓋任何 infra 之前，先回答唯一重要的問題——**聊起來像不像那個人？**

## 管線

```
LINE 匯出 .txt
  └─ parse-line.mjs    → data/memory-bot/parsed.json     （結構化訊息）
       └─ build-persona.mjs → style-report.json（確定性風格統計）
                            → persona.md       （LLM 寫的人格說明書）
            └─ chat.mjs   → 終端機跟「那個人」聊天
                            （窮人版 RAG：關鍵字撈過去對話，尚未用 embedding）
```

## 怎麼跑

```bash
# 1. 解析（換成你的 txt 路徑）
node scripts/memory-bot/parse-line.mjs "C:/Users/asdto/OneDrive/桌面/[LINE]張.txt" > data/memory-bot/parsed.json

# 2. 萃取人格（target=思念對象，user=你自己；名稱要跟匯出檔裡的顯示名一致）
node scripts/memory-bot/build-persona.mjs --target 張 --user 康🍺

# 3. 聊天
node scripts/memory-bot/chat.mjs                       # 互動
node scripts/memory-bot/chat.mjs --say "今天好累喔"     # 單句測試
```

需要 `.env.local` 裡的 `GROQ_API_KEY`。

## v0 的發現 / 已知限制

- **確定性統計（style-report.json）比 LLM 歸納可靠**：Llama 3.3 70b 的繁中歸納會幻覺（憑空生出資料裡沒有的口頭禪／emoji）。所以 chat 的 system prompt 重壓「統計事實＋真實原句」，把 persona.md 當參考而非真理。
  → 若要明顯提升繁中擬真，建議接 Claude（需 Anthropic key），目前用 repo 既有的 Groq。
- **解析器**對齊的是這一份匯出格式（`HH:MM 發話者 內容`＋多行續行＋`已收回訊息`＋媒體佔位）。換別人的匯出檔請先 `--stats` 檢查發話者偵測對不對。
- **記憶召回是窮人版**（2-gram 關鍵字重疊），夠驗證方向；對話量大或要語意召回時，再升級成 embedding + sqlite-vec。

## 下一步（依原規格的階段）

- v1：接 LINE webhook + `sender` 帶入頭像/暱稱（複用銀髮機器人），單人寫死。
- v2：對話塞不下 context 時，才上 embedding + sqlite-vec + 多租戶（user_id 隔離）。
- v3：成長層——每隔幾輪把新對話濃縮成記憶寫回。

## 安全政策（v0 已補上）

- **危機訊息 override**：偵測到明確自傷/自殺意圖的關鍵字（`detectCrisis()`，`lib/memory-bot.ts`），就整段跳過人設與 LLM，回固定文案（`CRISIS_RESPONSE`）——附 1925 / 1995 / 1980 / 119，並主動跳出「張」的角色，不讓人設在這種時刻附和。文案是寫死的，不交給 LLM 生成，避免語氣在關鍵時刻失控。
  - 關鍵字刻意排除「好想你」「好孤單」這類正常思念語句——那是這個工具的核心使用情境，不該被攔下。寧可少數誤觸發，也不要漏接。
  - 網頁版（`app/api/tools/memory-bot/route.ts`）與終端機版（`chat.mjs`）各自維護一份同樣的清單，兩邊都會擋。
  - **已知限制**：純關鍵字比對，抓不到沒講明的委婉表達。之後若要更穩，可以考慮把使用者最近幾則訊息一起送去做輕量分類，而不是只看單則。
- **撈不到記憶的人設回應**：目前靠 system prompt 的鐵則處理——「絕不捏造具體的共同回憶或事件，不確定就模糊承接（範例：『啊那個我有點忘ㄌ，你說來聽聽』），不要編」。沒有另外做程式判斷（`ctx.length === 0` 時不特別分支），實測夠用；如果之後發現 LLM 還是會硬掰，再回來加更明確的分支邏輯。
