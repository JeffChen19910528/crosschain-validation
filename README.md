# AO4C Cross-Chain Lab

**AI-Augmented Optimistic Cross-Chain Concurrency Control**

雙向跨鏈交易實驗環境，實作 AO4C 演算法架構，用於學術研究與效能實驗。

---

## 架構說明

### 解決的問題

| 問題 | 機制 | 實作位置 |
|------|------|----------|
| TOD（Transaction Ordering Dependence） | 確定性排序承諾（seqNo = nextSeqNo++，EVM 執行序決定，非礦工）；壓測以隨機 gasPrice（5~200 Gwei，批次內不重複）模擬礦工排序偏好，驗證 seqNo 與 gasPrice 無相關 | `BridgeNode.revealOrder()` / `stress-test/tod-test.js` |
| Front-Running | Commit-Reveal：Phase 1 只送 `hash(amount+salt)`，Phase 2 才 reveal | `BridgeNode.commitOrder()` / `revealOrder()` |
| 雙花攻擊（Double Spend） | `processedRequests` mapping + OCC version stamp + AI 語意判斷三層防護 | `BridgeNode.validateAndExecute()` |
| ACID Isolation | `globalVersion` 序列化點 + `require(globalVersion == expectedVersion)` | `BridgeNode.validateAndExecute()` |
| 語意層衝突 | Claude Code CLI AI Agent 判斷有序序列中的衝突，回傳 commits/aborts | `oracle/aiConflictAgent.js` |

### AO4C 三階段 OCC 演算法

```
Phase 1 — Order Commitment
  使用者呼叫 commitOrder(blindedAmount, recipient, targetChainId)
  合約記錄承諾，readVersion = globalVersion（OCC read-set stamp）
  不加任何 mutex，允許高并發

Phase 2 — Reveal & Deterministic Ordering
  使用者呼叫 revealOrder(requestId, amount, salt)
  合約驗證 hash(amount+salt) == blindedAmount
  賦予 seqNo = nextSeqNo++（確定性排序，防 TOD）
  emit OrderRevealed → Oracle 收到後進入 AI Validation

Phase 3 — AI Validation & Execution
  Oracle 帶有序序列呼叫 Claude Code CLI
  AI Agent 回傳 { commits, aborts }
  Oracle 呼叫 validateAndExecute(hasConflict, conflictNote, expectedVersion)
  合約做 version 最後驗證：require(globalVersion == expectedVersion)
  無衝突 → executeTransfer（目標鏈 ETH transfer），globalVersion++
  有衝突 → _abort（退款 ETH），emit OrderAborted
```

### 架構分層

```
┌─────────────────────────────────────────────────────┐
│  智能合約層（BridgeNode.sol）                        │
│  · AO4C 演算法核心，鏈上執行，完全可驗證             │
│  · 兩條鏈部署同一份合約，雙向對稱                    │
│  · 三階段 OCC：Commit → Reveal → Validate           │
├─────────────────────────────────────────────────────┤
│  Oracle 中繼層（oracle/oracle.js）                   │
│  · 輕量中繼，不做排序不做判斷                        │
│  · 監聽雙鏈事件 → 呼叫 AI Agent → 帶結果回合約      │
│  · AI 判定結果寫入 logs/ai-decisions.jsonl           │
├─────────────────────────────────────────────────────┤
│  AI Agent 層（oracle/aiConflictAgent.js）            │
│  · Claude Code CLI（月訂閱）                         │
│  · 接收有序序列，判斷語意層衝突                      │
│  · 回傳 { commits: [...], aborts: [{id, note}] }     │
└─────────────────────────────────────────────────────┘
```

---

## 環境需求

| 工具 | 版本 | 說明 |
|------|------|------|
| Node.js | >= 18 | 建議 20.x |
| npm | >= 9 | |
| Claude Code CLI | latest | `npm install -g @anthropic-ai/claude-code` |
| Claude Code 帳號 | 月訂閱 | AI Agent 衝突驗證必要 |

---

## 安裝

```bash
# 1. 進入專案目錄
cd crosschain

# 2. 環境檢測與自動安裝依賴
bash scripts/check-env.sh

# 3. 安裝 npm 套件
npm install

# 4. 安裝並登入 Claude Code CLI（AI Agent 必要）
npm install -g @anthropic-ai/claude-code
claude          # 完成登入
claude --output-format json -p "test"   # 驗證可用
```

---

## 啟動

### 完整流程

