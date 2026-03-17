/**
 * aiConflictAgent.js — Claude Code CLI AI 衝突驗證 Agent
 *
 * 接收已按 seqNo 排好序的交易批次（排序由合約層確定性決定）
 * 判斷在此順序下哪些交易有語意衝突
 * 回傳 { commits: [requestId,...], aborts: [{requestId, note},...] }
 *
 * 前提：
 *   npm install -g @anthropic-ai/claude-code
 *   claude  （完成登入）
 */
const { execFile }  = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 60000;

/**
 * @param {object[]} orderedBatch - 已按 seqNo 排序的交易陣列
 *   每筆包含 { requestId, sender, recipient, amount, seqNo, readVersion, srcChainId, targetChainId }
 * @returns {Promise<{ commits: string[], aborts: { requestId: string, note: string }[] }>}
 */
async function askClaudeConflict(orderedBatch) {
  const prompt = buildPrompt(orderedBatch);

  let stdout;
  try {
    const result = await execFileAsync(
      "claude",
      ["--output-format", "json", "-p", prompt],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 512 }
    );
    stdout = result.stdout;
  } catch (err) {
    throw new Error(`claude CLI failed: ${err.message}`);
  }

  return parseResponse(stdout, orderedBatch);
}

function buildPrompt(orderedBatch) {
  const batchSummary = orderedBatch.map(t => ({
    requestId:   t.requestId,
    seqNo:       t.seqNo.toString(),
    sender:      t.sender,
    recipient:   t.recipient,
    amount:      t.amount.toString(),
    readVersion: t.readVersion.toString(),
    direction:   `chain${t.srcChainId}→chain${t.targetChainId}`,
  }));

  return `You are a conflict validator for AO4C (AI-Augmented Optimistic Cross-Chain Concurrency Control).

The following transactions have been ORDERED by seqNo (determined by on-chain deterministic ordering, not miner ordering).
Analyze each transaction in sequence order and identify conflicts.

A CONFLICT exists if ANY of these conditions are true:
1. DOUBLE SPEND: Same sender submitting multiple transactions within the same readVersion window targeting the same or different recipients
2. DUPLICATE RELEASE: Same requestId appearing more than once
3. VERSION CONFLICT: A transaction's readVersion is stale relative to earlier transactions in this batch that would modify shared state
4. SEMANTIC CONFLICT: Transactions that together would violate cross-chain consistency (e.g., bidirectional transfers that create circular value flow exploits)

ORDERED transaction batch (process in seqNo order):
${JSON.stringify(batchSummary, null, 2)}

Respond ONLY with a JSON object. No explanation, no markdown, no extra text:
{
  "commits": ["requestId1", "requestId3"],
  "aborts": [
    { "requestId": "requestId2", "note": "<reason max 100 chars>" }
  ]
}

Rules:
- Every requestId must appear in exactly one of commits or aborts
- When a conflict involves two transactions, abort the LATER seqNo one (preserve earlier)
- If uncertain, commit (the on-chain version check is the final safeguard)`;
}

function parseResponse(stdout, orderedBatch) {
  const allIds = orderedBatch.map(t => t.requestId);

  let outerJson;
  try { outerJson = JSON.parse(stdout.trim()); } catch { return fallbackCommitAll(allIds); }

  const resultText = outerJson.result || outerJson.content || stdout;
  const cleaned    = resultText.replace(/```json|```/g, "").trim();

  let inner;
  try { inner = JSON.parse(cleaned); } catch { return fallbackCommitAll(allIds); }

  // 驗證所有 requestId 都在結果裡
  const commits = Array.isArray(inner.commits) ? inner.commits : [];
  const aborts  = Array.isArray(inner.aborts)  ? inner.aborts  : [];
  const mentioned = new Set([...commits, ...aborts.map(a => a.requestId)]);

  // 沒有被提到的 requestId 視為 commit
  allIds.forEach(id => { if (!mentioned.has(id)) commits.push(id); });

  return { commits, aborts };
}

function fallbackCommitAll(allIds) {
  return { commits: allIds, aborts: [] };
}

module.exports = { askClaudeConflict };
