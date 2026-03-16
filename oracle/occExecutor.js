/**
 * occExecutor.js — OCC 批次執行器（輕量版）
 *
 * Oracle 層只負責：
 *  1. 收集 OrderRevealed 事件
 *  2. 在批次視窗結束後，帶有序序列呼叫 AI Agent
 *  3. 把 AI 結果帶回合約執行
 *
 * 排序邏輯已在合約層完成（seqNo），此處只按 seqNo 排列後送 AI。
 */
const { askClaudeConflict } = require("./aiConflictAgent");

const BATCH_WINDOW_MS = 300;

class OccExecutor {
  constructor() {
    this.pendingBatch = [];
    this.batchTimer   = null;
    this.onCommit     = null; // async (tx) => void
    this.onAbort      = null; // async (tx, note) => void
  }

  submit(tx) {
    this.pendingBatch.push({ ...tx, submittedAt: Date.now() });
    console.log(`[OCC] submit seqNo=${tx.seqNo} dir=${tx.srcChainId}→${tx.targetChainId}`);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => this._runValidation(), BATCH_WINDOW_MS);
  }

  async _runValidation() {
    if (this.pendingBatch.length === 0) return;
    const batch = this.pendingBatch.slice().sort((a, b) => Number(a.seqNo) - Number(b.seqNo));
    this.pendingBatch = [];
    this.batchTimer   = null;

    console.log(`[OCC] === Validation Phase: ${batch.length} tx(s) ===`);

    let commits = batch.map(t => t.requestId);
    let aborts  = {};

    if (batch.length > 1) {
      try {
        // 送給 AI Agent 的序列已按 seqNo 排好（合約層確定性排序）
        const result = await askClaudeConflict(batch);
        commits = result.commits;
        result.aborts.forEach(a => { aborts[a.requestId] = a.note; });
      } catch (err) {
        console.error("[OCC] AI Agent error:", err.message);
        // AI 失敗時保守處理：全部 commit（OCC 版本驗證作為最後防線）
      }
    }

    for (const tx of batch) {
      if (aborts[tx.requestId]) {
        console.log(`[OCC] ABORT seqNo=${tx.seqNo} | ${aborts[tx.requestId]}`);
        if (this.onAbort) await this.onAbort(tx, aborts[tx.requestId]).catch(e => console.error("[OCC] abort error:", e.message));
      } else {
        console.log(`[OCC] COMMIT seqNo=${tx.seqNo}`);
        if (this.onCommit) await this.onCommit(tx).catch(e => console.error("[OCC] commit error:", e.message));
      }
    }

    console.log(`[OCC] === Validation Phase complete ===`);
  }
}

module.exports = OccExecutor;
