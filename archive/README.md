# 封存區

這裡放的是「已從工具箱下架、但沒有刪掉」的功能。程式碼原封不動保留，只是搬出 `app/`，所以 Next.js 不會再產生路由，`tsconfig.json` 也把 `archive` 排除在型別檢查外。

封存日期：2026-08-03

目前工具箱只留三個：自選股健檢（`/watch`）、新聞轉發控制台（`/news`）、創業靈感雷達（`/tools/idea-spark`）。

## 封存了哪些

| 功能 | 原路由 | 檔案 |
| --- | --- | --- |
| 社群貼文產生器 | `/tools/social-post` | `app/tools/social-post/`、`app/api/tools/social-post/` |
| 思念機器人 | `/tools/memory-bot` | `app/tools/memory-bot/`、`app/api/tools/memory-bot/`、`lib/memory-bot.ts`、`scripts/memory-bot/` |
| 狼人殺筆記 | `/tools/werewolf` | `app/tools/werewolf/`、`app/api/tools/werewolf/`、`lib/werewolf*.ts`、`fixtures/狼人殺*.txt` |
| 梗圖配文控制台 | `/tools/meme-post` | `app/tools/meme-post/`、`app/api/tools/meme-post/`、`lib/imgflip.ts` |

`data/memory-bot/`（真實 LINE 對話）沒有搬動，本來就在 `.gitignore` 裡、不進版控，留在原地。

## 沒有一起封存的共用檔

這幾個還在用，別跟著搬走：

- `lib/groq.ts` — 創業靈感雷達在用
- `lib/llm-json.ts` — 新聞抓取／草稿在用
- `lib/threads.ts` — 新聞轉發在用

## 要復活某個功能

把該功能的資料夾從 `archive/` 搬回原本位置即可（路徑就是上表的「檔案」欄），然後在 `app/page.tsx` 的 `tools` 陣列加回一行。搬回去之後 `@/lib/...` 的 import 就會重新對上——留在 `archive/` 裡時那些 import 是斷的，這是正常的，因為型別檢查已排除此資料夾。

環境變數（`IMGFLIP_*`、`GROQ_API_KEY` 等）沒有從 `.env` 移除，復活時不用重設。
