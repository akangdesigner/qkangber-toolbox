' 每日訊號快照的排程包裝：完全隱藏視窗執行（不彈黑窗、不會被誤按 Ctrl+C 中斷），
' 並等待腳本結束、把 exit code 回傳給工作排程器——失敗（非零）時排程器才會依設定自動重跑。
' 工作排程器動作：wscript.exe //B //Nologo "D:\qkangber-toolbox\scripts\snapshot-task.vbs"
Dim sh: Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run("cmd /c cd /d D:\qkangber-toolbox && npx tsx scripts/snapshot.ts >> data\signal-log\run.log 2>&1", 0, True)
