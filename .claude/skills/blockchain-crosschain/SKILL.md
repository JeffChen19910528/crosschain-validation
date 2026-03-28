---
name: blockchain-crosschain-lab
description: 建置區塊鏈跨鏈交易實驗環境。當使用者要求建立區塊鏈測試環境、雙向跨鏈交易、Solidity 智能合約開發（AO4C 演算法）、Hardhat 測試鏈、Oracle 中繼設計、樂觀併發控制（OCC）、TOD 防護、雙花攻擊防護、ACID 保證、AI Agent 衝突驗證、Claude Code CLI 整合、或吞吐量效能實驗記錄時使用此 skill。此 skill 實作 AO4C（AI-Augmented Optimistic Cross-Chain Concurrency Control）完整架構，包含雙向對稱智能合約（BridgeNode）、三階段 OCC 演算法、Node.js Oracle 中繼、Claude Code CLI AI Agent、Web3 介面、自動化壓力測試與 Excel 報表。
---

# Blockchain Cross-Chain Lab Skill — AO4C 架構

此 skill 指導 Claude 建置 **AO4C（AI-Augmented Optimistic Cross-Chain Concurrency Control）** 跨鏈交易實驗環境。

核心設計原則：
- **演算法核心全部在智能合約層**，鏈上執行，任何人可驗證
- **雙向對稱**：兩條鏈部署同一份 `BridgeNode.sol`，A→B 和 B→A 皆可發起
- **Oracle 只做輕量中繼**：監聽事件、呼叫 AI Agent、帶回結果，不做任何排序或衝突判斷
- **AI Agent 做語意層判斷**：Claude Code CLI 判斷衝突，取代人工定義規則

---

## 論文架構定位

### 解決的經典問題

| 問題 | 解法層 | 機制 |
|------|--------|------|
| **TOD（Transaction Ordering Dependence）** | 智能合約 | 確定性排序承諾：`seqNo = nextSeqNo++`，EVM 執行序決定，不依賴礦工 |
| **Front-Running** | 智能合約 | Commit-Reveal：Phase 1 只送 `hash(amount+salt)`，Phase 2 才 reveal 金額 |
| **雙花攻擊（Double Spend）** | 智能合約 + AI | `processedRequests` mapping + OCC version + AI 語意判斷三層防護 |
| **ACID Isolation** | 智能合約 | `globalVersion` 序列化點，`validateAndExecute` 做 version 驗證，等效 Serializable Isolation |
| **語意層衝突** | AI Agent | Claude Code CLI 判斷有序序列中的語意衝突，不需人工定義規則 |

### AO4C 三階段 OCC 演算法

```
Phase 1 — Order Commitment（防 TOD + Front-Running）
  使用者呼叫 BridgeNode.commitOrder(blindedAmount, recipient, targetChainId)
  合約記錄承諾，emit OrderCommitted
  blindedAmount = keccak256(amount + salt)，隱藏金額

Phase 2 — Reveal & AI Validation（防雙花，滿足 ACID Isolation）
  使用者呼叫 BridgeNode.revealOrder(requestId, amount, salt)
  合約驗證 hash，emit OrderRevealed（含鏈上排序序號 seqNo）
  Oracle 收到事件 → 帶有序序列呼叫 Claude Code CLI
  Claude Code 回傳 { commits: [...], aborts: [...] }

Phase 3 — Execution（原子 commit 或 abort）
  Oracle 將 AI 結果帶回目標鏈 BridgeNode.validateAndExecute()
  合約做 version 驗證（最後防線）
  無衝突 → transfer ETH，globalVersion++，emit OrderExecuted
  有衝突 → refund ETH，emit OrderAborted
```

---

## 已知關鍵問題（必須遵守）

| 問題 | 原因 | 解法 |
|------|------|------|
| **不可用 Truffle migrate 部署** | Truffle 與 Node.js v24 不相容，migrate 會靜默跳過 | 改用 `scripts/deploy.js`（Hardhat + ethers.js） |
| **Web3 v4 事件訂閱須加 await** | v4 API 改為 async，不加 await 則 `.on()` 報 undefined | `const sub = await contract.events.EventName(...)` |
| **p-limit 必須用 v3.x** | v4+ 為 ESM only，Node.js CommonJS require 會失敗 | `"p-limit": "^3.1.0"` |
| **兩條 Hardhat 鏈 chainId 相同 → "Cannot peer with self"** | `npx hardhat node` 不管 config 設定，`eth_chainId` 永遠回傳 `31337`，兩條鏈相同，合約 `require(chainId != thisChainId)` 報錯，`BridgeNode.json` 不會寫入 | **絕對不能用 `eth_chainId` 當合約識別碼**。deploy.js / oracle.js / ui/app.js / sender.js / tod-test.js 全部改用邏輯 ID 字串 `"8545"` / `"8546"`（port 號），hardcode 不讀鏈 |
| **瀏覽器無法直接連 Hardhat** | Hardhat CORS preflight 不允許 POST | ui/server.js 加 RPC 代理路由 `/rpc/chainA`, `/rpc/chainB` |
| **Oracle 連鏈需 WebSocket** | 事件訂閱需 ws:// 協定 | `URL.replace("http://", "ws://")` |
| **claude CLI 必須事先安裝並登入** | AI Agent 透過 child_process 呼叫 `claude` CLI | `npm install -g @anthropic-ai/claude-code` 並完成登入 |
| **claude CLI 輸出需要 --output-format json** | 預設輸出含 ANSI 色碼難以 parse | `claude --output-format json -p "<prompt>"` |
| **兩條鏈的 BridgeNode 需互知對方地址** | Oracle 轉發時需要知道目標鏈合約地址 | deploy.js 部署後互相呼叫 `setPeerNode(logicalId, address)` |
| **雙向並發時 version 各自獨立** | 每條鏈的 globalVersion 只管本鏈狀態 | Oracle AI Agent prompt 需同時帶入兩條鏈的 version 快照 |

---

## 專案結構總覽

```
crosschain/
├── contracts/
│   └── BridgeNode.sol              # 雙向對稱合約，兩條鏈各部署一份
├── scripts/
│   ├── deploy.js                   # 部署兩條鏈的 BridgeNode + 互相設定 peer
│   ├── start-chains.sh             # 啟動鏈 + 部署 + Oracle
│   ├── start-ui.sh                 # 啟動 UI
│   ├── auto-stress-test.sh         # 壓力測試入口
│   ├── monitor.sh                  # 即時監控入口
│   ├── monitor.js                  # 即時監控實作（雙向事件）
│   ├── run-tod-test.sh             # TOD 實驗入口
│   ├── status.sh                   # 查看所有服務狀態
│   └── check-env.sh                # 環境依賴檢測（含 claude CLI）
├── oracle/
│   ├── oracle.js                   # Oracle 主程式（雙向監聽，Web3 v4）
│   ├── occExecutor.js              # OCC 批次執行器（輕量，不做排序）
│   ├── aiConflictAgent.js          # AI Agent：Claude Code CLI 衝突驗證
│   └── .env                        # CHAIN_A_URL, CHAIN_B_URL
├── ui/
│   ├── index.html                  # 使用者介面（雙向交易 + OCC 狀態）
│   ├── app.js                      # 前端邏輯
│   └── server.js                   # Express + RPC 代理
├── stress-test/
│   ├── sender.js                   # 雙向併發交易發送器
│   ├── report-generator.js         # Excel 報表產生器（含 OCC abort 統計）
│   ├── tod-test.js                 # TOD 防護實驗（Spearman 相關係數）
│   └── tod-report-generator.js     # TOD Excel 報表產生器
├── hardhat.config.js
├── package.json
├── logs/
└── reports/
```

---

## Step 0：環境檢測與安裝

### scripts/check-env.sh

```bash
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
```

---

## Step 1：初始化專案

```bash
mkdir -p crosschain/{contracts,scripts,oracle,ui,stress-test,logs,reports,build/chainA,build/chainB}
cd crosschain
npm init -y
npm install web3 express ws dotenv axios exceljs dayjs
npm install "p-limit@^3.1.0"
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
```

### package.json

```json
{
  "name": "ao4c-crosschain-lab",
  "version": "1.0.0",
  "scripts": {
    "start:chains": "bash scripts/start-chains.sh",
    "start:ui":    "bash scripts/start-ui.sh",
    "stress-test": "bash scripts/auto-stress-test.sh",
    "oracle":      "node oracle/oracle.js"
  },
  "dependencies": {
    "axios":   "^1.6.0",
    "dayjs":   "^1.11.10",
    "dotenv":  "^16.3.1",
    "exceljs": "^4.4.0",
    "express": "^4.18.2",
    "p-limit": "^3.1.0",
    "web3":    "^4.3.0",
    "ws":      "^8.16.0"
  },
  "devDependencies": {
    "@nomicfoundation/hardhat-toolbox": "^4.0.0",
    "hardhat": "^2.19.0"
  }
}
```

---

## Step 2：Hardhat 設定

### hardhat.config.js

```javascript
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: "0.8.20",
  networks: {
    chainA: { url: "http://127.0.0.1:8545", chainId: 1337 },
    chainB: { url: "http://127.0.0.1:8546", chainId: 1338 },
  },
};
```

---

## Step 3：智能合約 — BridgeNode.sol

