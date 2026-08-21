const { expect } = require("chai");
const { ethers } = require("hardhat");

const CHAIN_A_ID = 1001;
const CHAIN_B_ID = 1002;

async function makeBlindedAmount(amount, salt) {
  return ethers.solidityPackedKeccak256(["uint256", "bytes32"], [amount, salt]);
}

describe("BridgeNode (AO4C)", function () {
  let nodeA, nodeB, owner, oracle, alice, bob, carol;

  beforeEach(async function () {
    [owner, oracle, alice, bob, carol] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("BridgeNode");
    nodeA = await Factory.deploy(CHAIN_A_ID, oracle.address);
    nodeB = await Factory.deploy(CHAIN_B_ID, oracle.address);
    await nodeA.waitForDeployment();
    await nodeB.waitForDeployment();

    await nodeA.setPeerNode(CHAIN_B_ID, await nodeB.getAddress());
    await nodeB.setPeerNode(CHAIN_A_ID, await nodeA.getAddress());

    await owner.sendTransaction({ to: await nodeA.getAddress(), value: ethers.parseEther("10") });
    await owner.sendTransaction({ to: await nodeB.getAddress(), value: ethers.parseEther("10") });
  });

  async function commitAndReveal(node, signer, amountEth, recipient, targetChainId) {
    const amount = ethers.parseEther(amountEth);
    const salt   = ethers.hexlify(ethers.randomBytes(32));
    const blindedAmount = await makeBlindedAmount(amount, salt);

    const commitTx = await node.connect(signer).commitOrder(blindedAmount, recipient, targetChainId, { value: amount });
    const commitReceipt = await commitTx.wait();
    const committedEvent = commitReceipt.logs
      .map(l => { try { return node.interface.parseLog(l); } catch { return null; } })
      .find(e => e && e.name === "OrderCommitted");
    const requestId = committedEvent.args.requestId;

    const revealTx = await node.connect(signer).revealOrder(requestId, amount, salt);
    const revealReceipt = await revealTx.wait();
    const revealedEvent = revealReceipt.logs
      .map(l => { try { return node.interface.parseLog(l); } catch { return null; } })
      .find(e => e && e.name === "OrderRevealed");

    return { requestId, amount, salt, seqNo: revealedEvent.args.seqNo, readVersion: revealedEvent.args.readVersion };
  }

  describe("Phase 1+2: commit → reveal", function () {
    it("assigns strictly increasing seqNo in call order (TOD protection)", async function () {
      const tx1 = await commitAndReveal(nodeA, alice, "0.01", bob.address, CHAIN_B_ID);
      const tx2 = await commitAndReveal(nodeA, bob,   "0.02", alice.address, CHAIN_B_ID);
      const tx3 = await commitAndReveal(nodeA, carol, "0.03", bob.address, CHAIN_B_ID);

      expect(tx1.seqNo).to.equal(0n);
      expect(tx2.seqNo).to.equal(1n);
      expect(tx3.seqNo).to.equal(2n);
    });

    it("rejects reveal with wrong amount/salt (front-running protection)", async function () {
      const amount = ethers.parseEther("0.01");
      const salt   = ethers.hexlify(ethers.randomBytes(32));
      const blindedAmount = await makeBlindedAmount(amount, salt);

      const commitTx = await nodeA.connect(alice).commitOrder(blindedAmount, bob.address, CHAIN_B_ID, { value: amount });
      const receipt  = await commitTx.wait();
      const requestId = receipt.logs
        .map(l => { try { return nodeA.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "OrderCommitted").args.requestId;

      const wrongAmount = ethers.parseEther("0.02");
      await expect(nodeA.connect(alice).revealOrder(requestId, wrongAmount, salt))
        .to.be.revertedWith("Hash mismatch: invalid amount or salt");
    });

    it("rejects reveal from a different sender than the committer", async function () {
      const amount = ethers.parseEther("0.01");
      const salt   = ethers.hexlify(ethers.randomBytes(32));
      const blindedAmount = await makeBlindedAmount(amount, salt);

      const commitTx = await nodeA.connect(alice).commitOrder(blindedAmount, bob.address, CHAIN_B_ID, { value: amount });
      const receipt  = await commitTx.wait();
      const requestId = receipt.logs
        .map(l => { try { return nodeA.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "OrderCommitted").args.requestId;

      await expect(nodeA.connect(bob).revealOrder(requestId, amount, salt))
        .to.be.revertedWith("Not your request");
    });

    it("rejects double reveal", async function () {
      const { requestId, amount, salt } = await commitAndReveal(nodeA, alice, "0.01", bob.address, CHAIN_B_ID);
      await expect(nodeA.connect(alice).revealOrder(requestId, amount, salt))
        .to.be.revertedWith("Already revealed");
    });
  });

  describe("Phase 3: validateAndExecute (oracle-driven)", function () {
    it("commits and increments globalVersion when the oracle reports no conflict", async function () {
      const { requestId, readVersion } = await commitAndReveal(nodeA, alice, "0.01", bob.address, CHAIN_B_ID);

      await expect(nodeA.connect(oracle).validateAndExecute(requestId, false, "no conflict", readVersion))
        .to.emit(nodeA, "OrderExecuted");

      expect(await nodeA.globalVersion()).to.equal(1n);
      const rec = await nodeA.getRecord(requestId);
      expect(rec.executed).to.equal(true);
    });

    it("aborts and refunds the sender when the oracle reports a conflict", async function () {
      const { requestId, readVersion } = await commitAndReveal(nodeA, alice, "0.01", bob.address, CHAIN_B_ID);
      const balBefore = await ethers.provider.getBalance(alice.address);

      await expect(nodeA.connect(oracle).validateAndExecute(requestId, true, "double spend", readVersion))
        .to.emit(nodeA, "OrderAborted");

      const balAfter = await ethers.provider.getBalance(alice.address);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.01"));
      const rec = await nodeA.getRecord(requestId);
      expect(rec.aborted).to.equal(true);
    });

    it("aborts on stale expectedVersion even when the oracle reports no conflict (OCC last line of defense)", async function () {
      const tx1 = await commitAndReveal(nodeA, alice, "0.01", bob.address, CHAIN_B_ID);
      const tx2 = await commitAndReveal(nodeA, bob,   "0.01", alice.address, CHAIN_B_ID);

      // tx1 commits first and bumps globalVersion, invalidating tx2's stale readVersion snapshot.
      await nodeA.connect(oracle).validateAndExecute(tx1.requestId, false, "no conflict", tx1.readVersion);

      await expect(nodeA.connect(oracle).validateAndExecute(tx2.requestId, false, "no conflict", tx2.readVersion))
        .to.emit(nodeA, "OrderAborted");

      const rec = await nodeA.getRecord(tx2.requestId);
      expect(rec.aborted).to.equal(true);
    });

    it("rejects validateAndExecute from a non-oracle caller", async function () {
      const { requestId, readVersion } = await commitAndReveal(nodeA, alice, "0.01", bob.address, CHAIN_B_ID);
      await expect(nodeA.connect(alice).validateAndExecute(requestId, false, "no conflict", readVersion))
        .to.be.revertedWith("Not oracle");
    });
  });

  describe("Cross-chain transfer", function () {
    it("transfers ETH to the recipient on the destination chain", async function () {
      const { requestId, amount } = await commitAndReveal(nodeA, alice, "0.01", bob.address, CHAIN_B_ID);
      const balBefore = await ethers.provider.getBalance(bob.address);

      await expect(nodeB.connect(oracle).executeTransfer(requestId, bob.address, amount, CHAIN_A_ID))
        .to.emit(nodeB, "OrderExecuted");

      const balAfter = await ethers.provider.getBalance(bob.address);
      expect(balAfter - balBefore).to.equal(amount);
    });

    it("rejects executeTransfer for an unknown source chain", async function () {
      await expect(nodeB.connect(oracle).executeTransfer(
        ethers.ZeroHash, bob.address, ethers.parseEther("0.01"), 9999
      )).to.be.revertedWith("Unknown source chain");
    });
  });
});
