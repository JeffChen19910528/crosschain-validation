/**
 * oracle.js — AO4C Oracle 中繼層
 *
 * 職責（輕量中繼，不做排序或衝突判斷）：
 *  1. 同時監聽兩條鏈的 BridgeNode OrderRevealed 事件
 *  2. 收集有序批次，呼叫 AI Agent
 *  3. 將 AI 結果帶回對應的目標鏈執行 validateAndExecute / executeTransfer
 *
 * Web3 v4：事件訂閱必須加 await
 */
require("dotenv").config({ path: __dirname + "/.env" });
const { Web3 }    = require("web3");
const OccExecutor = require("./occExecutor");
const fs   = require("fs");
const path = require("path");

const CHAIN_A_URL    = process.env.CHAIN_A_URL || "http://127.0.0.1:8545";
const CHAIN_B_URL    = process.env.CHAIN_B_URL || "http://127.0.0.1:8546";
const WS_A           = CHAIN_A_URL.replace("http://", "ws://").replace("https://", "wss://");
const WS_B           = CHAIN_B_URL.replace("http://", "ws://").replace("https://", "wss://");

// 兩條鏈都需要 WebSocket（雙向事件監聽）
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

  // OCC Commit callback
  occ.onCommit = async (tx) => {
    await executeCommit(tx);
  };

  // OCC Abort callback
  occ.onAbort = async (tx, note) => {
    await executeAbort(tx, note);
  };

  // 使用邏輯 ID（與 deploy.js 一致），不讀 eth_chainId（Hardhat 兩條鏈都回傳 31337）
  const netIdA = "8545";
  const netIdB = "8546";
  console.log(`[Oracle] Chain A logicalId: ${netIdA}, Chain B logicalId: ${netIdB}`);

  // 監聽 Chain A 的 OrderRevealed（A→B 方向）
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

  // 監聽 Chain B 的 OrderRevealed（B→A 方向）
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

/**
 * Commit：
 *  1. 通知來源鏈 validateAndExecute（記錄狀態，globalVersion++）
 *  2. 在目標鏈 executeTransfer（實際 transfer ETH）
 */
async function executeCommit(tx) {
  const { requestId, amount, recipient, srcNode, dstNode,
          oracleAccount, oracleAccountDst, readVersion, srcNetId } = tx;

  console.log(`[Oracle] COMMIT seqNo=${tx.seqNo} ${tx.srcChainId}→${tx.targetChainId}`);

  try {
    // Step 1：來源鏈 validateAndExecute
    const gas1 = await srcNode.methods
      .validateAndExecute(requestId, false, "no conflict", readVersion)
      .estimateGas({ from: oracleAccount });
    await srcNode.methods
      .validateAndExecute(requestId, false, "no conflict", readVersion)
      .send({ from: oracleAccount, gas: Math.ceil(Number(gas1) * 1.2) });

    // Step 2：目標鏈 executeTransfer
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

/**
 * Abort：通知來源鏈 validateAndExecute（hasConflict=true）→ 退款
 */
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
