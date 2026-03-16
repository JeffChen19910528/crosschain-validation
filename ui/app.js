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

  const isAB     = dir === "AB";
  const srcWeb3  = isAB ? web3A : web3B;
  const srcContract = isAB ? nodeAContract : nodeBContract;

  // 使用邏輯 ID（與 deploy.js 一致），不讀 eth_chainId
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
    // Phase 1: Commit
    setStatus("pending", '<span class="spinner"></span> Phase 1: 送出 Commit（隱藏金額）...');
    const tx1 = await srcContract.methods
      .commitOrder(blindedAmount, recipient, dstChainId)
      .send({ from: sender, value: amount, gas: 200000 });

    const requestId = tx1.events?.OrderCommitted?.returnValues?.requestId;
    setStatus("pending", `<span class="spinner"></span> Phase 2: Reveal 金額（requestId: ${requestId?.slice(0,10)}...）`);

    // Phase 2: Reveal（自動執行）
    const tx2 = await srcContract.methods
      .revealOrder(requestId, amount, salt)
      .send({ from: sender, gas: 200000 });

    const seqNo   = tx2.events?.OrderRevealed?.returnValues?.seqNo;
    const latency = Date.now() - t0;

    txHistory.unshift({
      index: txHistory.length + 1,
      dir: dir,
      seqNo: seqNo?.toString() || "—",
      status: "pending", // 等待 Oracle Phase 3
      sender, recipient, amount: amountEth,
      txHash: tx2.transactionHash,
      timestamp: new Date().toLocaleString("zh-TW"),
      latency, requestId,
    });

    setStatus("success", `Phase 1+2 完成！SeqNo=${seqNo} | 等待 Oracle Phase 3 驗證...`);
    renderTable();

    // 訂閱 Phase 3 結果（OrderExecuted 或 OrderAborted）
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
        renderTable(); refreshAll();
        clearInterval(checkInterval);
      } else if (rec.aborted) {
        entry.status = "abort";
        setStatus("abort", `Phase 3：SeqNo=${seqNo} 被 Abort（AI Agent 判定衝突或 Version 衝突）`);
        renderTable(); refreshAll();
        clearInterval(checkInterval);
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