### contracts/BridgeNode.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BridgeNode {

    address public owner;
    address public oracle;
    uint256 public immutable thisChainId;

    uint256 public globalVersion;
    uint256 public nextSeqNo;

    mapping(uint256 => address) public peerNodes;
    mapping(bytes32 => CommitRecord) public commitRecords;
    mapping(bytes32 => bool) public processedRequests;
    mapping(bytes32 => bool) public abortedRequests;

    struct CommitRecord {
        address sender;
        bytes32 blindedAmount;
        address recipient;
        uint256 targetChainId;
        uint256 blockNumber;
        uint256 seqNo;
        uint256 readVersion;
        uint256 amount;
        bool    revealed;
        bool    executed;
        bool    aborted;
    }

    event OrderCommitted(
        bytes32 indexed requestId,
        address indexed sender,
        bytes32 blindedAmount,
        address recipient,
        uint256 targetChainId,
        uint256 blockNumber,
        uint256 readVersion
    );

    event OrderRevealed(
        bytes32 indexed requestId,
        address indexed sender,
        uint256 amount,
        address recipient,
        uint256 targetChainId,
        uint256 seqNo,
        uint256 readVersion
    );

    event OrderExecuted(
        bytes32 indexed requestId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 seqNo,
        uint256 newGlobalVersion,
        string  conflictNote
    );

    event OrderAborted(
        bytes32 indexed requestId,
        address indexed sender,
        uint256 amount,
        uint256 seqNo,
        string  reason
    );

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier onlyOracle() { require(msg.sender == oracle, "Not oracle"); _; }

    constructor(uint256 _chainId, address _oracle) {
        owner       = msg.sender;
        oracle      = _oracle;
        thisChainId = _chainId;
    }

    function setPeerNode(uint256 chainId, address nodeAddress) external onlyOwner {
        require(chainId != thisChainId, "Cannot peer with self");
        peerNodes[chainId] = nodeAddress;
    }

    function setOracle(address _oracle) external onlyOwner {
        oracle = _oracle;
    }

    function commitOrder(
        bytes32 blindedAmount,
        address recipient,
        uint256 targetChainId
    ) external payable {
        require(msg.value > 0,                         "Amount must be > 0");
        require(recipient != address(0),               "Invalid recipient");
        require(targetChainId != thisChainId,          "Cannot bridge to self");
        require(peerNodes[targetChainId] != address(0),"Unknown target chain");

        uint256 readVersion = globalVersion;

        bytes32 requestId = keccak256(abi.encodePacked(
            msg.sender, msg.value, block.timestamp, block.number, thisChainId
        ));
        require(commitRecords[requestId].sender == address(0), "Duplicate requestId");

        commitRecords[requestId] = CommitRecord({
            sender:        msg.sender,
            blindedAmount: blindedAmount,
            recipient:     recipient,
            targetChainId: targetChainId,
            blockNumber:   block.number,
            seqNo:         0,
            readVersion:   readVersion,
            amount:        0,
            revealed:      false,
            executed:      false,
            aborted:       false
        });

        emit OrderCommitted(
            requestId, msg.sender, blindedAmount,
            recipient, targetChainId, block.number, readVersion
        );
    }

    function revealOrder(
        bytes32 requestId,
        uint256 amount,
        uint256 salt
    ) external {
        CommitRecord storage rec = commitRecords[requestId];
        require(rec.sender != address(0), "Request not found");
        require(rec.sender == msg.sender, "Not your request");
        require(!rec.revealed,            "Already revealed");
        require(!rec.aborted,             "Already aborted");
        require(rec.amount == 0,          "Already set");

        require(
            keccak256(abi.encodePacked(amount, salt)) == rec.blindedAmount,
            "Hash mismatch: invalid amount or salt"
        );

        rec.amount   = amount;
        rec.revealed = true;
        rec.seqNo    = nextSeqNo++;

        emit OrderRevealed(
            requestId, rec.sender, amount,
            rec.recipient, rec.targetChainId,
            rec.seqNo, rec.readVersion
        );
    }

    function validateAndExecute(
        bytes32 requestId,
        bool    hasConflict,
        string  calldata conflictNote,
        uint256 expectedVersion
    ) external onlyOracle {
        require(!processedRequests[requestId], "Already processed");
        require(!abortedRequests[requestId],   "Already aborted");

        CommitRecord storage rec = commitRecords[requestId];
        require(rec.sender   != address(0), "Request not found");
        require(rec.revealed,               "Not yet revealed");
        require(!rec.executed,              "Already executed");
        require(!rec.aborted,               "Already aborted");
        require(address(this).balance >= rec.amount, "Insufficient funds");

        if (hasConflict) {
            _abort(requestId, rec, conflictNote);
        } else {
            if (globalVersion != expectedVersion) {
                _abort(requestId, rec, "Version conflict: concurrent commit detected");
                return;
            }
            processedRequests[requestId] = true;
            rec.executed = true;
            globalVersion++;
            emit OrderExecuted(
                requestId, rec.sender, rec.recipient,
                rec.amount, rec.seqNo, globalVersion, conflictNote
            );
        }
    }

    function executeTransfer(
        bytes32 requestId,
        address payable recipient,
        uint256 amount,
        uint256 srcChainId
    ) external onlyOracle {
        require(!processedRequests[requestId],       "Already processed");
        require(peerNodes[srcChainId] != address(0), "Unknown source chain");
        require(address(this).balance >= amount,     "Insufficient bridge funds");

        processedRequests[requestId] = true;
        recipient.transfer(amount);

        emit OrderExecuted(
            requestId, address(0), recipient,
            amount, 0, globalVersion, "transfer from peer chain"
        );
    }

    function _abort(
        bytes32 requestId,
        CommitRecord storage rec,
        string memory reason
    ) internal {
        abortedRequests[requestId] = true;
        rec.aborted = true;
        payable(rec.sender).transfer(rec.amount);
        emit OrderAborted(requestId, rec.sender, rec.amount, rec.seqNo, reason);
    }

    function getRecord(bytes32 requestId) external view returns (CommitRecord memory) {
        return commitRecords[requestId];
    }

    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function deposit() external payable {}
    receive() external payable {}
}
```

---

## Step 4：部署腳本

> **關鍵**：兩條 Hardhat 鏈的 `eth_chainId` 都回傳 `31337`，直接讀取會導致合約 `require(chainId != thisChainId)` 報錯 "Cannot peer with self"。
> 必須 hardcode 邏輯 ID `"8545"` / `"8546"`，不呼叫 `getNetwork().chainId`。

### scripts/deploy.js

```javascript
const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function deployBridgeNode(rpcUrl, chainId, oracleAddress) {
  console.log(`\n[Deploy] BridgeNode → ${rpcUrl} (chainId=${chainId})`);

  const artifactPath = path.join(
    __dirname, "../artifacts/contracts/BridgeNode.sol/BridgeNode.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer   = await provider.getSigner();
  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);

  const contract = await factory.deploy(chainId, oracleAddress);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const txHash  = contract.deploymentTransaction()?.hash ?? "";
  console.log(`[Deploy] BridgeNode deployed at: ${address}`);

  return { address, txHash, abi: artifact.abi, bytecode: artifact.bytecode, provider, signer };
}

async function main() {
  const CHAIN_A_URL = "http://127.0.0.1:8545";
  const CHAIN_B_URL = "http://127.0.0.1:8546";
  const BUILD_A     = path.join(__dirname, "../build/chainA");
  const BUILD_B     = path.join(__dirname, "../build/chainB");

  fs.mkdirSync(BUILD_A, { recursive: true });
  fs.mkdirSync(BUILD_B, { recursive: true });

  const provA = new ethers.JsonRpcProvider(CHAIN_A_URL);
  const provB = new ethers.JsonRpcProvider(CHAIN_B_URL);

  // ⚠️ 絕對不能用 (await provA.getNetwork()).chainId
  // Hardhat 兩條鏈都回傳 31337 → 合約 "Cannot peer with self" 報錯
  // 改用邏輯 ID（port 號），兩條鏈永遠不同
  const netIdA = "8545";
  const netIdB = "8546";
  console.log(`[Deploy] Chain A logicalId: ${netIdA}`);
  console.log(`[Deploy] Chain B logicalId: ${netIdB}`);

  const signerA     = await provA.getSigner();
  const signerB     = await provB.getSigner();
  const oracleAddrA = await signerA.getAddress();
  const oracleAddrB = await signerB.getAddress();

  const resultA = await deployBridgeNode(CHAIN_A_URL, netIdA, oracleAddrA);
  const resultB = await deployBridgeNode(CHAIN_B_URL, netIdB, oracleAddrB);

  console.log("\n[Deploy] Setting peer nodes...");
  const contractA = new ethers.Contract(resultA.address, resultA.abi, resultA.signer);
  const contractB = new ethers.Contract(resultB.address, resultB.abi, resultB.signer);

  await (await contractA.setPeerNode(netIdB, resultB.address)).wait();
  console.log(`[Deploy] Chain A knows Chain B: ${resultB.address}`);

  await (await contractB.setPeerNode(netIdA, resultA.address)).wait();
  console.log(`[Deploy] Chain B knows Chain A: ${resultA.address}`);

  for (const { signer, address, label, prov } of [
    { signer: resultA.signer, address: resultA.address, label: "Chain A", prov: provA },
    { signer: resultB.signer, address: resultB.address, label: "Chain B", prov: provB },
  ]) {
    console.log(`\n[Deploy] Funding BridgeNode (${label}) with 100 ETH...`);
    const tx = await signer.sendTransaction({ to: address, value: ethers.parseEther("100") });
    await tx.wait();
    const bal = await prov.getBalance(address);
    console.log(`[Deploy] ${label} BridgeNode balance: ${ethers.formatEther(bal)} ETH`);
  }

  function buildArtifact(abi, bytecode, networkId, address, txHash) {
    return { contractName: "BridgeNode", abi, bytecode, networks: { [networkId]: { address, transactionHash: txHash } } };
  }

  fs.writeFileSync(
    path.join(BUILD_A, "BridgeNode.json"),
    JSON.stringify(buildArtifact(resultA.abi, resultA.bytecode, netIdA, resultA.address, resultA.txHash), null, 2)
  );
  fs.writeFileSync(
    path.join(BUILD_B, "BridgeNode.json"),
    JSON.stringify(buildArtifact(resultB.abi, resultB.bytecode, netIdB, resultB.address, resultB.txHash), null, 2)
  );

  console.log("\n==========================================");
  console.log(" AO4C Deployment Complete!");
  console.log(` BridgeNode (Chain A): ${resultA.address}`);
  console.log(` BridgeNode (Chain B): ${resultB.address}`);
  console.log(` Peers configured: ✓`);
  console.log("==========================================\n");
}

main().catch(err => { console.error("[Deploy] Error:", err.message); process.exit(1); });
```

---

## Step 5：Oracle 中繼層

### oracle/.env

```
CHAIN_A_URL=http://127.0.0.1:8545
CHAIN_B_URL=http://127.0.0.1:8546
```

### oracle/occExecutor.js

```javascript
/**
 * occExecutor.js — OCC 批次執行器（輕量版）
 *
 * Oracle 層只負責：
 *  1. 收集 OrderRevealed 事件
 *  2. 在批次視窗結束後，帶有序序列呼叫 AI Agent
 *  3. 把 AI 結果帶回合約執行
 *
 * 排序邏輯已在合約層完成（seqNo），此處只按 seqNo 排列後送 AI。
 */
const { askClaudeConflict } = require("./aiConflictAgent");
const fs   = require("fs");
const path = require("path");

const BATCH_WINDOW_MS = 1500; // 等待同輪 reveal 全部到齊（Hardhat 逐筆出塊約需 500~1000ms）
const AI_LOG = path.join(__dirname, "../logs/ai-decisions.jsonl");

function writeAiLog(entry) {
  try {
    fs.appendFileSync(AI_LOG, JSON.stringify(entry) + "\n");
  } catch (_) {}
}

class OccExecutor {
  constructor() {
    this.pendingBatch = [];
    this.batchTimer   = null;
    this.onCommit     = null; // async (tx) => void
    this.onAbort      = null; // async (tx, note) => void
  }

  submit(tx) {
    this.pendingBatch.push({ ...tx, submittedAt: Date.now() });
    console.log(`[OCC] submit seqNo=${tx.seqNo} dir=${tx.srcChainId}→${tx.targetChainId}`);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => this._runValidation(), BATCH_WINDOW_MS);
  }

  async _runValidation() {
    if (this.pendingBatch.length === 0) return;
    const batch = this.pendingBatch.slice().sort((a, b) => Number(a.seqNo) - Number(b.seqNo));
    this.pendingBatch = [];
    this.batchTimer   = null;

    console.log(`[OCC] === Validation Phase: ${batch.length} tx(s) ===`);

    const batchStartTime = Date.now();
    writeAiLog({
      type: "batch_start",
      time: batchStartTime,
      size: batch.length,
      seqNos: batch.map(t => Number(t.seqNo)),
    });

    let commits = batch.map(t => t.requestId);
    let aborts  = {};
    let aiInvoked = false;
    let aiError   = null;

    if (batch.length > 1) {
      aiInvoked = true;
      try {
        // 送給 AI Agent 的序列已按 seqNo 排好（合約層確定性排序）
        const result = await askClaudeConflict(batch);
        commits = result.commits;
        result.aborts.forEach(a => { aborts[a.requestId] = a.note; });

        writeAiLog({
          type:       "ai_result",
          time:       Date.now(),
          elapsed_ms: Date.now() - batchStartTime,
          batch_size: batch.length,
          commits:    result.commits.length,
          aborts:     result.aborts.length,
          abort_details: result.aborts.map(a => ({ seqNo: batch.find(t => t.requestId === a.requestId)?.seqNo, note: a.note })),
        });
      } catch (err) {
        aiError = err.message;
        console.error("[OCC] AI Agent error:", err.message);
        writeAiLog({
          type:       "ai_error",
          time:       Date.now(),
          elapsed_ms: Date.now() - batchStartTime,
          batch_size: batch.length,
          error:      err.message.slice(0, 200),
        });
        // AI 失敗時保守處理：全部 commit（OCC 版本驗證作為最後防線）
      }
    } else {
      // 單筆交易不需 AI 判斷
      writeAiLog({
        type:       "single_tx_skip",
        time:       Date.now(),
        seqNo:      Number(batch[0].seqNo),
      });
    }

    for (const tx of batch) {
      if (aborts[tx.requestId]) {
        console.log(`[OCC] ABORT seqNo=${tx.seqNo} | ${aborts[tx.requestId]}`);
        if (this.onAbort) await this.onAbort(tx, aborts[tx.requestId]).catch(e => console.error("[OCC] abort error:", e.message));
      } else {
        console.log(`[OCC] COMMIT seqNo=${tx.seqNo}`);
        if (this.onCommit) await this.onCommit(tx).catch(e => console.error("[OCC] commit error:", e.message));
      }
    }

    console.log(`[OCC] === Validation Phase complete ===`);
  }
}

