#!/bin/bash
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}[UP]${NC}   $1"; }
fail() { echo -e "  ${RED}[DOWN]${NC} $1"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; }

echo "=========================================="
echo " AO4C Cross-Chain Lab — Service Status"
echo "=========================================="

for CHAIN in "A:8545:chainA" "B:8546:chainB"; do
  LABEL=$(echo $CHAIN | cut -d: -f1)
  PORT=$(echo $CHAIN  | cut -d: -f2)
  KEY=$(echo $CHAIN   | cut -d: -f3)
  echo ""; echo "Chain $LABEL (port $PORT)"
  if curl -sf -X POST "http://127.0.0.1:$PORT" -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' -o /tmp/_rpc.json 2>/dev/null; then
    BLOCK=$(python3 -c "import json; d=json.load(open('/tmp/_rpc.json')); print(int(d['result'],16))" 2>/dev/null)
    ok "RPC reachable — blockNumber: $BLOCK"
    [ -f "$LOG_DIR/$KEY.pid" ] && PID=$(cat "$LOG_DIR/$KEY.pid") && \
      (kill -0 "$PID" 2>/dev/null && ok "Process running (PID $PID)" || warn "PID $PID not found")
  else
    fail "RPC not reachable"
  fi
done

echo ""; echo "Oracle"
[ -f "$LOG_DIR/oracle.pid" ] && PID=$(cat "$LOG_DIR/oracle.pid") && \
  (kill -0 "$PID" 2>/dev/null && ok "Process running (PID $PID)" || fail "PID $PID not running") \
  || fail "oracle.pid not found"

echo ""; echo "BridgeNode Contracts"
if [ -f "$PROJECT_ROOT/build/chainA/BridgeNode.json" ] && [ -f "$PROJECT_ROOT/build/chainB/BridgeNode.json" ]; then
  ADDR_A=$(python3 -c "import json; d=json.load(open('$PROJECT_ROOT/build/chainA/BridgeNode.json')); print(list(d['networks'].values())[-1]['address'])" 2>/dev/null)
  ADDR_B=$(python3 -c "import json; d=json.load(open('$PROJECT_ROOT/build/chainB/BridgeNode.json')); print(list(d['networks'].values())[-1]['address'])" 2>/dev/null)
  ok "BridgeNode (Chain A): $ADDR_A"
  ok "BridgeNode (Chain B): $ADDR_B"
else
  fail "Artifacts not found — run start-chains.sh first"
fi

echo ""; echo "AI Agent (Claude Code CLI)"
command -v claude &>/dev/null \
  && ok "claude CLI: $(claude --version 2>/dev/null || echo 'installed')" \
  || fail "claude CLI not found — run: npm install -g @anthropic-ai/claude-code"

echo ""; echo "=========================================="
