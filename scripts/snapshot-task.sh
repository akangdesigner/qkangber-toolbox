#!/bin/zsh
# 每日訊號快照的 macOS 排程包裝（對應 Windows 的 snapshot-task.vbs）。
# 由 launchd（com.qkangber.signal-log）每個平日 14:30 執行，16:00 再補跑一次當保險——
# 快照依「資料日」落檔且同檔股票會覆蓋合併，所以同一天重跑不會產生重複紀錄。
# 安裝：launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.qkangber.signal-log.plist
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

# launchd 給的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，node 不在裡面，得自己補上
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

mkdir -p data/signal-log
LOG="data/signal-log/run.log"
echo "=== $(date '+%F %T') 開跑 ===" >>"$LOG"
./node_modules/.bin/tsx scripts/snapshot.ts >>"$LOG" 2>&1
code=$?
echo "=== $(date '+%F %T') 結束 exit=$code ===" >>"$LOG"
exit $code
