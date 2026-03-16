/**
 * deploy.js — 部署兩條鏈的 BridgeNode，並互相設定 peer
 * 用法：npx hardhat run scripts/deploy.js
 */
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

  const provA  = new ethers.JsonRpcProvider(CHAIN_A_URL);
  const provB  = new ethers.JsonRpcProvider(CHAIN_B_URL);
  // Hardhat node 永遠回傳 31337，兩條鏈會衝突
  // 改用邏輯 ID（port 號）作為合約內部的 chainId 識別碼
  const netIdA = "8545";
  const netIdB = "8546";
  console.log(`[Deploy] Chain A logicalId: ${netIdA}`);
  console.log(`[Deploy] Chain B logicalId: ${netIdB}`);

  // Oracle 用各鏈的 account[0]
  const signerA    = await provA.getSigner();
  const signerB    = await provB.getSigner();
  const oracleAddrA = await signerA.getAddress();
  const oracleAddrB = await signerB.getAddress();

  // 部署兩條鏈的 BridgeNode
  const resultA = await deployBridgeNode(CHAIN_A_URL, netIdA, oracleAddrA);
  const resultB = await deployBridgeNode(CHAIN_B_URL, netIdB, oracleAddrB);

  // 互相設定 peer（讓兩個 BridgeNode 認識對方）
  console.log("\n[Deploy] Setting peer nodes...");
  const contractA = new ethers.Contract(resultA.address, resultA.abi, resultA.signer);
  const contractB = new ethers.Contract(resultB.address, resultB.abi, resultB.signer);

  await (await contractA.setPeerNode(netIdB, resultB.address)).wait();
  console.log(`[Deploy] Chain A knows Chain B: ${resultB.address}`);

  await (await contractB.setPeerNode(netIdA, resultA.address)).wait();
  console.log(`[Deploy] Chain B knows Chain A: ${resultA.address}`);

  // 預存 100 ETH 到兩個 BridgeNode（雙向都需要流動性）
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

  // 儲存 build artifact（兩條鏈同一份 ABI，不同地址）
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
