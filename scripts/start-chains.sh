#!/bin/bash
set -e
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR" "$PROJECT_ROOT/build/chainA" "$PROJECT_ROOT/build/chainB"

echo "=========================================="
echo " AO4C Cross-Chain Lab - Starting"
echo "=========================================="

for PORT in 8545 8546; do
  PID=$(lsof -ti tcp:$PORT 2>/dev/null || true)
  [ -n "$PID" ] && kill -9 $PID 2>/dev/null || true
done
pkill -f "hardhat node" 2>/dev/null || true
sleep 1

echo "[1/4] Starting Chain A (port 8545)..."
cd "$PROJECT_ROOT"
npx hardhat node --port 8545 > "$LOG_DIR/chainA.log" 2>&1 &
echo $! > "$LOG_DIR/chainA.pid"

echo "[2/4] Starting Chain B (port 8546)..."
npx hardhat node --port 8546 > "$LOG_DIR/chainB.log" 2>&1 &
echo $! > "$LOG_DIR/chainB.pid"

echo "[3/4] Waiting for chains..."
for PORT in 8545 8546; do
  echo -n "      port $PORT..."
  for i in $(seq 1 30); do
    curl -sf -X POST "http://127.0.0.1:$PORT" -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1 && echo " ready!" && break
    [ $i -eq 30 ] && echo " TIMEOUT!" && exit 1
    sleep 1; echo -n "."
  done
done

echo "[4/4] Deploying BridgeNode contracts..."
npx hardhat compile 2>&1 | grep -v "^$"
npx hardhat run scripts/deploy.js 2>&1 | tee "$LOG_DIR/deploy.log"

echo ""
echo "Starting Oracle (AO4C bidirectional mode)..."
pkill -f "oracle/oracle.js" 2>/dev/null || true
sleep 1
node "$PROJECT_ROOT/oracle/oracle.js" > "$LOG_DIR/oracle.log" 2>&1 &
echo $! > "$LOG_DIR/oracle.pid"
echo "Oracle started (log: $LOG_DIR/oracle.log)"
echo ""
echo "All services ready."
echo "  UI    : bash scripts/start-ui.sh"
echo "  Stress: bash scripts/auto-stress-test.sh [duration] [concurrency] [amount]"
