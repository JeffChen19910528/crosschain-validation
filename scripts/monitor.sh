#!/bin/bash
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
[ ! -f "build/chainA/BridgeNode.json" ] && echo "ERROR: Run start-chains.sh first." && exit 1
node scripts/monitor.js