module.exports = OccExecutor;
```

### oracle/aiConflictAgent.js

```javascript
/**
 * aiConflictAgent.js — Claude Code CLI AI 衝突驗證 Agent
 *
 * 接收已按 seqNo 排好序的交易批次（排序由合約層確定性決定）
 * 判斷在此順序下哪些交易有語意衝突
 * 回傳 { commits: [requestId,...], aborts: [{requestId, note},...] }
 *
 * 前提：
 *   npm install -g @anthropic-ai/claude-code
 *   claude  （完成登入）
 */
const { execFile }  = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 60000;

async function askClaudeConflict(orderedBatch) {
  const prompt = buildPrompt(orderedBatch);

  let stdout;
  try {
    const result = await execFileAsync(
      "claude",
      ["--output-format", "json", "-p", prompt],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 512 }
    );
    stdout = result.stdout;
  } catch (err) {
    throw new Error(`claude CLI failed: ${err.message}`);
  }

  return parseResponse(stdout, orderedBatch);
}

function buildPrompt(orderedBatch) {
  const batchSummary = orderedBatch.map(t => ({
    requestId:   t.requestId,
    seqNo:       t.seqNo.toString(),
    sender:      t.sender,
    recipient:   t.recipient,
    amount:      t.amount.toString(),
    readVersion: t.readVersion.toString(),
    direction:   `chain${t.srcChainId}→chain${t.targetChainId}`,
  }));

  return `You are a conflict validator for AO4C (AI-Augmented Optimistic Cross-Chain Concurrency Control).

The following transactions have been ORDERED by seqNo (determined by on-chain deterministic ordering, not miner ordering).
Analyze each transaction in sequence order and identify conflicts.

A CONFLICT exists if ANY of these conditions are true:
1. DOUBLE SPEND: Same sender submitting multiple transactions within the same readVersion window targeting the same or different recipients
2. DUPLICATE RELEASE: Same requestId appearing more than once
3. VERSION CONFLICT: A transaction's readVersion is stale relative to earlier transactions in this batch that would modify shared state
4. SEMANTIC CONFLICT: Transactions that together would violate cross-chain consistency (e.g., bidirectional transfers that create circular value flow exploits)

ORDERED transaction batch (process in seqNo order):
${JSON.stringify(batchSummary, null, 2)}

Respond ONLY with a JSON object. No explanation, no markdown, no extra text:
{
  "commits": ["requestId1", "requestId3"],
  "aborts": [
    { "requestId": "requestId2", "note": "<reason max 100 chars>" }
  ]
}

Rules:
- Every requestId must appear in exactly one of commits or aborts
- When a conflict involves two transactions, abort the LATER seqNo one (preserve earlier)
- If uncertain, commit (the on-chain version check is the final safeguard)`;
}

function parseResponse(stdout, orderedBatch) {
  const allIds = orderedBatch.map(t => t.requestId);

  let outerJson;
  try { outerJson = JSON.parse(stdout.trim()); } catch { return fallbackCommitAll(allIds); }

  const resultText = outerJson.result || outerJson.content || stdout;
  const cleaned    = resultText.replace(/```json|```/g, "").trim();

  let inner;
  try { inner = JSON.parse(cleaned); } catch { return fallbackCommitAll(allIds); }

  const commits = Array.isArray(inner.commits) ? inner.commits : [];
  const aborts  = Array.isArray(inner.aborts)  ? inner.aborts  : [];
  const mentioned = new Set([...commits, ...aborts.map(a => a.requestId)]);

  allIds.forEach(id => { if (!mentioned.has(id)) commits.push(id); });

  return { commits, aborts };
}

function fallbackCommitAll(allIds) {
  return { commits: allIds, aborts: [] };
}

module.exports = { askClaudeConflict };
```

### oracle/oracle.js

> **關鍵**：邏輯 ID 與 deploy.js 一致，hardcode `"8545"` / `"8546"`，不讀 `eth_chainId`。

```javascript
require("dotenv").config({ path: __dirname + "/.env" });
const { Web3 }    = require("web3");
const OccExecutor = require("./occExecutor");
const fs   = require("fs");
const path = require("path");

const CHAIN_A_URL = process.env.CHAIN_A_URL || "http://127.0.0.1:8545";
const CHAIN_B_URL = process.env.CHAIN_B_URL || "http://127.0.0.1:8546";
const WS_A        = CHAIN_A_URL.replace("http://", "ws://").replace("https://", "wss://");
const WS_B        = CHAIN_B_URL.replace("http://", "ws://").replace("https://", "wss://");

const webA = new Web3(new Web3.providers.WebsocketProvider(WS_A));
const webB = new Web3(new Web3.providers.WebsocketProvider(WS_B));

function loadContract(buildPath, web3Instance) {
  const artifact   = JSON.parse(fs.readFileSync(buildPath, "utf8"));
  const networkIds = Object.keys(artifact.networks);
  if (!networkIds.length) throw new Error(`No deployed network in ${buildPath}`);
  const address = artifact.networks[networkIds[networkIds.length - 1]].address;
  return { contract: new web3Instance.eth.Contract(artifact.abi, address), address };
}

let nodeA, nodeB, oracleA, oracleB;
const occ = new OccExecutor();

async function init() {
  console.log("[Oracle] Initializing AO4C Oracle (bidirectional)...");

  const loadA = loadContract(path.join(__dirname, "../build/chainA/BridgeNode.json"), webA);
  const loadB = loadContract(path.join(__dirname, "../build/chainB/BridgeNode.json"), webB);
  nodeA = loadA.contract;
  nodeB = loadB.contract;

  const accsA = await webA.eth.getAccounts();
  const accsB = await webB.eth.getAccounts();
  oracleA = accsA[0];
  oracleB = accsB[0];
  console.log(`[Oracle] Oracle A: ${oracleA}`);
  console.log(`[Oracle] Oracle B: ${oracleB}`);

  occ.onCommit = async (tx) => { await executeCommit(tx); };
  occ.onAbort  = async (tx, note) => { await executeAbort(tx, note); };

  // ⚠️ 不讀 eth_chainId（Hardhat 兩條鏈都回傳 31337）
  // 使用邏輯 ID，與 deploy.js 保持一致
  const netIdA = "8545";
  const netIdB = "8546";
  console.log(`[Oracle] Chain A logicalId: ${netIdA}, Chain B logicalId: ${netIdB}`);

  // Web3 v4：事件訂閱必須加 await
  const subA = await nodeA.events.OrderRevealed({ fromBlock: "latest" });
  subA.on("data", (event) => {
    const { requestId, sender, amount, recipient, targetChainId, seqNo, readVersion } = event.returnValues;
    console.log(`[Oracle] A→B OrderRevealed | seqNo=${seqNo} sender=${sender.slice(0,8)}...`);
    occ.submit({
      requestId, sender, amount, recipient, targetChainId, seqNo, readVersion,
      srcChainId: netIdA, srcNode: nodeA, dstNode: nodeB,
      oracleAccount: oracleA, oracleAccountDst: oracleB,
      webSrc: webA, webDst: webB,
      srcNetId: netIdA, dstNetId: netIdB,
    });
  });
  subA.on("error", err => console.error("[Oracle] Chain A event error:", err.message));

  const subB = await nodeB.events.OrderRevealed({ fromBlock: "latest" });
  subB.on("data", (event) => {
    const { requestId, sender, amount, recipient, targetChainId, seqNo, readVersion } = event.returnValues;
    console.log(`[Oracle] B→A OrderRevealed | seqNo=${seqNo} sender=${sender.slice(0,8)}...`);
    occ.submit({
      requestId, sender, amount, recipient, targetChainId, seqNo, readVersion,
      srcChainId: netIdB, srcNode: nodeB, dstNode: nodeA,
      oracleAccount: oracleB, oracleAccountDst: oracleA,
      webSrc: webB, webDst: webA,
      srcNetId: netIdB, dstNetId: netIdA,
    });
  });
  subB.on("error", err => console.error("[Oracle] Chain B event error:", err.message));

  console.log("[Oracle] Listening on both chains (AO4C bidirectional mode)...");
  console.log(`[Oracle] Chain A WS: ${WS_A}`);
  console.log(`[Oracle] Chain B WS: ${WS_B}`);
  console.log("[Oracle] AI Agent: Claude Code CLI");
}

async function executeCommit(tx) {
  const { requestId, amount, recipient, srcNode, dstNode,
          oracleAccount, oracleAccountDst, readVersion, srcNetId } = tx;

  console.log(`[Oracle] COMMIT seqNo=${tx.seqNo} ${tx.srcChainId}→${tx.targetChainId}`);

  try {
    const gas1 = await srcNode.methods
      .validateAndExecute(requestId, false, "no conflict", readVersion)
      .estimateGas({ from: oracleAccount });
    await srcNode.methods
      .validateAndExecute(requestId, false, "no conflict", readVersion)
      .send({ from: oracleAccount, gas: Math.ceil(Number(gas1) * 1.2) });

    const gas2 = await dstNode.methods
      .executeTransfer(requestId, recipient, amount, srcNetId)
      .estimateGas({ from: oracleAccountDst });
    const txResult = await dstNode.methods
      .executeTransfer(requestId, recipient, amount, srcNetId)
      .send({ from: oracleAccountDst, gas: Math.ceil(Number(gas2) * 1.2) });

    console.log(`[Oracle] Committed | txHash=${txResult.transactionHash}`);
  } catch (err) {
    console.error(`[Oracle] Commit failed seqNo=${tx.seqNo}:`, err.message);
    throw err;
  }
}

async function executeAbort(tx, note) {
  const { requestId, srcNode, oracleAccount, readVersion } = tx;
  console.log(`[Oracle] ABORT seqNo=${tx.seqNo} reason=${note}`);

  try {
    const gas = await srcNode.methods
      .validateAndExecute(requestId, true, note, readVersion)
      .estimateGas({ from: oracleAccount });
    const txResult = await srcNode.methods
      .validateAndExecute(requestId, true, note, readVersion)
      .send({ from: oracleAccount, gas: Math.ceil(Number(gas) * 1.2) });

    console.log(`[Oracle] Aborted+Refunded | txHash=${txResult.transactionHash}`);
  } catch (err) {
    console.error(`[Oracle] Abort failed seqNo=${tx.seqNo}:`, err.message);
    throw err;
  }
}

init().catch(console.error);
```

---

## Step 6：使用者介面

### ui/server.js

```javascript
const express = require("express");
const path    = require("path");
const http    = require("http");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use("/build", express.static(path.join(__dirname, "../build")));

app.get("/web3.min.js", (req, res) => {
  res.sendFile(path.join(__dirname, "../node_modules/web3/dist/web3.min.js"));
});

function rpcProxy(targetPort) {
  return (req, res) => {
    const body    = JSON.stringify(req.body);
    const options = {
      hostname: "127.0.0.1", port: targetPort, path: "/", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode).set("Content-Type", "application/json");
      proxyRes.pipe(res);
    });
    proxyReq.on("error", err => res.status(502).json({ error: err.message }));
    proxyReq.write(body);
    proxyReq.end();
  };
}

app.post("/rpc/chainA", rpcProxy(8545));
app.post("/rpc/chainB", rpcProxy(8546));

