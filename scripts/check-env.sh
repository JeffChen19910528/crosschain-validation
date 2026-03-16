#!/bin/bash
set -e

NEED_NODE_UPGRADE=false

echo "=========================================="
echo " AO4C Cross-Chain Lab — Environment Check"
echo "=========================================="

echo ""
echo "[Step 1] Updating apt package list..."
sudo apt-get update -qq

echo ""
echo "[Step 2] Checking basic tools..."
for pkg in curl wget git build-essential python3; do
  dpkg -s "$pkg" &>/dev/null && echo "[OK]  $pkg" || { echo "[INSTALL] $pkg"; sudo apt-get install -y "$pkg"; }
done

echo ""
echo "[Step 3] Checking Node.js..."
if command -v node &>/dev/null; then
  NODE_VER=$(node -e "process.stdout.write(process.version)" | sed 's/v//' | cut -d. -f1)
  [ "$NODE_VER" -lt 18 ] && NEED_NODE_UPGRADE=true || echo "[OK]  Node.js $(node --version)"
else
  NEED_NODE_UPGRADE=true
fi

if [ "$NEED_NODE_UPGRADE" = true ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "[OK]  Node.js $(node --version) installed"
fi

echo ""
echo "[Step 4] Checking npm..."
command -v npm &>/dev/null && echo "[OK]  npm $(npm --version)" || sudo apt-get install -y npm

echo ""
echo "[Step 5] Checking jq, lsof..."
command -v jq   &>/dev/null || sudo apt-get install -y jq
command -v lsof &>/dev/null || sudo apt-get install -y lsof
echo "[OK]  jq, lsof"

echo ""
echo "[Step 6] Checking npm packages..."
PACKAGES=(hardhat web3 express ws dotenv axios exceljs dayjs p-limit)
for pkg in "${PACKAGES[@]}"; do
  node -e "require('$pkg')" 2>/dev/null && echo "[OK]  npm:$pkg" || { echo "[INSTALL] $pkg"; npm install "$pkg"; }
done
node -e "require('@nomicfoundation/hardhat-toolbox')" 2>/dev/null \
  || npm install --save-dev @nomicfoundation/hardhat-toolbox

echo ""
echo "[Step 7] Checking Claude Code CLI (AI Agent)..."
if command -v claude &>/dev/null; then
  echo "[OK]  claude CLI: $(claude --version 2>/dev/null || echo 'installed')"
else
  echo "[INSTALL] Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code 2>/dev/null \
    && echo "[OK]  claude CLI installed" \
    || echo "[WARN] 請手動執行: npm install -g @anthropic-ai/claude-code"
  echo ""
  echo "[ACTION REQUIRED] 執行 'claude' 完成 Claude Code 月訂閱帳號登入"
fi

echo ""
echo "=========================================="
echo " Node.js : $(node --version)"
echo " npm     : $(npm --version)"
echo " claude  : $(command -v claude &>/dev/null && echo 'installed' || echo 'NOT FOUND')"
echo "=========================================="
