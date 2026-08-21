/**
 * lib/contractArtifact.js — 讀取 Hardhat 部署後的 build artifact
 *
 * 之前這段「讀檔 → 取最新 network → 建立 web3 Contract」的邏輯
 * 在 oracle.js / monitor.js / sender.js / tod-test.js 各自複製了一份。
 */
const fs = require("fs");

function loadArtifact(buildPath) {
  const artifact = JSON.parse(fs.readFileSync(buildPath, "utf8"));
  const networkIds = Object.keys(artifact.networks);
  if (!networkIds.length) throw new Error(`No deployed network in ${buildPath}`);
  const address = artifact.networks[networkIds[networkIds.length - 1]].address;
  return { abi: artifact.abi, bytecode: artifact.bytecode, address };
}

function loadContract(web3, buildPath) {
  const { abi, address } = loadArtifact(buildPath);
  return { contract: new web3.eth.Contract(abi, address), address, abi };
}

module.exports = { loadArtifact, loadContract };