app.listen(3000, () => {
  console.log("[UI] Server running at http://localhost:3000");
  console.log("[UI] RPC proxy: /rpc/chainA → :8545 | /rpc/chainB → :8546");
});
```

### ui/index.html

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AO4C Cross-Chain Lab</title>
  <script src="/web3.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    header { background: linear-gradient(135deg, #1e40af, #7c3aed); padding: 20px 40px; }
    header h1 { font-size: 1.6rem; font-weight: 700; }
    header .subtitle { font-size: 0.85rem; opacity: 0.8; margin-top: 4px; }
    .container { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 28px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
    .card h2 { font-size: 1rem; font-weight: 600; color: #94a3b8; margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.05em; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; margin-left: 8px; }
    .badge-a { background: #1d4ed8; color: #bfdbfe; }
    .badge-b { background: #6d28d9; color: #ddd6fe; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 0.88rem; }
    .info-row .label { color: #64748b; }
    .info-row .value { font-family: monospace; color: #a5f3fc; word-break: break-all; max-width: 240px; text-align: right; }
    .info-row .balance { color: #34d399; font-weight: 600; }
    .form-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin-bottom: 28px; }
    .form-card h2 { font-size: 1rem; font-weight: 600; color: #94a3b8; margin-bottom: 18px; text-transform: uppercase; letter-spacing: 0.05em; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    .form-row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    label { display: block; font-size: 0.82rem; color: #94a3b8; margin-bottom: 6px; }
    input, select { width: 100%; padding: 10px 14px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 0.9rem; outline: none; transition: border-color 0.2s; }
    input:focus, select:focus { border-color: #3b82f6; }
    .btn { padding: 12px 28px; border: none; border-radius: 8px; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(135deg, #2563eb, #7c3aed); color: white; }
    .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .btn-secondary { background: #334155; color: #94a3b8; margin-left: 12px; }
    .btn-secondary:hover { background: #475569; }
    .status-bar { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 0.88rem; display: flex; align-items: center; gap: 10px; }
    .status-idle    { background: #1e293b; border: 1px solid #334155; color: #64748b; }
    .status-pending { background: #1e3a5f; border: 1px solid #3b82f6; color: #93c5fd; }
    .status-success { background: #14532d; border: 1px solid #22c55e; color: #86efac; }
    .status-error   { background: #450a0a; border: 1px solid #ef4444; color: #fca5a5; }
    .status-abort   { background: #451a03; border: 1px solid #f97316; color: #fed7aa; }
    .spinner { width: 16px; height: 16px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th { background: #0f172a; padding: 10px 12px; text-align: left; color: #64748b; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; border-bottom: 1px solid #334155; }
    td { padding: 10px 12px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
    tr:hover td { background: #1e293b; }
    .pill { padding: 2px 8px; border-radius: 99px; font-size: 0.75rem; font-weight: 600; }
    .pill-success { background: #14532d; color: #86efac; }
    .pill-abort   { background: #451a03; color: #fed7aa; }
    .pill-pending { background: #1e3a5f; color: #93c5fd; }
    .pill-failed  { background: #450a0a; color: #fca5a5; }
    .hash { font-family: monospace; color: #a5f3fc; }
    .empty-state { text-align: center; padding: 40px; color: #475569; }
    .dir-badge { padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
    .dir-ab { background: #1d4ed8; color: #bfdbfe; }
    .dir-ba { background: #6d28d9; color: #ddd6fe; }
  </style>
</head>
<body>
  <header>
    <h1>AO4C Cross-Chain Lab</h1>
    <div class="subtitle">AI-Augmented Optimistic Cross-Chain Concurrency Control — 雙向跨鏈交易實驗環境</div>
  </header>
  <div class="container">
    <div class="grid2">
      <div class="card">
        <h2>Chain A <span class="badge badge-a">port 8545</span></h2>
        <div class="info-row"><span class="label">BridgeNode 地址</span><span class="value" id="addrA">載入中...</span></div>
        <div class="info-row"><span class="label">橋接餘額</span><span class="value balance" id="balA">—</span></div>
        <div class="info-row"><span class="label">globalVersion</span><span class="value" id="verA">—</span></div>
        <div class="info-row"><span class="label">nextSeqNo</span><span class="value" id="seqA">—</span></div>
        <div class="info-row"><span class="label">帳號餘額</span><span class="value balance" id="accBalA">—</span></div>
      </div>
      <div class="card">
        <h2>Chain B <span class="badge badge-b">port 8546</span></h2>
        <div class="info-row"><span class="label">BridgeNode 地址</span><span class="value" id="addrB">載入中...</span></div>
        <div class="info-row"><span class="label">橋接餘額</span><span class="value balance" id="balB">—</span></div>
        <div class="info-row"><span class="label">globalVersion</span><span class="value" id="verB">—</span></div>
        <div class="info-row"><span class="label">nextSeqNo</span><span class="value" id="seqB">—</span></div>
        <div class="info-row"><span class="label">帳號餘額</span><span class="value balance" id="accBalB">—</span></div>
      </div>
    </div>
    <div class="form-card">
      <h2>發送跨鏈交易（三階段 OCC）</h2>
      <div class="form-row-3">
        <div>
          <label>方向</label>
          <select id="directionSelect" onchange="updateSelects()">
            <option value="AB">Chain A → Chain B</option>
            <option value="BA">Chain B → Chain A</option>
          </select>
        </div>
        <div><label>發送帳號</label><select id="senderSelect"></select></div>
        <div><label>接收帳號</label><select id="recipientSelect"></select></div>
      </div>
      <div class="form-row">
        <div><label>金額 (ETH)</label><input type="number" id="amountInput" value="0.01" min="0.001" step="0.001" /></div>
        <div style="display:flex; align-items:flex-end; gap:12px;">
          <button class="btn btn-primary" id="sendBtn" onclick="sendTx()">Phase 1: Commit</button>
          <button class="btn btn-secondary" onclick="refreshAll()">刷新</button>
        </div>
      </div>
      <div class="status-bar status-idle" id="statusBar">
        <span id="statusText">就緒，等待操作... (Phase 1 Commit → Phase 2 Reveal 自動執行)</span>
      </div>
    </div>
    <div class="card">
      <h2>交易記錄 <button class="btn btn-secondary" style="float:right;padding:6px 14px;font-size:0.8rem;" onclick="renderTable()">刷新</button></h2>
      <div style="overflow-x:auto; margin-top:16px;">
        <table>
          <thead>
            <tr><th>#</th><th>方向</th><th>SeqNo</th><th>狀態</th><th>發送</th><th>接收</th><th>金額</th><th>TxHash</th><th>時間</th></tr>
          </thead>
          <tbody id="txTableBody">
            <tr><td colspan="9" class="empty-state">尚無交易記錄</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>
```

### ui/app.js

> **關鍵**：`dstChainId` 用邏輯 ID，不讀 `eth_chainId`。

```javascript
let web3A, web3B;
let nodeAContract, nodeBContract;
let accountsA = [], accountsB = [];
const txHistory = [];

async function init() {
  try {
    web3A = new Web3("http://localhost:3000/rpc/chainA");
    web3B = new Web3("http://localhost:3000/rpc/chainB");

    const [artA, artB] = await Promise.all([
      fetch("/build/chainA/BridgeNode.json").then(r => r.json()),
      fetch("/build/chainB/BridgeNode.json").then(r => r.json()),
    ]);

    const netIdsA = Object.keys(artA.networks);
    const netIdsB = Object.keys(artB.networks);
    if (!netIdsA.length || !netIdsB.length) throw new Error("合約尚未部署，請先執行 start-chains.sh");

    const addrA = artA.networks[netIdsA[netIdsA.length - 1]].address;
    const addrB = artB.networks[netIdsB[netIdsB.length - 1]].address;

    nodeAContract = new web3A.eth.Contract(artA.abi, addrA);
    nodeBContract = new web3B.eth.Contract(artB.abi, addrB);

    document.getElementById("addrA").textContent = addrA;
    document.getElementById("addrB").textContent = addrB;

    accountsA = await web3A.eth.getAccounts();
    accountsB = await web3B.eth.getAccounts();
    updateSelects();
    await refreshAll();
    setStatus("idle", "就緒，等待操作...");
  } catch (err) {
    setStatus("error", `初始化失敗：${err.message}`);
  }
}

function updateSelects() {
  const dir   = document.getElementById("directionSelect").value;
  const isAB  = dir === "AB";
  const sAccs = isAB ? accountsA : accountsB;
  const rAccs = isAB ? accountsB : accountsA;
  document.getElementById("senderSelect").innerHTML    = sAccs.map((a, i) => `<option value="${a}">account[${i}] ${a.slice(0,8)}...</option>`).join("");
  document.getElementById("recipientSelect").innerHTML = rAccs.map((a, i) => `<option value="${a}">account[${i}] ${a.slice(0,8)}...</option>`).join("");
}

async function refreshAll() {
  try {
    const [balA, balB, verA, verB, seqA, seqB, accBalA, accBalB] = await Promise.all([
      nodeAContract.methods.getBalance().call(),
      nodeBContract.methods.getBalance().call(),
      nodeAContract.methods.globalVersion().call(),
      nodeBContract.methods.globalVersion().call(),
      nodeAContract.methods.nextSeqNo().call(),
      nodeBContract.methods.nextSeqNo().call(),
      accountsA.length ? web3A.eth.getBalance(accountsA[0]) : Promise.resolve("0"),
      accountsB.length ? web3B.eth.getBalance(accountsB[0]) : Promise.resolve("0"),
    ]);
    const fmt = (w, w3) => parseFloat(w3.utils.fromWei(w.toString(), "ether")).toFixed(4) + " ETH";
    document.getElementById("balA").textContent    = fmt(balA, web3A);
    document.getElementById("balB").textContent    = fmt(balB, web3B);
    document.getElementById("verA").textContent    = verA.toString();
    document.getElementById("verB").textContent    = verB.toString();
    document.getElementById("seqA").textContent    = seqA.toString();
    document.getElementById("seqB").textContent    = seqB.toString();
    document.getElementById("accBalA").textContent = fmt(accBalA, web3A);
    document.getElementById("accBalB").textContent = fmt(accBalB, web3B);
  } catch (err) {
    console.error("[UI] refresh error:", err.message);
  }
}

async function sendTx() {
  const dir       = document.getElementById("directionSelect").value;
  const sender    = document.getElementById("senderSelect").value;
  const recipient = document.getElementById("recipientSelect").value;
  const amountEth = document.getElementById("amountInput").value;
  if (!sender || !recipient || !amountEth) { setStatus("error", "請填寫所有欄位"); return; }

  const isAB        = dir === "AB";
  const srcWeb3     = isAB ? web3A : web3B;
  const srcContract = isAB ? nodeAContract : nodeBContract;

  // ⚠️ 不讀 eth_chainId，使用邏輯 ID
  const dstChainId = isAB ? "8546" : "8545";

  const btn = document.getElementById("sendBtn");
  btn.disabled = true;

  const amount = srcWeb3.utils.toWei(amountEth, "ether");
  const salt   = srcWeb3.utils.randomHex(32);
  const blindedAmount = srcWeb3.utils.soliditySha3(
    { type: "uint256", value: amount },
    { type: "bytes32", value: salt }
  );

  const t0 = Date.now();
  try {
    setStatus("pending", '<span class="spinner"></span> Phase 1: 送出 Commit（隱藏金額）...');
    const tx1 = await srcContract.methods
      .commitOrder(blindedAmount, recipient, dstChainId)
      .send({ from: sender, value: amount, gas: 200000 });

    const requestId = tx1.events?.OrderCommitted?.returnValues?.requestId;
    setStatus("pending", `<span class="spinner"></span> Phase 2: Reveal 金額（requestId: ${requestId?.slice(0,10)}...）`);

    const tx2 = await srcContract.methods
      .revealOrder(requestId, amount, salt)
      .send({ from: sender, gas: 200000 });

    const seqNo   = tx2.events?.OrderRevealed?.returnValues?.seqNo;
    const latency = Date.now() - t0;

    txHistory.unshift({
      index: txHistory.length + 1, dir,
      seqNo: seqNo?.toString() || "—", status: "pending",
      sender, recipient, amount: amountEth,
      txHash: tx2.transactionHash,
      timestamp: new Date().toLocaleString("zh-TW"),
      latency, requestId,
    });

    setStatus("success", `Phase 1+2 完成！SeqNo=${seqNo} | 等待 Oracle Phase 3 驗證...`);
    renderTable();
    watchPhase3(requestId, isAB, seqNo);
    await refreshAll();
  } catch (err) {
    txHistory.unshift({
      index: txHistory.length + 1, dir, seqNo: "—", status: "failed",
      sender, recipient, amount: amountEth, txHash: "—",
      timestamp: new Date().toLocaleString("zh-TW"), latency: Date.now() - t0,
    });
    setStatus("error", `交易失敗：${err.message.slice(0, 120)}`);
    renderTable();
  } finally {
    btn.disabled = false;
  }
}

function watchPhase3(requestId, isAB, seqNo) {
  const srcContract = isAB ? nodeAContract : nodeBContract;
  const checkInterval = setInterval(async () => {
    try {
      const rec = await srcContract.methods.getRecord(requestId).call();
      const entry = txHistory.find(t => t.requestId === requestId);
      if (!entry) { clearInterval(checkInterval); return; }
      if (rec.executed) {
        entry.status = "success";
        setStatus("success", `Phase 3 完成！SeqNo=${seqNo} 交易已 Commit`);
        renderTable(); refreshAll(); clearInterval(checkInterval);
      } else if (rec.aborted) {
        entry.status = "abort";
        setStatus("abort", `Phase 3：SeqNo=${seqNo} 被 Abort`);
        renderTable(); refreshAll(); clearInterval(checkInterval);
      }
    } catch (_) {}
  }, 1000);
  setTimeout(() => clearInterval(checkInterval), 60000);
}

function renderTable() {
  const tbody = document.getElementById("txTableBody");
  if (!txHistory.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-state">尚無交易記錄</td></tr>'; return; }
  tbody.innerHTML = txHistory.map(r => `
    <tr>
      <td>${r.index}</td>
      <td><span class="dir-badge dir-${r.dir.toLowerCase()}">${r.dir === "AB" ? "A→B" : "B→A"}</span></td>
      <td>${r.seqNo}</td>
      <td><span class="pill pill-${r.status}">${r.status}</span></td>
      <td class="hash">${r.sender.slice(0,8)}...</td>
      <td class="hash">${r.recipient.slice(0,8)}...</td>
      <td>${r.amount} ETH</td>
      <td class="hash">${r.txHash !== "—" ? r.txHash.slice(0,16) + "..." : "—"}</td>
      <td>${r.timestamp}</td>
    </tr>
  `).join("");
}

function setStatus(type, html) {
  document.getElementById("statusBar").className = `status-bar status-${type}`;
  document.getElementById("statusText").innerHTML = html;
}

window.addEventListener("DOMContentLoaded", init);
```

