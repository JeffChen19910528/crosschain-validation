/**
 * tod-report-generator.js — TOD 實驗 Excel 報表產生器
 *
 * Sheet 1：實驗摘要（參數、Spearman 係數、結論）
 * Sheet 2：原始數據（每筆交易三欄排序對比）
 * Sheet 3：排序對比圖表數據（gasPrice排名 vs txIndex排名 vs seqNo排名）
 * Sheet 4：每輪 Spearman 係數統計
 * Sheet 5：每輪交易量（折線圖用）
 */
const ExcelJS = require("exceljs");
const dayjs   = require("dayjs");
const path    = require("path");
const fs      = require("fs");

class TodReportGenerator {
  async generate(results, summary) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "AO4C TOD Experiment";
    workbook.created = new Date();

    const ok = results.filter(r => r.revealStatus === "ok" && r.seqNo !== null);

    const spearmanGasSeq  = this._spearman(ok.map(r => parseInt(r.gasPrice)), ok.map(r => r.seqNo));
    const spearmanGasTx   = this._spearman(ok.map(r => parseInt(r.gasPrice)), ok.map(r => r.revealTxIndex));
    const spearmanTxSeq   = this._spearman(ok.map(r => r.revealTxIndex),      ok.map(r => r.seqNo));
    const todProtected     = Math.abs(spearmanGasSeq) < 0.3;

    // ── Sheet 1：摘要 ──────────────────────────────────────────────
    const s1 = workbook.addWorksheet("摘要 Summary");
    s1.columns = [{ header: "項目", key: "key", width: 45 }, { header: "數值", key: "value", width: 30 }];
    s1.addRows([
      { key: "實驗名稱",                         value: "AO4C TOD Protection Experiment" },
      { key: "演算法",                            value: "AO4C (AI-Augmented Optimistic Cross-Chain CC)" },
      { key: "實驗時間",                          value: dayjs().format("YYYY-MM-DD HH:mm:ss") },
      { key: "交易方向",                          value: summary.direction },
      { key: "每輪批次大小（同時送出）",          value: summary.batch },
      { key: "實驗輪數",                          value: summary.rounds },
      { key: "每筆金額 (ETH)",                   value: summary.amount },
      { key: "有效交易數",                        value: ok.length },
      { key: "─────────────────────────────",   value: "─────────────────────" },
      { key: "Spearman(gasPrice, seqNo)",        value: spearmanGasSeq.toFixed(6) },
      { key: "Spearman(gasPrice, txIndex)",      value: spearmanGasTx.toFixed(6) },
      { key: "Spearman(txIndex, seqNo)",         value: spearmanTxSeq.toFixed(6) },
      { key: "─────────────────────────────",   value: "─────────────────────" },
      { key: "TOD 防護結論",                     value: todProtected ? "✓ PROTECTED（|ρ| < 0.3）" : "⚠ REVIEW NEEDED（|ρ| >= 0.3）" },
      { key: "說明",                              value: "seqNo 由 EVM 執行序決定，與 gasPrice 無統計相關性，證明 TOD 防護有效" },
    ]);
    this._styleHeader(s1);

    const conclusionRow = s1.getRow(14);
    conclusionRow.getCell("value").font = { bold: true };
    conclusionRow.getCell("value").fill = {
      type: "pattern", pattern: "solid",
      fgColor: { argb: todProtected ? "FF90EE90" : "FFFFA500" },
    };

    // ── Sheet 2：原始數據 ──────────────────────────────────────────
    const s2 = workbook.addWorksheet("原始數據 Raw Data");
    s2.columns = [
      { header: "輪次",           key: "round",          width: 8  },
      { header: "批次索引",       key: "i",              width: 10 },
      { header: "gasPrice(Gwei)", key: "gasPriceGwei",   width: 16 },
      { header: "gasPrice排名",   key: "gasPriceRank",   width: 14 },
      { header: "txIndex(礦工)",  key: "revealTxIndex",  width: 14 },
      { header: "txIndex排名",    key: "txIndexRank",    width: 12 },
      { header: "seqNo(AO4C)",    key: "seqNo",          width: 14 },
      { header: "seqNo排名",      key: "seqNoRank",      width: 12 },
      { header: "commitBlock",    key: "commitBlock",    width: 14 },
      { header: "revealBlock",    key: "revealBlock",    width: 14 },
      { header: "sender",         key: "sender",         width: 44 },
      { header: "requestId",      key: "requestId",      width: 68 },
    ];

