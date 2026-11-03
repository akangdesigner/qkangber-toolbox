#!/bin/zsh
# 熱門 AI 話題 LINE 推播的 Mac 排程包裝（launchd 叫這支，設定檔見 scripts/com.qkangber.news-push.plist）。
# launchd 的 PATH 只有系統目錄，找不到 Homebrew 裝的 node，所以這裡自己補。
# 安裝：cp scripts/com.qkangber.news-push.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.qkangber.news-push.plist
# 手動跑一次：launchctl start com.qkangber.news-push
# 紀錄：data/news-push/run.log
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
mkdir -p data/news-push
echo "===== $(date '+%Y-%m-%d %H:%M:%S') =====" >> data/news-push/run.log
npx tsx --env-file=.env scripts/news-push.ts >> data/news-push/run.log 2>&1
