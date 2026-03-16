/**
 * monitor.js — AO4C 即時監控（雙向，三階段事件）
 */
const { Web3 } = require("web3");
const fs   = require("fs");
const path = require("path");

const WS_A = "ws://127.0.0.1:8545";
const WS_B = "ws://127.0.0.1:8546";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m",
  red: "\x1b[31m", purple: "\x1b[35m", blue: "\x1b[34m", orange: "\x1b[33m",
};

const stats = { committed: 0, aborted: 0, pending: 0, revealed: 0, startTime: Date.now() };

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

async function main() {
  console.clear();
  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║  AO4C Cross-Chain Lab — 即時監控            ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════╝${C.reset}\n`);

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

  console.log(`${C.green}[監控中]${C.reset} 等待交易...\n`);
  printStats();

  setInterval(async () => {
    try {
      const [bA, bB, vA, vB] = await Promise.all([
        webA.eth.getBalance(addrA), webB.eth.getBalance(addrB),
        nodeA.methods.globalVersion().call(), nodeB.methods.globalVersion().call(),
      ]);
      console.log(`\n${C.dim}[快照]${C.reset} ${ts()} A=${C.yellow}${formatEth(bA)}${C.reset} verA=${vA} | B=${C.green}${formatEth(bB)}${C.reset} verB=${vB}`);
      printStats();
    } catch (_) {}
  }, 10000);

  process.on("SIGINT", () => {
    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    console.log(`\n\n${C.bold}=== 監控結束 ===${C.reset}`);
    console.log(`執行時間:${elapsed}s | Revealed:${stats.revealed} | Committed:${stats.committed} | Aborted:${stats.aborted} | Pending:${stats.pending}`);
    process.exit(0);
  });
}

main().catch(err => { console.error("[Monitor] 啟動失敗:", err.message); process.exit(1); });
