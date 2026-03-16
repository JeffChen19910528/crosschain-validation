#!/bin/bash
set -e
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

DURATION=${1:-600}
CONCURRENCY=${2:-10}
AMOUNT=${3:-"0.001"}
REPORT_DIR="$PROJECT_ROOT/reports"
mkdir -p "$REPORT_DIR"

echo "=========================================="
echo " AO4C Stress Test"
echo " Duration   : ${DURATION}s"
echo " Concurrency: ${CONCURRENCY} parallel txs"
echo " Amount/tx  : ${AMOUNT} ETH"
echo " Mode       : Bidirectional OCC"
echo "=========================================="

CHAIN_DOWN=false
for PORT in 8545 8546; do
  curl -sf -X POST "http://127.0.0.1:$PORT" -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1 || CHAIN_DOWN=true
done

[ "$CHAIN_DOWN" = true ] && bash "$PROJECT_ROOT/scripts/start-chains.sh"
sleep 2

node stress-test/sender.js \
  --duration "$DURATION" \
  --concurrency "$CONCURRENCY" \
  --amount "$AMOUNT" \
  --report-dir "$REPORT_DIR"
