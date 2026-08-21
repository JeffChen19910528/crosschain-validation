/**
 * lib/chains.js — 雙鏈共用設定（單一事實來源）
 *
 * 之前 chainId、RPC URL、build artifact 路徑分散寫死在
 * oracle.js / deploy.js / sender.js / tod-test.js / monitor.js 五個地方，
 * 修改一處容易漏改其他處。統一由此模組提供。
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Hardhat node 兩條鏈的 eth_chainId 永遠回傳 31337，會互相衝突，
// 因此改用各自的 RPC port 當作合約內部識別用的「邏輯 chainId」。
const CHAINS = {
  A: {
    label: "A",
    chainId: "8545",
    rpcUrl: process.env.CHAIN_A_URL || "http://127.0.0.1:8545",
    buildPath: path.join(ROOT, "build/chainA/BridgeNode.json"),
  },
  B: {
    label: "B",
    chainId: "8546",
    rpcUrl: process.env.CHAIN_B_URL || "http://127.0.0.1:8546",
    buildPath: path.join(ROOT, "build/chainB/BridgeNode.json"),
  },
};

function otherLabel(label) {
  return label === "A" ? "B" : "A";
}

function wsUrl(rpcUrl) {
  return rpcUrl.replace(/^http/, "ws");
}

module.exports = { ROOT, CHAINS, otherLabel, wsUrl };
