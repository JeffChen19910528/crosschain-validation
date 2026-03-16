#!/bin/bash
set -e
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# ── 參數 ────────────────────────────────────────────────────────
BATCH=${1:-10}        # 每輪同時送出的交易數
ROUNDS=${2:-5}        # 實驗輪數
AMOUNT=${3:-"0.001"}  # 每筆金額 ETH
DIRECTION=${4:-"AB"}  # AB 或 BA
REPORT_DIR="$PROJECT_ROOT/reports"
mkdir -p "$REPORT_DIR"

echo "============================================"
echo " AO4C TOD Protection Experiment"
echo " Batch size : $BATCH tx (sent simultaneously)"
echo " Rounds     : $ROUNDS"
echo " Amount/tx  : $AMOUNT ETH"
echo " Direction  : $DIRECTION"
echo " Report dir : $REPORT_DIR"
echo "============================================"
echo ""
echo "實驗說明："
echo "  每輪同時送出 $BATCH 筆交易，每筆 gasPrice 不同（梯度從高到低）"
echo "  模擬攻擊者試圖透過 gasPrice 操控礦工排序（TOD 攻擊場景）"
echo "  記錄 gasPrice排名 / txIndex排名（礦工） / seqNo排名（AO4C）三欄"
echo "  若 Spearman(gasPrice, seqNo) 接近 0 → TOD 防護有效"
echo ""

# ── 確認鏈是否在線 ──────────────────────────────────────────────
CHAIN_DOWN=false
for PORT in 8545 8546; do
  curl -sf -X POST "http://127.0.0.1:$PORT" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    > /dev/null 2>&1 || CHAIN_DOWN=true
done

if [ "$CHAIN_DOWN" = true ]; then
  echo "[Setup] Chains not running, starting..."
  bash "$PROJECT_ROOT/scripts/start-chains.sh"
  sleep 3
else
  echo "[OK] Both chains are running."
fi

# ── 確認 Oracle 在線 ─────────────────────────────────────────────
if [ -f "$PROJECT_ROOT/logs/oracle.pid" ]; then
  PID=$(cat "$PROJECT_ROOT/logs/oracle.pid")
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "[Setup] Oracle not running, restarting..."
    node "$PROJECT_ROOT/oracle/oracle.js" > "$PROJECT_ROOT/logs/oracle.log" 2>&1 &
    echo $! > "$PROJECT_ROOT/logs/oracle.pid"
    sleep 2
  else
    echo "[OK] Oracle is running (PID $PID)."
  fi
else
  echo "[Setup] Starting Oracle..."
  node "$PROJECT_ROOT/oracle/oracle.js" > "$PROJECT_ROOT/logs/oracle.log" 2>&1 &
  echo $! > "$PROJECT_ROOT/logs/oracle.pid"
  sleep 2
fi

echo ""
echo "[TOD] Starting experiment..."
echo ""

node stress-test/tod-test.js \
  --batch     "$BATCH"     \
  --rounds    "$ROUNDS"    \
  --amount    "$AMOUNT"    \
  --direction "$DIRECTION" \
  --report-dir "$REPORT_DIR"

echo ""
echo "[TOD] Experiment complete."
echo "[TOD] Reports saved to: $REPORT_DIR/"
ls -lh "$REPORT_DIR"/ao4c-tod-*.xlsx 2>/dev/null || echo "(No TOD report found)"