```bash
# Terminal 1：啟動雙鏈 + 部署合約 + 啟動 Oracle
bash scripts/start-chains.sh

# Terminal 2：即時監控（選用）
bash scripts/monitor.sh

# Terminal 3：啟動 Web UI
bash scripts/start-ui.sh
# 瀏覽器開啟 http://localhost:3000
```

### 確認服務狀態

```bash
bash scripts/status.sh
```

預期輸出：
```
Chain A (port 8545)
  [UP]   RPC reachable — blockNumber: N
  [UP]   Process running (PID XXXX)

Chain B (port 8546)
  [UP]   RPC reachable — blockNumber: N
  [UP]   Process running (PID XXXX)

Oracle
  [UP]   Process running (PID XXXX)

BridgeNode Contracts
  [UP]   BridgeNode (Chain A): 0x...
  [UP]   BridgeNode (Chain B): 0x...

AI Agent (Claude Code CLI)
  [UP]   claude CLI: X.X.X
```

---

## 壓力測試

```bash
# 語法：bash scripts/auto-stress-test.sh [秒數] [併發數] [每筆ETH]
bash scripts/auto-stress-test.sh 60 10 0.001

# 預設值：600秒，10併發，0.001 ETH/筆
bash scripts/auto-stress-test.sh
```

每筆交易使用 **1~100 Gwei 之間的隨機 gasPrice**，用以模擬礦工依 gas 優先排序的 TOD 場景。測試完成後可在報表中驗證 seqNo 與 gasPrice 是否獨立（即 AO4C 的 TOD 防護是否成立）。

> TOD 防護實驗（`tod-test.js`）使用 **5~200 Gwei 隨機不重複 gasPrice**，批次內每筆 gas 各異，以最大化排名多樣性，確保 Spearman 分析結果有效。

測試完成後，Excel 報表自動儲存至 `reports/` 目錄，包含：

| 工作表 | 內容 |
|--------|------|
| **摘要 Summary** | TPS、延遲統計（P50/P95/P99）、OCC Abort 數量 |
| **交易明細 Detail** | 每筆交易的 seqNo、狀態、方向、延遲、**Gas (Gwei)** |
| **每秒 TPS** | 逐秒吞吐量 |
| **每分鐘 TPS（折線圖）** | 每分鐘成功交易數、平均 TPS、累計 TPS、**Gas 最小/最大/平均 (Gwei)** |
| **方向統計 Direction** | A→B 與 B→A 各自的成功率 |

### Gas 欄位說明（TOD 驗證用）

「交易明細」的 `Gas (Gwei)` 欄位與「每分鐘 TPS」的 Gas 統計欄位，記錄每筆 / 每分鐘交易實際送出的 gasPrice。若每分鐘的 Gas 最小值與最大值差距明顯（例如 5 Gwei vs 200 Gwei），代表 TOD 場景有效模擬，可搭配 TOD 實驗的 Spearman 分析進一步確認 seqNo 獨立性。

---

## TOD 防護實驗

### 執行 TOD 實驗

```bash
# 語法：bash scripts/run-tod-test.sh [批次大小] [持續分鐘] [金額ETH] [方向] [衝突率]

# 預設：30% 隨機衝突（符合現實情境）
bash scripts/run-tod-test.sh 10 10 0.001 AB

# 無衝突（與 lock-based 方案的基準比較）
bash scripts/run-tod-test.sh 10 10 0.001 AB 0.0

# 30% 隨機衝突（明確指定，與預設等價）
bash scripts/run-tod-test.sh 10 10 0.001 AB 0.3

# 高衝突壓力測試
bash scripts/run-tod-test.sh 10 10 0.001 AB 0.7
```

**參數說明：**

| 參數 | 預設值 | 說明 |
|------|--------|------|
| 批次大小 | 10 | 每輪同時送出的交易數 |
| 持續分鐘 | 10 | 實驗持續時間（分鐘） |
| 金額 ETH | 0.001 | 每筆轉帳金額 |
| 方向 | AB | `AB`（A→B）或 `BA`（B→A） |
| 衝突率 | 0.3 | `0.0`～`1.0`；每筆交易複用批次內已出現 sender 的機率 |

**衝突率設計說明：**

衝突以「複用 sender」的方式隨機產生，模擬真實情境中偶發的雙花攻擊：

| 衝突率 | 行為 | 用途 |
|--------|------|------|
| `0.0` | 每筆 sender 全不同，無衝突 | 與 lock-based 基準比較 |
| `0.1` | 約 10% 交易觸發衝突 | 低衝突現實情境 |
| `0.3` | 約 30% 交易觸發衝突 | 預設，中等壓力 |
| `0.7` | 約 70% 交易觸發衝突 | 高衝突惡意攻擊模擬 |
| `1.0` | 全部 sender 相同 | 最壞情況壓力測試 |