---

## Step 7：Shell 腳本

### scripts/start-chains.sh

```bash
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
```

### scripts/start-ui.sh

```bash
#!/bin/bash
set -e
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
[ ! -f "build/chainA/BridgeNode.json" ] && echo "ERROR: Run start-chains.sh first." && exit 1
echo "[UI] Starting at http://localhost:3000"
node ui/server.js
```

### scripts/auto-stress-test.sh

```bash
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
```

### scripts/monitor.sh

```bash
#!/bin/bash
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
[ ! -f "build/chainA/BridgeNode.json" ] && echo "ERROR: Run start-chains.sh first." && exit 1
node scripts/monitor.js
```

### scripts/status.sh

```bash
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
```

---

## Step 8：壓力測試

### stress-test/sender.js

> **關鍵**：`chainIdA` / `chainIdB` 用邏輯 ID，不讀 `eth_chainId`。

```javascript
require("dotenv").config({ path: __dirname + "/../oracle/.env" });
const { Web3 }        = require("web3");
const pLimit          = require("p-limit");
const ReportGenerator = require("./report-generator");
const fs              = require("fs");
const path            = require("path");

const CHAIN_A_URL = process.env.CHAIN_A_URL || "http://127.0.0.1:8545";
const CHAIN_B_URL = process.env.CHAIN_B_URL || "http://127.0.0.1:8546";

const args        = parseArgs(process.argv.slice(2));
const DURATION    = parseInt(args.duration    || "60")    * 1000;
const CONCURRENCY = parseInt(args.concurrency || "5");
const AMOUNT_ETH  = args.amount     || "0.001";
const REPORT_DIR  = args["report-dir"] || "./reports";

async function main() {
  const webA = new Web3(CHAIN_A_URL);
  const webB = new Web3(CHAIN_B_URL);

  const artA = JSON.parse(fs.readFileSync(path.join(__dirname, "../build/chainA/BridgeNode.json")));
  const artB = JSON.parse(fs.readFileSync(path.join(__dirname, "../build/chainB/BridgeNode.json")));
  const addrA = artA.networks[Object.keys(artA.networks).pop()].address;
  const addrB = artB.networks[Object.keys(artB.networks).pop()].address;
  const nodeA = new webA.eth.Contract(artA.abi, addrA);
  const nodeB = new webB.eth.Contract(artB.abi, addrB);

  const accsA = await webA.eth.getAccounts();
  const accsB = await webB.eth.getAccounts();

  // ⚠️ 不讀 eth_chainId，使用邏輯 ID
  const chainIdA = "8545";
  const chainIdB = "8546";

  const limit     = pLimit(CONCURRENCY);
  const startTime = Date.now();
  const results   = [];
  let   txCount = 0, successCount = 0, failCount = 0;

  console.log(`[Stress] AO4C Bidirectional OCC | concurrency=${CONCURRENCY} duration=${DURATION/1000}s amount=${AMOUNT_ETH}ETH`);

  const pendingTasks = [];

  while (Date.now() - startTime < DURATION) {
    const idx    = txCount++;
    const isAB   = Math.random() > 0.5;
    const srcWeb3 = isAB ? webA : webB;
    const srcNode = isAB ? nodeA : nodeB;
    const sender  = isAB ? accsA[idx % accsA.length] : accsB[idx % accsB.length];
    const recipient   = isAB ? accsB[0] : accsA[0];
    const dstChainId  = isAB ? chainIdB : chainIdA;
    const direction   = isAB ? "A→B" : "B→A";

    const task = limit(async () => {
      const t0     = Date.now();
      const amount = srcWeb3.utils.toWei(AMOUNT_ETH, "ether");
      const salt   = srcWeb3.utils.randomHex(32);
      const blindedAmount = srcWeb3.utils.soliditySha3(
        { type: "uint256", value: amount },
        { type: "bytes32", value: salt }
      );

      // 隨機 gasPrice（1~100 Gwei）：模擬礦工依 gas 排序的 TOD 場景
      // seqNo 應與 gasPrice 無關，以驗證 AO4C 的 TOD 防護能力
      const gasGwei    = Math.floor(Math.random() * 100) + 1;
      const gasPrice   = srcWeb3.utils.toWei(gasGwei.toString(), "gwei");

      try {
        // Phase 1
        const tx1 = await srcNode.methods
          .commitOrder(blindedAmount, recipient, dstChainId)
          .send({ from: sender, value: amount, gas: 200000, gasPrice });
        const requestId = tx1.events?.OrderCommitted?.returnValues?.requestId;

        // Phase 2
        const tx2 = await srcNode.methods
          .revealOrder(requestId, amount, salt)
          .send({ from: sender, gas: 200000, gasPrice });
        const seqNo = tx2.events?.OrderRevealed?.returnValues?.seqNo;

        const latency = Date.now() - t0;
        successCount++;
        results.push({ index: idx, direction, status: "revealed", seqNo: seqNo?.toString(), txHash: tx2.transactionHash, sender, recipient, amount: AMOUNT_ETH, latency, gasGwei, timestamp: new Date(t0).toISOString() });

        if (idx % 20 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const tps = (successCount / parseFloat(elapsed)).toFixed(2);
          console.log(`[Stress] tx=${String(idx).padStart(4)} revealed=${String(successCount).padStart(4)} fail=${String(failCount).padStart(3)} elapsed=${elapsed}s tps=${tps} gas=${gasGwei}Gwei`);
        }
      } catch (err) {
        failCount++;
        results.push({ index: idx, direction, status: "failed", error: err.message.slice(0, 200), sender, recipient, amount: AMOUNT_ETH, latency: Date.now() - t0, gasGwei, timestamp: new Date(t0).toISOString() });
      }
    });

    pendingTasks.push(task);
    if (pendingTasks.length >= CONCURRENCY * 5) await Promise.allSettled(pendingTasks.splice(0, CONCURRENCY));
    if (txCount % CONCURRENCY === 0) await new Promise(r => setTimeout(r, 50));
  }

  await Promise.allSettled(pendingTasks);
  const totalMs = Date.now() - startTime;
  const tps     = (successCount / (totalMs / 1000)).toFixed(3);

  console.log("\n========== AO4C Stress Test Summary ==========");
  console.log(`Total Sent   : ${txCount}`);
  console.log(`Phase1+2 OK  : ${successCount}`);
  console.log(`Failed       : ${failCount}`);
  console.log(`Duration     : ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`Throughput   : ${tps} TPS (Phase1+2)`);
  console.log("==============================================\n");

  const generator = new ReportGenerator();
  await generator.generate(results, {
    totalTx: txCount, success: successCount, fail: failCount, occAbort: 0,
    durationMs: totalMs, tps: parseFloat(tps),
    concurrency: CONCURRENCY, amountEth: AMOUNT_ETH, reportDir: REPORT_DIR,
  });

  process.exit(0);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

main().catch(err => { console.error("[Stress] Fatal:", err.message); process.exit(1); });
```

### stress-test/report-generator.js

```javascript
const ExcelJS = require("exceljs");
const dayjs   = require("dayjs");
const path    = require("path");
const fs      = require("fs");

class ReportGenerator {
  async generate(results, summary) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "AO4C CrossChain Lab";
    workbook.created = new Date();

    const s1 = workbook.addWorksheet("摘要 Summary");
    s1.columns = [{ header: "項目", key: "key", width: 35 }, { header: "數值", key: "value", width: 30 }];
    s1.addRows([
      { key: "演算法",                     value: "AO4C (AI-Augmented OCC)" },
      { key: "測試開始時間",               value: dayjs().format("YYYY-MM-DD HH:mm:ss") },
      { key: "測試持續時間 (秒)",          value: (summary.durationMs / 1000).toFixed(2) },
      { key: "最大併發數",                 value: summary.concurrency },
      { key: "每筆交易金額 (ETH)",         value: summary.amountEth },
      { key: "總發送交易數",               value: summary.totalTx },
      { key: "Phase1+2 成功數",            value: summary.success },
      { key: "失敗數",                     value: summary.fail },
      { key: "OCC Abort 數（AI判定衝突）", value: summary.occAbort || 0 },
      { key: "Phase1+2 成功率 (%)",        value: ((summary.success / summary.totalTx) * 100).toFixed(2) },
      { key: "平均吞吐量 TPS (Phase1+2)",  value: summary.tps },
      { key: "平均延遲 (ms)",              value: this._avg(results) },
      { key: "P50 延遲 (ms)",              value: this._pct(results, 50) },
      { key: "P95 延遲 (ms)",              value: this._pct(results, 95) },
      { key: "P99 延遲 (ms)",              value: this._pct(results, 99) },
    ]);
    this._styleHeader(s1);

