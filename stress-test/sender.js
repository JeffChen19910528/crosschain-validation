/**
 * sender.js — AO4C 雙向併發壓力測試
 * 三階段 OCC：Phase1 commitOrder → Phase2 revealOrder → 等待 Oracle Phase3
 */
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

  // 使用邏輯 ID（與 deploy.js 一致），不讀 eth_chainId
  const chainIdA = "8545";
  const chainIdB = "8546";

  const limit     = pLimit(CONCURRENCY);
  const startTime = Date.now();
  const results   = [];
  let   txCount = 0, successCount = 0, failCount = 0;

  console.log(`[Stress] AO4C Bidirectional OCC | concurrency=${CONCURRENCY} duration=${DURATION/1000}s amount=${AMOUNT_ETH}ETH`);

  const pendingTasks = [];

  while (Date.now() - startTime < DURATION) {
    const idx = txCount++;

    // 隨機決定方向（A→B 或 B→A）
    const isAB     = Math.random() > 0.5;
    const srcWeb3  = isAB ? webA : webB;
    const srcNode  = isAB ? nodeA : nodeB;
    const sender   = isAB ? accsA[idx % accsA.length] : accsB[idx % accsB.length];
    const recipient = isAB ? accsB[0] : accsA[0];
    const dstChainId = isAB ? chainIdB : chainIdA;
    const direction  = isAB ? "A→B" : "B→A";

    const task = limit(async () => {
      const t0     = Date.now();
      const amount = srcWeb3.utils.toWei(AMOUNT_ETH, "ether");
      const salt   = srcWeb3.utils.randomHex(32);
      const blindedAmount = srcWeb3.utils.soliditySha3(
        { type: "uint256", value: amount },
        { type: "bytes32", value: salt }
      );

      try {
        // Phase 1
        const tx1 = await srcNode.methods
          .commitOrder(blindedAmount, recipient, dstChainId)
          .send({ from: sender, value: amount, gas: 200000 });
        const requestId = tx1.events?.OrderCommitted?.returnValues?.requestId;

        // Phase 2
        const tx2 = await srcNode.methods
          .revealOrder(requestId, amount, salt)
          .send({ from: sender, gas: 200000 });
        const seqNo = tx2.events?.OrderRevealed?.returnValues?.seqNo;

        const latency = Date.now() - t0;
        successCount++;
        results.push({ index: idx, direction, status: "revealed", seqNo: seqNo?.toString(), txHash: tx2.transactionHash, sender, recipient, amount: AMOUNT_ETH, latency, timestamp: new Date(t0).toISOString() });

        if (idx % 20 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const tps = (successCount / parseFloat(elapsed)).toFixed(2);
          console.log(`[Stress] tx=${String(idx).padStart(4)} revealed=${String(successCount).padStart(4)} fail=${String(failCount).padStart(3)} elapsed=${elapsed}s tps=${tps}`);
        }
      } catch (err) {
        failCount++;
        results.push({ index: idx, direction, status: "failed", error: err.message.slice(0, 200), sender, recipient, amount: AMOUNT_ETH, latency: Date.now() - t0, timestamp: new Date(t0).toISOString() });
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
  console.log("Note: Phase 3 (Oracle AI validation) runs async");
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
