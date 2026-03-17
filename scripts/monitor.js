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