    const s2 = workbook.addWorksheet("交易明細 Detail");
    s2.columns = [
      { header: "#",           key: "index",     width: 8  },
      { header: "方向",        key: "direction", width: 8  },
      { header: "SeqNo",       key: "seqNo",     width: 10 },
      { header: "時間戳",      key: "timestamp", width: 26 },
      { header: "狀態",        key: "status",    width: 12 },
      { header: "Gas (Gwei)",  key: "gasGwei",   width: 14 },
      { header: "發送地址",    key: "sender",    width: 44 },
      { header: "接收地址",    key: "recipient", width: 44 },
      { header: "金額 ETH",    key: "amount",    width: 14 },
      { header: "延遲 ms",     key: "latency",   width: 12 },
      { header: "TxHash",      key: "txHash",    width: 68 },
      { header: "錯誤訊息",    key: "error",     width: 50 },
    ];
    results.forEach(r => s2.addRow(r));
    this._styleHeader(s2);
    s2.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const st = row.getCell("status").value;
      const color = st === "revealed" ? "FF90EE90" : st === "abort" ? "FFFFA500" : "FFFF6B6B";
      row.getCell("status").fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    });

    const s3 = workbook.addWorksheet("每秒 TPS");
    s3.columns = [
      { header: "經過秒數", key: "second", width: 12 },
      { header: "時間戳",   key: "clock",  width: 12 },
      { header: "成功 TPS", key: "tps",    width: 14 },
      { header: "總交易",   key: "total",  width: 12 },
      { header: "失敗",     key: "failed", width: 10 },
    ];
    this._tpsBySecond(results).forEach(r => s3.addRow(r));
    this._styleHeader(s3);

    const s4 = workbook.addWorksheet("每分鐘 TPS（折線圖）");
    s4.columns = [
      { header: "經過分鐘",           key: "minute",       width: 12 },
      { header: "時間戳",             key: "clock",        width: 12 },
      { header: "成功交易數",         key: "success",      width: 14 },
      { header: "失敗交易數",         key: "failed",       width: 14 },
      { header: "總交易數",           key: "total",        width: 12 },
      { header: "平均 TPS（該分鐘）", key: "avgTps",       width: 18 },
      { header: "累計成功",           key: "cumSuccess",   width: 14 },
      { header: "累計總量",           key: "cumTotal",     width: 12 },
      { header: "累計 TPS",           key: "cumTps",       width: 12 },
      { header: "Gas 最小 (Gwei)",    key: "minGas",       width: 16 },
      { header: "Gas 最大 (Gwei)",    key: "maxGas",       width: 16 },
      { header: "Gas 平均 (Gwei)",    key: "avgGas",       width: 16 },
    ];
    this._tpsByMinute(results).forEach(r => s4.addRow(r));
    this._styleHeader(s4);
    s4.getRow(1).height = 22;
    const noteRow = s4.addRow({ minute: "※ 折線圖建議", clock: "選取「時間戳」+「平均TPS」欄位插入折線圖" });
    noteRow.font = { italic: true, color: { argb: "FF888888" } };

    const s5 = workbook.addWorksheet("方向統計 Direction");
    s5.columns = [
      { header: "方向",   key: "dir",   width: 10 },
      { header: "數量",   key: "count", width: 10 },
      { header: "成功",   key: "ok",    width: 10 },
      { header: "成功率", key: "rate",  width: 10 },
    ];
    const dirs = {};
    results.forEach(r => {
      if (!dirs[r.direction]) dirs[r.direction] = { count: 0, ok: 0 };
      dirs[r.direction].count++;
      if (r.status === "revealed") dirs[r.direction].ok++;
    });
    Object.entries(dirs).forEach(([dir, v]) => s5.addRow({
      dir, count: v.count, ok: v.ok,
      rate: ((v.ok / v.count) * 100).toFixed(2) + "%",
    }));
    this._styleHeader(s5);

    fs.mkdirSync(summary.reportDir, { recursive: true });
    const filename = `ao4c-report-${dayjs().format("YYYYMMDD-HHmmss")}.xlsx`;
    const filepath = path.join(summary.reportDir, filename);
    await workbook.xlsx.writeFile(filepath);
    console.log(`[Report] Excel saved: ${filepath}`);
    return filepath;
  }

  _avg(results) {
    const ok = results.filter(r => r.status === "revealed");
    return ok.length ? Math.round(ok.reduce((s, r) => s + r.latency, 0) / ok.length) : 0;
  }
  _pct(results, p) {
    const ok = results.filter(r => r.status === "revealed").map(r => r.latency).sort((a, b) => a - b);
    return ok.length ? ok[Math.max(0, Math.ceil((p / 100) * ok.length) - 1)] : 0;
  }
  _tpsBySecond(results) {
    if (!results.length) return [];
    const t0 = new Date(results[0].timestamp).getTime();
    const buckets = {};
    results.forEach(r => {
      const sec = Math.floor((new Date(r.timestamp).getTime() - t0) / 1000);
      if (!buckets[sec]) buckets[sec] = { total: 0, success: 0, failed: 0 };
      buckets[sec].total++;
      if (r.status === "revealed") buckets[sec].success++;
      else buckets[sec].failed++;
    });
    return Object.entries(buckets).sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([sec, v]) => ({ second: parseInt(sec), clock: this._secToHms(parseInt(sec)), tps: v.success, total: v.total, failed: v.failed }));
  }
  _tpsByMinute(results) {
    if (!results.length) return [];
    const t0 = new Date(results[0].timestamp).getTime();
    const buckets = {};
    results.forEach(r => {
      const min = Math.floor((new Date(r.timestamp).getTime() - t0) / 60000);
      if (!buckets[min]) buckets[min] = { total: 0, success: 0, failed: 0, gasValues: [] };
      buckets[min].total++;
      if (r.status === "revealed") buckets[min].success++;
      else buckets[min].failed++;
      if (r.gasGwei != null) buckets[min].gasValues.push(r.gasGwei);
    });

    let cumSuccess = 0, cumTotal = 0;
    return Object.entries(buckets).sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([min, v]) => {
        cumSuccess += v.success;
        cumTotal   += v.total;
        const elapsed = (parseInt(min) + 1) * 60;
        const gasVals = v.gasValues;
        const minGas  = gasVals.length ? Math.min(...gasVals) : "—";
        const maxGas  = gasVals.length ? Math.max(...gasVals) : "—";
        const avgGas  = gasVals.length ? (gasVals.reduce((s, g) => s + g, 0) / gasVals.length).toFixed(1) : "—";
        return {
          minute:     parseInt(min) + 1,
          clock:      `${String(parseInt(min)).padStart(2,"0")}:00`,
          success:    v.success,
          failed:     v.failed,
          total:      v.total,
          avgTps:     (v.success / 60).toFixed(3),
          cumSuccess,
          cumTotal,
          cumTps:     (cumSuccess / elapsed).toFixed(3),
          minGas,
          maxGas,
          avgGas,
        };
      });
  }
  _secToHms(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }
  _styleHeader(sheet) {
    sheet.getRow(1).eachCell(cell => {
      cell.font  = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F8A" } };
      cell.alignment = { horizontal: "center" };
    });
    sheet.getRow(1).height = 20;
  }
}

module.exports = ReportGenerator;
```

---

## Step 8b：TOD 實驗

### stress-test/tod-test.js

> **關鍵**：`dstChainId` 用邏輯 ID，不讀 `eth_chainId`。

```javascript
/**
 * tod-test.js — AO4C TOD（Transaction Ordering Dependence）實驗
 *
 * 實驗設計：
 *  1. 同時（Promise.all）送出 BATCH_SIZE 筆交易，gasPrice 各不相同（5~200 Gwei 隨機）
 *     → 模擬攻擊者試圖透過 gasPrice 操控礦工排序
 *  2. 記錄三個序號：
 *     - gasPrice  : 攻擊者期望的優先順序（高 gas = 期望先執行）
 *     - txIndex   : 礦工實際排序（在區塊內的位置）
 *     - seqNo     : AO4C 確定性排序（BridgeNode.revealOrder 賦予）
 *  3. 分析 txIndex 與 seqNo 的相關性
 *     - 若相關性低 → 礦工排序 ≠ AO4C 排序 → TOD 攻擊對 AO4C 無效
 *  4. 產出 Excel 報表，含三欄對比、Spearman 相關係數、TPS 吞吐量
 *
 * 使用方式：
 *  node stress-test/tod-test.js --batch 10 --duration 600 --direction AB
 *  node stress-test/tod-test.js --batch 10 --duration 600 --conflict-rate 0.3
 *
 * 參數說明：
 *  --batch N           每輪同時送出交易數（預設 10）
 *  --rounds N          輪數上限（與 --duration 二選一，預設 5）
 *  --duration N        持續秒數（例如 600 = 10 分鐘）
 *  --conflict-rate 0~1 每筆交易複用已出現 sender 的機率（預設 0.3）
 *                      0.0 = 全不衝突（每筆 sender 唯一）
 *                      0.3 = 約 30% 交易會觸發 double-spend 衝突（符合現實）
 *                      1.0 = 全部衝突（所有交易用同一個 sender）
 *  --amount ETH        每筆金額（預設 0.001）
 *  --direction         AB 或 BA（預設 AB）
 */
require("dotenv").config({ path: __dirname + "/../oracle/.env" });
const { Web3 }        = require("web3");
const TodReportGenerator = require("./tod-report-generator");
const fs              = require("fs");
const path            = require("path");

const CHAIN_A_URL = process.env.CHAIN_A_URL || "http://127.0.0.1:8545";
const CHAIN_B_URL = process.env.CHAIN_B_URL || "http://127.0.0.1:8546";

const args          = parseArgs(process.argv.slice(2));
const BATCH         = parseInt(args.batch     || "10");
const DURATION_MS   = args.duration ? parseInt(args.duration) * 1000 : null;
const ROUNDS        = DURATION_MS ? Infinity : parseInt(args.rounds || "5");
const AMOUNT        = args.amount    || "0.001";
const DIRECTION     = args.direction || "AB";
const REPORT_DIR    = args["report-dir"] || "./reports";
// 每筆交易複用批次內已出現 sender 的機率（0=無衝突, 0.3=30%衝突, 1=全衝突）
const CONFLICT_RATE = args["conflict-rate"] != null ? parseFloat(args["conflict-rate"]) : 0.3;

// gasPrice 隨機分佈：在 [MIN_GWEI, MAX_GWEI] 區間隨機取值，模擬真實 TOD 攻擊情境
const MIN_GWEI = 5;
const MAX_GWEI = 200;
function buildGasPrices(batchSize) {
  // 先產生不重複的隨機整數 Gwei 值（避免同值影響 Spearman rank）
  const used = new Set();
  return Array.from({ length: batchSize }, () => {
    let gwei;
    do {
      gwei = Math.floor(Math.random() * (MAX_GWEI - MIN_GWEI + 1)) + MIN_GWEI;
    } while (used.has(gwei) && used.size < (MAX_GWEI - MIN_GWEI + 1));
    used.add(gwei);
    return (gwei * 1e9).toString();
  });
}