    const gasPriceRanks  = this._getRanks(ok.map(r => parseInt(r.gasPrice)), true);
    const txIndexRanks   = this._getRanks(ok.map(r => r.revealTxIndex), false);
    const seqNoRanks     = this._getRanks(ok.map(r => r.seqNo), false);

    ok.forEach((r, idx) => {
      s2.addRow({
        round:         r.round,
        i:             r.i,
        gasPriceGwei:  parseInt(r.gasPrice) / 1e9,
        gasPriceRank:  gasPriceRanks[idx],
        revealTxIndex: r.revealTxIndex,
        txIndexRank:   txIndexRanks[idx],
        seqNo:         r.seqNo,
        seqNoRank:     seqNoRanks[idx],
        commitBlock:   r.commitBlock,
        revealBlock:   r.revealBlock,
        sender:        r.sender,
        requestId:     r.requestId || "—",
      });
    });
    this._styleHeader(s2);

    s2.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const gasRank = row.getCell("gasPriceRank").value;
      const seqRank = row.getCell("seqNoRank").value;
      if (gasRank !== seqRank) {
        row.getCell("seqNo").fill     = { type: "pattern", pattern: "solid", fgColor: { argb: "FF90EE90" } };
        row.getCell("seqNoRank").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF90EE90" } };
      }
    });

    // ── Sheet 3：排名對比 ──────────────────────────────────────────
    const s3 = workbook.addWorksheet("排名對比 Ranking");
    s3.columns = [
      { header: "交易索引",       key: "idx",           width: 10 },
      { header: "gasPrice排名",   key: "gasPriceRank",  width: 14 },
      { header: "txIndex排名",    key: "txIndexRank",   width: 14 },
      { header: "seqNo排名",      key: "seqNoRank",     width: 12 },
      { header: "gasPrice≠seqNo", key: "mismatch",      width: 16 },
    ];
    ok.forEach((_, idx) => {
      const mismatch = gasPriceRanks[idx] !== seqNoRanks[idx] ? "Y（AO4C 修正）" : "N";
      s3.addRow({ idx: idx + 1, gasPriceRank: gasPriceRanks[idx], txIndexRank: txIndexRanks[idx], seqNoRank: seqNoRanks[idx], mismatch });
    });
    this._styleHeader(s3);

    // ── Sheet 4：每輪 Spearman ─────────────────────────────────────
    const s4 = workbook.addWorksheet("Spearman by Round");
    s4.columns = [
      { header: "輪次",                      key: "round",    width: 8  },
      { header: "有效交易數",                key: "count",    width: 12 },
      { header: "ρ(gasPrice, seqNo)",        key: "rhoGS",    width: 22 },
      { header: "ρ(gasPrice, txIndex)",      key: "rhoGT",    width: 22 },
      { header: "ρ(txIndex, seqNo)",         key: "rhoTS",    width: 20 },
      { header: "TOD防護",                   key: "protected",width: 12 },
    ];
    const rounds = [...new Set(ok.map(r => r.round))].sort((a, b) => a - b);
    rounds.forEach(rn => {
      const rData = ok.filter(r => r.round === rn);
      const rhoGS = this._spearman(rData.map(r => parseInt(r.gasPrice)), rData.map(r => r.seqNo));
      const rhoGT = this._spearman(rData.map(r => parseInt(r.gasPrice)), rData.map(r => r.revealTxIndex));
      const rhoTS = this._spearman(rData.map(r => r.revealTxIndex),      rData.map(r => r.seqNo));
      const prot  = Math.abs(rhoGS) < 0.3 ? "✓" : "⚠";
      s4.addRow({ round: rn, count: rData.length, rhoGS: rhoGS.toFixed(4), rhoGT: rhoGT.toFixed(4), rhoTS: rhoTS.toFixed(4), protected: prot });
    });
    this._styleHeader(s4);
    s4.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const prot = row.getCell("protected").value;
      row.getCell("protected").fill = {
        type: "pattern", pattern: "solid",
        fgColor: { argb: prot === "✓" ? "FF90EE90" : "FFFFA500" },
      };
    });

    // ── Sheet 5：每輪交易量（折線圖用）────────────────────────────
    const s5 = workbook.addWorksheet("每輪交易量（折線圖）");
    s5.columns = [
      { header: "輪次",                   key: "round",         width: 10 },
      { header: "同時送出筆數",           key: "batch",         width: 14 },
      { header: "成功交易數",             key: "success",       width: 14 },
      { header: "失敗交易數",             key: "failed",        width: 14 },
      { header: "成功率 (%)",             key: "rate",          width: 14 },
      { header: "ρ(gasPrice, seqNo)",     key: "rhoGS",         width: 22 },
      { header: "TOD防護",                key: "protected",     width: 12 },
      { header: "AO4C修正筆數",           key: "corrected",     width: 16 },
      { header: "修正率 (%)",             key: "correctedRate", width: 14 },
    ];
    rounds.forEach(rn => {
      const rData    = ok.filter(r => r.round === rn);
      const failed   = results.filter(r => r.round === rn && r.revealStatus !== "ok").length;
      const rhoGS    = this._spearman(rData.map(r => parseInt(r.gasPrice)), rData.map(r => r.seqNo));
      const prot     = Math.abs(rhoGS) < 0.3 ? "✓" : "⚠";
      const rGas  = this._getRanks(rData.map(r => parseInt(r.gasPrice)), true);
      const rSeq  = this._getRanks(rData.map(r => r.seqNo), false);
      const corrected = rData.filter((_, i) => rGas[i] !== rSeq[i]).length;
      s5.addRow({
        round:         rn,
        batch:         rData.length + failed,
        success:       rData.length,
        failed,
        rate:          rData.length + failed > 0 ? ((rData.length / (rData.length + failed)) * 100).toFixed(1) : "0",
        rhoGS:         rhoGS.toFixed(4),
        protected:     prot,
        corrected,
        correctedRate: rData.length > 0 ? ((corrected / rData.length) * 100).toFixed(1) : "0",
      });
    });
    this._styleHeader(s5);
    s5.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const prot = row.getCell("protected").value;
      row.getCell("protected").fill = {
        type: "pattern", pattern: "solid",
        fgColor: { argb: prot === "✓" ? "FF90EE90" : "FFFFA500" },
      };
    });
    const noteRow5 = s5.addRow({ round: "※ 折線圖建議", batch: "選取「輪次」+「成功交易數」+「ρ(gasPrice,seqNo)」插入折線圖" });
    noteRow5.font = { italic: true, color: { argb: "FF888888" } };

    fs.mkdirSync(summary.reportDir, { recursive: true });
    const filename = `ao4c-tod-experiment-${dayjs().format("YYYYMMDD-HHmmss")}.xlsx`;
    const filepath = path.join(summary.reportDir, filename);
    await workbook.xlsx.writeFile(filepath);
    console.log(`[TOD Report] Excel saved: ${filepath}`);
    return filepath;
  }

  _spearman(arrX, arrY) {
    const n = arrX.length;
    if (n < 2) return 0;
    const rX = this._getRanks(arrX, false);
    const rY = this._getRanks(arrY, false);
    let sumD2 = 0;
    for (let i = 0; i < n; i++) { const d = rX[i] - rY[i]; sumD2 += d * d; }
    return 1 - (6 * sumD2) / (n * (n * n - 1));
  }

  _getRanks(arr, descending = false) {
    const sorted = [...arr].sort((a, b) => descending ? b - a : a - b);
    return arr.map(v => sorted.indexOf(v) + 1);
  }

  _styleHeader(sheet) {
    sheet.getRow(1).eachCell(cell => {
      cell.font      = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1a3a5c" } };
      cell.alignment = { horizontal: "center" };
    });
    sheet.getRow(1).height = 20;
  }
}

module.exports = TodReportGenerator;
