#!/bin/bash
set -e
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
[ ! -f "build/chainA/BridgeNode.json" ] && echo "ERROR: Run start-chains.sh first." && exit 1
echo "[UI] Starting at http://localhost:3000"
node ui/server.js