async function main() {
  const isAB    = DIRECTION !== "BA";
  const srcUrl  = isAB ? CHAIN_A_URL : CHAIN_B_URL;
  const dstUrl  = isAB ? CHAIN_B_URL : CHAIN_A_URL;
  const srcWeb3 = new Web3(srcUrl);
  const dstWeb3 = new Web3(dstUrl);

  const srcArtPath = path.join(__dirname, `../build/chain${isAB ? "A" : "B"}/BridgeNode.json`);
  const srcArt     = JSON.parse(fs.readFileSync(srcArtPath));
  const srcAddr    = srcArt.networks[Object.keys(srcArt.networks).pop()].address;
  const srcNode    = new srcWeb3.eth.Contract(srcArt.abi, srcAddr);

  const accounts  = await srcWeb3.eth.getAccounts();
  const dstAccs   = await dstWeb3.eth.getAccounts();
  // 使用邏輯 ID（與 deploy.js 一致），不讀 eth_chainId
  const dstChainId = isAB ? "8546" : "8545";

  console.log("==========================================");
  console.log(" AO4C TOD Experiment");
  console.log(`  Direction  : ${DIRECTION}`);
  console.log(`  Batch size : ${BATCH} tx/round`);
  console.log(`  Mode          : ${DURATION_MS ? `TIME ${DURATION_MS/1000}s` : `ROUNDS ${ROUNDS}`}`);
  console.log(`  Conflict rate : ${(CONFLICT_RATE * 100).toFixed(0)}% (${CONFLICT_RATE === 0 ? "無衝突" : CONFLICT_RATE >= 1 ? "全衝突" : "隨機衝突"})`);
  console.log(`  Amount        : ${AMOUNT} ETH/tx`);
  console.log("==========================================\n");

  const allRoundResults = [];
  const startTime       = Date.now();
  let   round           = 0;
  let   successCount    = 0;
  let   failCount       = 0;
  let   totalSent       = 0;

  const shouldContinue = () =>
    DURATION_MS ? (Date.now() - startTime) < DURATION_MS : round < ROUNDS;

  while (shouldContinue()) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const label   = DURATION_MS
      ? `Round ${round + 1} (${elapsed}s / ${DURATION_MS/1000}s)`
      : `Round ${round + 1} / ${ROUNDS}`;
    console.log(`\n[TOD] === ${label} ===`);

    const roundResults = await runRound(round, srcNode, srcWeb3, accounts, dstAccs, dstChainId);
    allRoundResults.push(...roundResults);
    const roundOk   = roundResults.filter(r => r.revealStatus === "ok").length;
    const roundFail = roundResults.filter(r => r.revealStatus !== "ok").length;
    successCount += roundOk;
    failCount    += roundFail;
    totalSent    += roundResults.length;
    analyzeRound(round + 1, roundResults);
    round++;

    if (shouldContinue()) await sleep(2000);
  }

  const totalMs  = Date.now() - startTime;
  const tps      = (successCount / (totalMs / 1000)).toFixed(3);

  console.log("\n[TOD] === Overall Analysis ===");
  analyzeOverall(allRoundResults);
  console.log(`\nThroughput : ${tps} TPS (${successCount} tx / ${(totalMs/1000).toFixed(1)}s)`);

  const gen = new TodReportGenerator();
  await gen.generate(allRoundResults, {
    batch: BATCH, rounds: round, amount: AMOUNT,
    direction: DIRECTION, reportDir: REPORT_DIR,
    durationMs: totalMs, tps: parseFloat(tps),
    conflictRate: CONFLICT_RATE,
    totalSent, successCount, failCount,
  });

  process.exit(0);
}

async function runRound(roundIdx, srcNode, srcWeb3, accounts, dstAccs, dstChainId) {
  const gasPrices  = buildGasPrices(BATCH);
  const amount     = srcWeb3.utils.toWei(AMOUNT, "ether");
  const recipient  = dstAccs[0];
  const roundStart = Date.now();

  const gasPricesSorted = [...gasPrices].map(g => parseInt(g)/1e9).sort((a,b)=>a-b);
  console.log(`[TOD] Preparing ${BATCH} tx with random gasPrice range: ${gasPricesSorted[0]}~${gasPricesSorted[gasPricesSorted.length-1]} Gwei`);

  // 依 CONFLICT_RATE 隨機決定每筆是否複用已出現的 sender
  const usedSenders = [];
  const txMeta = Array.from({ length: BATCH }, (_, i) => {
    let sender;
    if (usedSenders.length > 0 && Math.random() < CONFLICT_RATE) {
      // 複用批次內已出現的 sender → 製造 double-spend 衝突
      sender = usedSenders[Math.floor(Math.random() * usedSenders.length)];
    } else {
      // 挑一個批次內尚未出現的 sender
      const fresh = accounts.filter(a => !usedSenders.includes(a));
      sender = fresh.length > 0
        ? fresh[Math.floor(Math.random() * fresh.length)]
        : accounts[Math.floor(Math.random() * accounts.length)];
      usedSenders.push(sender);
    }
    const salt          = srcWeb3.utils.randomHex(32);
    const blindedAmount = srcWeb3.utils.soliditySha3(
      { type: "uint256", value: amount },
      { type: "bytes32", value: salt }
    );
    return { i, sender, salt, blindedAmount, gasPrice: gasPrices[i], amount, recipient };
  });
  const conflictCount = BATCH - usedSenders.length;
  console.log(`[TOD] Conflict senders this round: ${conflictCount}/${BATCH} (rate=${(CONFLICT_RATE*100).toFixed(0)}%}`);

  console.log(`[TOD] Sending ${BATCH} commitOrder simultaneously...`);
  const commitResults = await Promise.all(txMeta.map(async (meta) => {
    try {
      const tx = await srcNode.methods
        .commitOrder(meta.blindedAmount, meta.recipient, dstChainId)
        .send({
          from:     meta.sender,
          value:    meta.amount,
          gas:      200000,
          gasPrice: meta.gasPrice,
        });
      return {
        ...meta,
        requestId:    tx.events?.OrderCommitted?.returnValues?.requestId,
        commitTxHash: tx.transactionHash,
        commitBlock:  Number(tx.blockNumber),
        commitTxIndex: Number(tx.transactionIndex),
        commitStatus: "ok",
      };
    } catch (err) {
      return { ...meta, commitStatus: "failed", error: err.message.slice(0, 100) };
    }
  }));

  const okCommits = commitResults.filter(r => r.commitStatus === "ok");
  console.log(`[TOD] commitOrder done: ${okCommits.length}/${BATCH} success`);

  console.log(`[TOD] Sending ${okCommits.length} revealOrder simultaneously...`);
  const revealResults = await Promise.all(okCommits.map(async (meta) => {
    try {
      const tx = await srcNode.methods
        .revealOrder(meta.requestId, meta.amount, meta.salt)
        .send({
          from:     meta.sender,
          gas:      200000,
          gasPrice: meta.gasPrice,
        });

      const seqNo = tx.events?.OrderRevealed?.returnValues?.seqNo;
      return {
        ...meta,
        seqNo:         seqNo != null ? Number(seqNo) : null,
        revealTxHash:  tx.transactionHash,
        revealBlock:   Number(tx.blockNumber),
        revealTxIndex: Number(tx.transactionIndex),
        revealStatus:  "ok",
        round:         roundIdx + 1,
        timestamp:     roundStart,
      };
    } catch (err) {
      return { ...meta, revealStatus: "failed", error: err.message.slice(0, 100), round: roundIdx + 1, timestamp: roundStart };
    }
  }));

  const okReveals = revealResults.filter(r => r.revealStatus === "ok" && r.seqNo !== null);
  console.log(`[TOD] revealOrder done: ${okReveals.length}/${okCommits.length} success`);

  return revealResults;
}

function analyzeRound(roundNum, results) {
  const ok = results.filter(r => r.revealStatus === "ok" && r.seqNo !== null);
  if (ok.length < 2) { console.log("[TOD] Not enough data for analysis"); return; }

  console.log(`\n[TOD] Round ${roundNum} Ordering Analysis:`);
  console.log("  gasPrice(Gwei) | txIndex(miner) | seqNo(AO4C) | sender");
  ok.sort((a, b) => a.seqNo - b.seqNo).forEach(r => {
    const gwei = parseInt(r.gasPrice) / 1e9;
    console.log(`  ${String(gwei).padStart(14)} | ${String(r.revealTxIndex).padStart(14)} | ${String(r.seqNo).padStart(11)} | ${r.sender.slice(0,10)}...`);
  });

  const spearman = spearmanCorrelation(
    ok.map(r => parseInt(r.gasPrice)),
    ok.map(r => r.seqNo)
  );
  console.log(`\n  Spearman(gasPrice, seqNo) = ${spearman.toFixed(4)}`);
  console.log(`  → ${Math.abs(spearman) < 0.3 ? "✓ 低相關：AO4C seqNo 與 gasPrice 無關，TOD 防護有效" : "⚠ 高相關：需進一步分析"}`);
}

function analyzeOverall(results) {
  const ok = results.filter(r => r.revealStatus === "ok" && r.seqNo !== null);
  const spearman = spearmanCorrelation(
    ok.map(r => parseInt(r.gasPrice)),
    ok.map(r => r.seqNo)
  );
  console.log(`Overall Spearman(gasPrice, seqNo) = ${spearman.toFixed(4)}`);
  console.log(`Total analyzed: ${ok.length} transactions across ${new Set(ok.map(r => r.round)).size} rounds`);
  console.log(Math.abs(spearman) < 0.3
    ? "✓ CONCLUSION: AO4C seqNo is independent of gasPrice → TOD protection validated"
    : "⚠ CONCLUSION: Correlation detected, review ordering mechanism"
  );
}

