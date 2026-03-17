#!/bin/bash
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
[ ! -f "build/chainA/BridgeNode.json" ] && echo "ERROR: Run start-chains.sh first." && exit 1

# 確保 logs 目錄存在（AI 判定日誌會寫入此處）
mkdir -p logs

AI_LOG="logs/ai-decisions.jsonl"
if [ -f "$AI_LOG" ]; then
  echo "[monitor] 清除舊的 AI 判定日誌: $AI_LOG"
  > "$AI_LOG"
fi

echo "[monitor] 啟動即時監控（區塊鏈事件 + AI Agent 衝突判定）..."
node scripts/monitor.js
