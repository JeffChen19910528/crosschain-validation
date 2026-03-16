/**
 * tod-test.js — AO4C TOD（Transaction Ordering Dependence）實驗
 *
 * 實驗設計：
 *  1. 同時（Promise.all）送出 BATCH_SIZE 筆交易，gasPrice 各不相同
 *     → 模擬攻擊者試圖透過 gasPrice 操控礦工排序
 *  2. 記錄三個序號：
 *     - gasPrice  : 攻擊者期望的優先順序（高 gas = 期望先執行）
 *     - txIndex   : 礦工實際排序（在區塊內的位置）
 *     - seqNo     : AO4C 確定性排序（BridgeNode.revealOrder 賦予）
 *  3. 分析 txIndex 與 seqNo 的相關性
 *     - 若相關性低 → 礦工排序 ≠ AO4C 排序 → TOD 攻擊對 AO4C 無效
 *  4. 產出 Excel 報表，含三欄對比和 Spearman 相關係數
 *
 * 使用方式：
 *  node stress-test/tod-test.js [--batch 10] [--rounds 5] [--amount 0.001] [--direction AB]
 */
require("dotenv").config({ path: __dirname + "/../oracle/.env" });
const { Web3 }        = require("web3");
const TodReportGenerator = require("./tod-report-generator");
const fs              = require("fs");
const path            = require("path");

const CHAIN_A_URL = process.env.CHAIN_A_URL || "http://127.0.0.1:8545";
const CHAIN_B_URL = process.env.CHAIN_B_URL || "http://127.0.0.1:8546";

const args      = parseArgs(process.argv.slice(2));
const BATCH     = parseInt(args.batch     || "10");
const ROUNDS    = parseInt(args.rounds    || "5");
const AMOUNT    = args.amount    || "0.001";
const DIRECTION = args.direction || "AB";
const REPORT_DIR = args["report-dir"] || "./reports";

// gasPrice 梯度：從高到低，模擬攻擊者賦予不同優先序
function buildGasPrices(batchSize) {
  const base = 10; // gwei base
  return Array.from({ length: batchSize }, (_, i) =>
    ((batchSize - i) * base).toString() + "000000000"
  );
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
  console.log(`  Direction : ${DIRECTION}`);
  console.log(`  Batch size: ${BATCH} tx/round`);
  console.log(`  Rounds    : ${ROUNDS}`);
  console.log(`  Amount    : ${AMOUNT} ETH/tx`);
  console.log("==========================================\n");

  const allRoundResults = [];

  for (let round = 0; round < ROUNDS; round++) {
    console.log(`\n[TOD] === Round ${round + 1} / ${ROUNDS} ===`);
    const roundResults = await runRound(round, srcNode, srcWeb3, accounts, dstAccs, dstChainId);
    allRoundResults.push(...roundResults);
    analyzeRound(round + 1, roundResults);

    if (round < ROUNDS - 1) await sleep(2000);
  }

  console.log("\n[TOD] === Overall Analysis ===");
  analyzeOverall(allRoundResults);

  const gen = new TodReportGenerator();
  await gen.generate(allRoundResults, {
    batch: BATCH, rounds: ROUNDS, amount: AMOUNT,
    direction: DIRECTION, reportDir: REPORT_DIR,
  });

  process.exit(0);
}

async function runRound(roundIdx, srcNode, srcWeb3, accounts, dstAccs, dstChainId) {
  const gasPrices = buildGasPrices(BATCH);
  const amount    = srcWeb3.utils.toWei(AMOUNT, "ether");
  const recipient = dstAccs[0];

  console.log(`[TOD] Preparing ${BATCH} tx with gasPrice: ${gasPrices.map(g => parseInt(g)/1e9 + "Gwei").join(", ")}`);

  const txMeta = Array.from({ length: BATCH }, (_, i) => {
    const sender        = accounts[i % accounts.length];
    const salt          = srcWeb3.utils.randomHex(32);
    const blindedAmount = srcWeb3.utils.soliditySha3(
      { type: "uint256", value: amount },
      { type: "bytes32", value: salt }
    );
    return { i, sender, salt, blindedAmount, gasPrice: gasPrices[i], amount, recipient };
  });

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
        commitBlock:  tx.blockNumber,
        commitTxIndex: tx.transactionIndex,
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
        seqNo:         seqNo ? parseInt(seqNo) : null,
        revealTxHash:  tx.transactionHash,
        revealBlock:   tx.blockNumber,
        revealTxIndex: tx.transactionIndex,
        revealStatus:  "ok",
        round:         roundIdx + 1,
      };
    } catch (err) {
      return { ...meta, revealStatus: "failed", error: err.message.slice(0, 100), round: roundIdx + 1 };
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
