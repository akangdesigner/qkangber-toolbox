' 熱門 AI 話題 LINE 推播的排程包裝：完全隱藏視窗執行，等腳本結束、把 exit code 回傳給工作排程器（失敗時才會依設定重跑）。
' 建立排程（一天四次：09:00、13:00、17:00、21:00），在 cmd 貼上：
'   schtasks /Create /TN qkangber-news-push /SC DAILY /ST 09:00 /RI 240 /DU 12:30 /TR "wscript.exe //B //Nologo D:\qkangber-toolbox\scripts\news-push-task.vbs"
' 間隔別調到每小時以下：每跑一次要叫一次 LLM（約 US$0.07），見 scripts/news-push.ts 開頭。
Dim sh: Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run("cmd /c cd /d D:\qkangber-toolbox && if not exist data\news-push mkdir data\news-push && npx tsx --env-file=.env scripts/news-push.ts >> data\news-push\run.log 2>&1", 0, True)