> **注意：** Oracle 的批次視窗（`BATCH_WINDOW_MS`）設定為 **1500ms**，確保同一輪同時送出的 10 筆 reveal 全部落在同一批次讓 AI 審查。若視窗太短，事件會被拆成多個單筆批次，AI 就不會被呼叫。

**關於 `[AI✘ ERROR]` 的影響：**

AI 呼叫逾時（timeout=60s）時 fallback 全部 commit，**不影響 TOD Spearman 分析結果**，原因是 seqNo 在 Phase 2 `revealOrder` 就已確定賦值，與 Phase 3 AI 判斷無關。逾時只影響 B 鏈是否收到 ETH，不影響 TOD 防護的統計數據。

**B 鏈轉帳流程說明：**

TOD 實驗方向 A→B 的完整流程：

```
使用者 → commitOrder (A鏈)  →  A鏈合約餘額 ↑
       → revealOrder (A鏈)  →  Oracle 收到事件
       → AI 批次審查        →  無衝突 → commit / 有衝突 → abort+退款
       → validateAndExecute (A鏈) → globalVersion++
       → executeTransfer (B鏈)    → B鏈合約餘額 ↓，recipient 收到 ETH
```

若同批次多筆同時 commit 讀到相同 `readVersion`，第一筆 validateAndExecute 成功後 `globalVersion++`，其餘筆 version 不符會被 abort 退款（OCC 正確行為）。

### Excel 報表內容（TOD 實驗）

測試完成後報表自動儲存至 `reports/ao4c-tod-experiment-YYYYMMDD-HHmmss.xlsx`：

| 工作表 | 內容 |
|--------|------|
| **摘要 Summary** | 實驗參數、批次數、時長、**總送出筆數、成功/失敗筆數、成功率、TPS**、Spearman 三組係數、TOD 防護結論 |
| **原始數據 Raw Data** | 每筆交易的 gasPrice/gasPrice排名、txIndex/txIndex排名、seqNo/seqNo排名、sender、requestId |
| **排名對比 Ranking** | gasPrice 排名 vs seqNo 排名，標示 AO4C 修正筆數 |
| **Spearman by Round** | 每輪三組 Spearman 係數、TOD 防護是否成立 |
| **每輪交易量（折線圖）** | 每輪成功/失敗數、TPS、AO4C 修正率 |
| **每分鐘吞吐量** | 每分鐘送出/成功/失敗數、**每分鐘 TPS**、累計成功筆數、**累計 TPS** |

### 判讀 Spearman 係數

```
Spearman(gasPrice, seqNo) = ρ

ρ 接近  0：gasPrice 與 seqNo 無相關 → TOD 防護有效 ✓
ρ 接近  1：gasPrice 高的交易 seqNo 也小（正相關）→ 礦工排序影響 AO4C
ρ 接近 -1：gasPrice 高的交易 seqNo 反而大（負相關）→ 反向影響

判斷標準：|ρ| < 0.3 視為無顯著相關，TOD 防護成立
```

---

## 即時監控說明

`bash scripts/monitor.sh` 啟動後同時監控兩個來源：

### 區塊鏈事件（Phase 2 / 3）

```
[A REVEAL ] seqNo=5 from=0xabc...  0.0010 ETH →chainB   ← Phase 2 完成
[B COMMIT ] seqNo=5 →0xdef...      0.0010 ETH ver=12     ← Phase 3 Commit
[A ABORT  ] seqNo=7 refund→0xabc   0.0010 ETH reason=... ← Phase 3 Abort
```

### AI Agent 衝突判定

```
[AI▶ START] 批次大小=3 seqNos=[5, 6, 7]          ← 送給 Claude CLI 前
[AI✔ DONE ] 耗時=1234ms commit=2 abort=1 ...      ← Claude 判定完成（timeout 上限 60s）
[AI✘ ERROR] 耗時=60001ms err=claude CLI failed ... ← CLI 逾時（保守全 commit）
[AI- SKIP ] 單筆交易(seqNo=8) 不需 AI 判斷        ← 單筆直接 commit
```

### 統計列

```
[統計] Revealed:N  Committed:N  Aborted:N  Pending:N  TPS:N.NNN  Time:Ns
```

每 10 秒輸出一次快照，包含 AI 批次/衝突/錯誤詳細數字：