function spearmanCorrelation(arrX, arrY) {
  const n = arrX.length;
  if (n < 2) return 0;
  const rankX = getRanks(arrX);
  const rankY = getRanks(arrY);
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rankX[i] - rankY[i];
    sumD2 += d * d;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

function getRanks(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return arr.map(v => sorted.indexOf(v) + 1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

main().catch(err => { console.error("[TOD] Fatal:", err.message); process.exit(1); });
```

### scripts/run-tod-test.sh

```bash
#!/bin/bash
set -e
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# ── 參數 ────────────────────────────────────────────────────────
BATCH=${1:-10}               # 每輪同時送出的交易數
DURATION_MIN=${2:-10}       # 實驗持續分鐘數（預設 10 分鐘）
AMOUNT=${3:-"0.001"}        # 每筆金額 ETH
DIRECTION=${4:-"AB"}        # AB 或 BA
CONFLICT_RATE=${5:-"0.3"}   # 衝突率 0.0~1.0（預設 0.3，約 30% 交易觸發衝突）
REPORT_DIR="$PROJECT_ROOT/reports"
DURATION_SEC=$((DURATION_MIN * 60))
mkdir -p "$REPORT_DIR"

echo "============================================"
echo " AO4C TOD Protection Experiment"
echo " Batch size    : $BATCH tx (sent simultaneously)"
echo " Duration      : ${DURATION_MIN} min (${DURATION_SEC}s)"
echo " Conflict rate : $CONFLICT_RATE (0=無衝突, 0.3=30%隨機衝突, 1=全衝突)"
echo " Amount/tx     : $AMOUNT ETH"
echo " Direction     : $DIRECTION"
echo " Report dir    : $REPORT_DIR"
echo "============================================"
echo ""
echo "實驗說明："
echo "  每輪同時送出 $BATCH 筆交易，每筆 gasPrice 隨機（5~200 Gwei）"
echo "  衝突率 $CONFLICT_RATE → 每批約 $(echo "$BATCH $CONFLICT_RATE" | awk '{printf "%d", $1*$2}') 筆複用已出現 sender → AI 偵測 double-spend"
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
  --batch          "$BATCH"          \
  --duration       "$DURATION_SEC"   \
  --conflict-rate  "$CONFLICT_RATE"  \
  --amount         "$AMOUNT"         \
  --direction      "$DIRECTION"      \
  --report-dir     "$REPORT_DIR"

echo ""
echo "[TOD] Experiment complete."
echo "[TOD] Reports saved to: $REPORT_DIR/"
ls -lh "$REPORT_DIR"/ao4c-tod-*.xlsx 2>/dev/null || echo "(No TOD report found)"
```

---

## scripts/monitor.js

```javascript
/**
 * monitor.js — AO4C 即時監控（雙向，三階段事件 + AI Agent 衝突判定）
 */
const { Web3 } = require("web3");
const fs   = require("fs");
const path = require("path");

const WS_A   = "ws://127.0.0.1:8545";
const WS_B   = "ws://127.0.0.1:8546";
const AI_LOG = path.join(__dirname, "../logs/ai-decisions.jsonl");

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m",
  red: "\x1b[31m", purple: "\x1b[35m", blue: "\x1b[34m", orange: "\x1b[33m",
};

const stats = { committed: 0, aborted: 0, pending: 0, revealed: 0, startTime: Date.now() };
const aiStats = { batches: 0, singleSkip: 0, aiCommits: 0, aiAborts: 0, errors: 0, lastBatchTime: null, lastElapsedMs: null };
let aiLogLinesRead = 0;

function ts()             { return new Date().toLocaleTimeString("zh-TW", { hour12: false }); }
function shortAddr(addr)  { return addr ? `${addr.slice(0,6)}...${addr.slice(-4)}` : "—"; }
function formatEth(wei)   { return (Number(wei) / 1e18).toFixed(4) + " ETH"; }

function printStats() {
  const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  const tps = stats.committed > 0 ? (stats.committed / parseFloat(elapsed)).toFixed(3) : "0.000";
  process.stdout.write(
    `\r${C.dim}[統計]${C.reset} ` +
    `Revealed:${C.yellow}${stats.revealed}${C.reset} ` +
    `Committed:${C.green}${stats.committed}${C.reset} ` +
    `Aborted:${C.red}${stats.aborted}${C.reset} ` +
    `Pending:${C.purple}${stats.pending}${C.reset} ` +
    `TPS:${C.cyan}${tps}${C.reset} ` +
    `Time:${C.dim}${elapsed}s${C.reset}   `
  );
}

// 讀取 AI Agent log 檔，顯示新增的判定事件
function pollAiLog() {
  try {
    if (!fs.existsSync(AI_LOG)) return;
    const content = fs.readFileSync(AI_LOG, "utf8");
    const lines   = content.split("\n").filter(l => l.trim());
    if (lines.length <= aiLogLinesRead) return;

    const newLines = lines.slice(aiLogLinesRead);
    aiLogLinesRead = lines.length;

    for (const line of newLines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type === "batch_start") {
        const seqList = entry.seqNos.join(", ");
        console.log(`\n${C.yellow}[AI▶ START ]${C.reset} ${ts()} 批次大小=${C.bold}${entry.size}${C.reset} seqNos=[${seqList}]`);

      } else if (entry.type === "ai_result") {
        aiStats.batches++;
        aiStats.aiCommits += entry.commits;
        aiStats.aiAborts  += entry.aborts;
        aiStats.lastBatchTime   = new Date(entry.time).toLocaleTimeString("zh-TW", { hour12: false });
        aiStats.lastElapsedMs   = entry.elapsed_ms;

        let abortStr = "";
        if (entry.aborts > 0 && entry.abort_details?.length) {
          abortStr = " " + entry.abort_details.map(a => `seqNo=${a.seqNo}:${a.note}`).join("; ");
        }
        console.log(
          `\n${C.green}[AI✔ DONE  ]${C.reset} ${ts()} ` +
          `耗時=${C.cyan}${entry.elapsed_ms}ms${C.reset} ` +
          `commit=${C.green}${entry.commits}${C.reset} ` +
          `abort=${entry.aborts > 0 ? C.red : C.dim}${entry.aborts}${C.reset}` +
          (abortStr ? `${C.red}${abortStr}${C.reset}` : "")
        );

      } else if (entry.type === "ai_error") {
        aiStats.errors++;
        console.log(`\n${C.red}[AI✘ ERROR ]${C.reset} ${ts()} 耗時=${entry.elapsed_ms}ms err=${C.red}${entry.error?.slice(0,120)}${C.reset} → fallback全部commit`);

      } else if (entry.type === "single_tx_skip") {
        aiStats.singleSkip++;
        console.log(`\n${C.dim}[AI- SKIP  ]${C.reset} ${ts()} 單筆交易(seqNo=${entry.seqNo}) 不需 AI 判斷，直接 commit`);
      }

      printStats();
    }
  } catch (_) {}
}

async function main() {
  console.clear();
  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║  AO4C Cross-Chain Lab — 即時監控（含 AI Agent）  ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════╝${C.reset}\n`);
  console.log(`${C.dim}事件圖示：[A/B REVEAL] Phase2 ｜ [A/B COMMIT] Phase3a ｜ [A/B ABORT] Phase3b${C.reset}`);
  console.log(`${C.dim}AI  圖示：[AI▶ START] 批次送判 ｜ [AI✔ DONE] 判定完成 ｜ [AI✘ ERROR] 呼叫失敗 ｜ [AI- SKIP] 單筆跳過${C.reset}\n`);

  const artA = JSON.parse(fs.readFileSync(path.join(__dirname, "../build/chainA/BridgeNode.json")));
  const artB = JSON.parse(fs.readFileSync(path.join(__dirname, "../build/chainB/BridgeNode.json")));
  const addrA = artA.networks[Object.keys(artA.networks).pop()].address;
  const addrB = artB.networks[Object.keys(artB.networks).pop()].address;

  console.log(`${C.blue}[A]${C.reset} BridgeNode: ${C.cyan}${addrA}${C.reset}`);
  console.log(`${C.purple}[B]${C.reset} BridgeNode: ${C.cyan}${addrB}${C.reset}\n`);

  const webA = new Web3(new Web3.providers.WebsocketProvider(WS_A));
  const webB = new Web3(new Web3.providers.WebsocketProvider(WS_B));
  const nodeA = new webA.eth.Contract(artA.abi, addrA);
  const nodeB = new webB.eth.Contract(artB.abi, addrB);

  for (const [node, web, label, color] of [
    [nodeA, webA, "A", C.blue],
    [nodeB, webB, "B", C.purple],
  ]) {
    // Phase 2: OrderRevealed
    const subRev = await node.events.OrderRevealed({ fromBlock: "latest" });
    subRev.on("data", e => {
      const { seqNo, sender, amount, targetChainId } = e.returnValues;
      stats.revealed++; stats.pending++;
      console.log(`\n${color}[${label} REVEAL ]${C.reset} ${ts()} seqNo=${C.bold}${seqNo}${C.reset} from=${C.cyan}${shortAddr(sender)}${C.reset} ${formatEth(amount)} →chain${targetChainId}`);
      printStats();
    });

    // Phase 3a: OrderExecuted
    const subExec = await node.events.OrderExecuted({ fromBlock: "latest" });
    subExec.on("data", e => {
      const { seqNo, recipient, amount, newGlobalVersion } = e.returnValues;
      stats.committed++; if (stats.pending > 0) stats.pending--;
      console.log(`\n${C.green}[${label} COMMIT ]${C.reset} ${ts()} seqNo=${C.bold}${seqNo}${C.reset} →${C.cyan}${shortAddr(recipient)}${C.reset} ${formatEth(amount)} ver=${newGlobalVersion}`);
      printStats();
    });

    // Phase 3b: OrderAborted
    const subAbort = await node.events.OrderAborted({ fromBlock: "latest" });
    subAbort.on("data", e => {
      const { seqNo, sender, amount, reason } = e.returnValues;
      stats.aborted++; if (stats.pending > 0) stats.pending--;
      console.log(`\n${C.red}[${label} ABORT  ]${C.reset} ${ts()} seqNo=${C.bold}${seqNo}${C.reset} refund→${C.cyan}${shortAddr(sender)}${C.reset} ${formatEth(amount)} reason=${C.red}${reason}${C.reset}`);
      printStats();
    });
  }

  const aiLogStatus = fs.existsSync(AI_LOG) ? `${C.green}找到${C.reset}` : `${C.yellow}等待 Oracle 啟動...${C.reset}`;
  console.log(`${C.green}[監控中]${C.reset} 等待交易... AI決策日誌: ${aiLogStatus}\n`);
  printStats();

  // 每秒輪詢 AI Agent log
  setInterval(pollAiLog, 1000);

  setInterval(async () => {
    try {
      const [bA, bB, vA, vB] = await Promise.all([
        webA.eth.getBalance(addrA), webB.eth.getBalance(addrB),
        nodeA.methods.globalVersion().call(), nodeB.methods.globalVersion().call(),
      ]);
      console.log(`\n${C.dim}[快照]${C.reset} ${ts()} A=${C.yellow}${formatEth(bA)}${C.reset} verA=${vA} | B=${C.green}${formatEth(bB)}${C.reset} verB=${vB} | AI批次=${C.yellow}${aiStats.batches}${C.reset} AI衝突=${C.red}${aiStats.aiAborts}${C.reset} 錯誤=${aiStats.errors}`);
      printStats();
    } catch (_) {}
  }, 10000);

  process.on("SIGINT", () => {
    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    console.log(`\n\n${C.bold}=== 監控結束 ===${C.reset}`);
    console.log(`執行時間: ${elapsed}s`);
    console.log(`鏈上事件  → Revealed:${stats.revealed} | Committed:${stats.committed} | Aborted:${stats.aborted} | Pending:${stats.pending}`);
    console.log(`AI Agent  → 觸發批次:${aiStats.batches} | AI判定commit:${aiStats.aiCommits} | AI判定abort:${aiStats.aiAborts} | 單筆跳過:${aiStats.singleSkip} | 呼叫失敗:${aiStats.errors}`);
    if (aiStats.lastBatchTime) console.log(`最後AI判定: ${aiStats.lastBatchTime} (耗時 ${aiStats.lastElapsedMs}ms)`);
    process.exit(0);
  });
}

main().catch(err => { console.error("[Monitor] 啟動失敗:", err.message); process.exit(1); });
```

---

## 快速啟動流程

```bash
# 0. 前置：確認 Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude                                        # 完成登入
claude --output-format json -p "test"         # 驗證可用

# 1. 環境檢測
bash scripts/check-env.sh

# 2. 安裝依賴
npm install

# 3. 啟動雙鏈 + 部署 + Oracle
bash scripts/start-chains.sh
# 預期 log：
#   Chain A logicalId: 8545
#   Chain B logicalId: 8546
#   Peers configured: ✓
#   Oracle: AO4C bidirectional mode

# 4. 確認狀態
bash scripts/status.sh

# 5. 即時監控（另開 terminal）
bash scripts/monitor.sh

# 6. 啟動 UI（另開 terminal）
bash scripts/start-ui.sh
# http://localhost:3000

# 7. 壓力測試
bash scripts/auto-stress-test.sh 60 10 0.001

# 8. TOD 防護實驗（batch=10, duration=10min, amount=0.001, direction=AB, conflict-rate=0.3）
bash scripts/run-tod-test.sh 10 10 0.001 AB 0.3

# 9. 停止
kill $(cat logs/chainA.pid) $(cat logs/chainB.pid) $(cat logs/oracle.pid) 2>/dev/null || true
fuser -k 3000/tcp 2>/dev/null || true
```

---

## 產出清單 Checklist

- [ ] `scripts/check-env.sh`
- [ ] `npm install` 完成（含 p-limit@^3.1.0）
- [ ] `hardhat.config.js`
- [ ] `contracts/BridgeNode.sol`
- [ ] `scripts/deploy.js` — **邏輯 ID `"8545"`/`"8546"`，不讀 `eth_chainId`**
- [ ] `oracle/occExecutor.js`
- [ ] `oracle/aiConflictAgent.js`
- [ ] `oracle/oracle.js` — **邏輯 ID，不讀 `eth_chainId`**
- [ ] `oracle/.env`
- [ ] `ui/server.js`
- [ ] `ui/index.html`
- [ ] `ui/app.js` — **邏輯 ID，不讀 `eth_chainId`**
- [ ] `scripts/start-chains.sh`
- [ ] `scripts/start-ui.sh`
- [ ] `scripts/auto-stress-test.sh`
- [ ] `scripts/monitor.sh` + `scripts/monitor.js`
- [ ] `scripts/status.sh`
- [ ] `stress-test/sender.js` — **邏輯 ID，不讀 `eth_chainId`**
- [ ] `stress-test/report-generator.js`
- [ ] `stress-test/tod-test.js` — **邏輯 ID，不讀 `eth_chainId`**
- [ ] `stress-test/tod-report-generator.js`
- [ ] `scripts/run-tod-test.sh`
- [ ] `package.json`
- [ ] `chmod +x scripts/*.sh`
- [ ] `bash scripts/start-chains.sh` 成功，log 出現 `Peers configured: ✓`
- [ ] `bash scripts/status.sh` 全部 `[UP]`
- [ ] Oracle log 出現 `AO4C bidirectional mode`