```
[快照] HH:MM:SS A=X.XXXX ETH verA=N | B=X.XXXX ETH verB=N | AI批次=N AI衝突=N 錯誤=N
```

### AI 判定日誌

Oracle 將每次 AI 判定結果寫入 `logs/ai-decisions.jsonl`（JSON Lines 格式），monitor 每秒輪詢此檔案並即時顯示。每次執行 `monitor.sh` 會自動清除舊日誌。

---

## 重啟 Oracle

修改 Oracle 相關設定後，需重啟 Oracle 才能生效。關鍵參數：

| 檔案 | 參數 | 預設值 | 說明 |
|------|------|--------|------|
| `oracle/occExecutor.js` | `BATCH_WINDOW_MS` | 1500 | 等待同輪 reveal 聚集的視窗（ms） |
| `oracle/aiConflictAgent.js` | `TIMEOUT_MS` | 60000 | Claude CLI 判斷逾時上限（ms） |

```bash
# 重啟 Oracle（不重啟鏈）
kill $(cat logs/oracle.pid) 2>/dev/null || true
node oracle/oracle.js > logs/oracle.log 2>&1 &
echo $! > logs/oracle.pid
echo "[OK] Oracle restarted (PID $(cat logs/oracle.pid))"
```

---

## 停止服務

```bash
kill $(cat logs/chainA.pid) $(cat logs/chainB.pid) $(cat logs/oracle.pid) 2>/dev/null || true
fuser -k 3000/tcp 2>/dev/null || true
```

---

## 專案結構

```
crosschain/
├── contracts/
│   └── BridgeNode.sol          # AO4C 核心合約（雙向對稱）
├── oracle/
│   ├── oracle.js               # 雙向 Oracle 中繼
│   ├── occExecutor.js          # OCC 批次執行器（寫入 AI 判定日誌）
│   ├── aiConflictAgent.js      # Claude Code CLI AI Agent
│   └── .env
├── ui/
│   ├── index.html              # Web UI（雙向交易）
│   ├── app.js
│   └── server.js               # Express + RPC 代理
├── scripts/
│   ├── deploy.js               # 部署腳本
│   ├── start-chains.sh
│   ├── start-ui.sh
│   ├── auto-stress-test.sh
│   ├── monitor.sh              # 啟動監控（清除舊 AI 日誌）
│   ├── monitor.js              # 即時監控（區塊鏈事件 + AI Agent 判定）
│   ├── run-tod-test.sh
│   ├── status.sh
│   └── check-env.sh
├── stress-test/
│   ├── sender.js               # 雙向併發壓測（隨機 gasPrice 模擬 TOD）
│   ├── report-generator.js     # Excel 報表（含 Gas 欄位）
│   ├── tod-test.js             # TOD 防護實驗
│   └── tod-report-generator.js # TOD Excel 報表
├── build/                      # 部署後合約 artifact
├── logs/
│   ├── chainA.log / chainB.log # Hardhat 節點 log
│   ├── oracle.log              # Oracle 執行 log
│   └── ai-decisions.jsonl      # AI Agent 判定記錄（每次監控啟動清除）
├── reports/                    # Excel 壓測報表
└── README.md
```

---

## 常見問題

**Q：Phase 3 遲遲沒有 COMMIT / ABORT？**
A：檢查 Oracle log（`logs/oracle.log`），確認 Claude Code CLI 是否正常回應。
執行 `claude --output-format json -p "test"` 驗證 CLI 可用。

**Q：監控看不到 `[AI▶ START]` / `[AI✔ DONE]` 訊息？**
A：AI 判定只在批次大小 > 1 時觸發。單筆交易顯示 `[AI- SKIP]`。
若完全沒有 AI 相關訊息，請確認 Oracle 正在執行（`bash scripts/status.sh`）
並確認 `logs/ai-decisions.jsonl` 存在且有內容。

**Q：Oracle log 出現 `AI agent unavailable` 或監控顯示 `[AI✘ ERROR]`？**
A：Claude Code CLI 回應逾時或失敗，此時 OCC 保守處理為全部 commit，
最後由合約的 version 驗證攔截真正的衝突。

**Q：壓力測試出現大量 `failed`？**
A：通常是 Hardhat 本地鏈的 gas 或 nonce 問題。降低併發數：
`bash scripts/auto-stress-test.sh 60 3 0.001`

**Q：UI 顯示「合約尚未部署」？**
A：請先執行 `bash scripts/start-chains.sh`，確認 `build/` 目錄有 `BridgeNode.json`。

---
