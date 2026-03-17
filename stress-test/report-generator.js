const ExcelJS = require("exceljs");
const dayjs   = require("dayjs");
const path    = require("path");
const fs      = require("fs");

class ReportGenerator {
  async generate(results, summary) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "AO4C CrossChain Lab";
    workbook.created = new Date();

    // Sheet 1: 摘要
    const s1 = workbook.addWorksheet("摘要 Summary");
    s1.columns = [{ header: "項目", key: "key", width: 35 }, { header: "數值", key: "value", width: 30 }];
    s1.addRows([
      { key: "演算法",                     value: "AO4C (AI-Augmented OCC)" },
      { key: "測試開始時間",               value: dayjs().format("YYYY-MM-DD HH:mm:ss") },
      { key: "測試持續時間 (秒)",          value: (summary.durationMs / 1000).toFixed(2) },
      { key: "最大併發數",                 value: summary.concurrency },
      { key: "每筆交易金額 (ETH)",         value: summary.amountEth },
      { key: "總發送交易數",               value: summary.totalTx },
      { key: "Phase1+2 成功數",            value: summary.success },
      { key: "失敗數",                     value: summary.fail },
      { key: "OCC Abort 數（AI判定衝突）", value: summary.occAbort || 0 },
      { key: "Phase1+2 成功率 (%)",        value: ((summary.success / summary.totalTx) * 100).toFixed(2) },
      { key: "平均吞吐量 TPS (Phase1+2)",  value: summary.tps },
      { key: "平均延遲 (ms)",              value: this._avg(results) },
      { key: "P50 延遲 (ms)",              value: this._pct(results, 50) },
      { key: "P95 延遲 (ms)",              value: this._pct(results, 95) },
      { key: "P99 延遲 (ms)",              value: this._pct(results, 99) },
    ]);
    this._styleHeader(s1);

    // Sheet 2: 交易明細
    const s2 = workbook.addWorksheet("交易明細 Detail");
    s2.columns = [
      { header: "#",           key: "index",     width: 8  },
      { header: "方向",        key: "direction", width: 8  },
      { header: "SeqNo",       key: "seqNo",     width: 10 },
      { header: "時間戳",      key: "timestamp", width: 26 },
      { header: "狀態",        key: "status",    width: 12 },
      { header: "Gas (Gwei)",  key: "gasGwei",   width: 14 },
      { header: "發送地址",    key: "sender",    width: 44 },
      { header: "接收地址",    key: "recipient", width: 44 },
      { header: "金額 ETH",    key: "amount",    width: 14 },
      { header: "延遲 ms",     key: "latency",   width: 12 },
      { header: "TxHash",      key: "txHash",    width: 68 },
      { header: "錯誤訊息",    key: "error",     width: 50 },
    ];
    results.forEach(r => s2.addRow(r));
    this._styleHeader(s2);
    s2.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const st = row.getCell("status").value;
      const color = st === "revealed" ? "FF90EE90" : st === "abort" ? "FFFFA500" : "FFFF6B6B";
      row.getCell("status").fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    });

    // Sheet 3: 每秒 TPS
    const s3 = workbook.addWorksheet("每秒 TPS");
    s3.columns = [
      { header: "經過秒數",       key: "second",  width: 12 },
      { header: "時間戳",         key: "clock",   width: 12 },
      { header: "成功 TPS",       key: "tps",     width: 14 },
      { header: "總交易",         key: "total",   width: 12 },
      { header: "失敗",           key: "failed",  width: 10 },
    ];
    this._tpsBySecond(results).forEach(r => s3.addRow(r));
    this._styleHeader(s3);

    // Sheet 4: 每分鐘 TPS（折線圖用）
    const s4 = workbook.addWorksheet("每分鐘 TPS（折線圖）");
    s4.columns = [
      { header: "經過分鐘",           key: "minute",       width: 12 },
      { header: "時間戳",             key: "clock",        width: 12 },
      { header: "成功交易數",         key: "success",      width: 14 },
      { header: "失敗交易數",         key: "failed",       width: 14 },
      { header: "總交易數",           key: "total",        width: 12 },
      { header: "平均 TPS（該分鐘）", key: "avgTps",       width: 18 },
      { header: "累計成功",           key: "cumSuccess",   width: 14 },
      { header: "累計總量",           key: "cumTotal",     width: 12 },
      { header: "累計 TPS",           key: "cumTps",       width: 12 },
      { header: "Gas 最小 (Gwei)",    key: "minGas",       width: 16 },
      { header: "Gas 最大 (Gwei)",    key: "maxGas",       width: 16 },
      { header: "Gas 平均 (Gwei)",    key: "avgGas",       width: 16 },
    ];
    this._tpsByMinute(results).forEach(r => s4.addRow(r));
    this._styleHeader(s4);
    s4.getRow(1).height = 22;
    const noteRow = s4.addRow({ minute: "※ 折線圖建議", clock: "選取「時間戳」+「平均TPS」欄位插入折線圖" });
    noteRow.font = { italic: true, color: { argb: "FF888888" } };

    // Sheet 5: 方向統計
    const s5 = workbook.addWorksheet("方向統計 Direction");
    s5.columns = [
      { header: "方向",   key: "dir",   width: 10 },
      { header: "數量",   key: "count", width: 10 },
      { header: "成功",   key: "ok",    width: 10 },
      { header: "成功率", key: "rate",  width: 10 },
    ];
    const dirs = {};
    results.forEach(r => {
      if (!dirs[r.direction]) dirs[r.direction] = { count: 0, ok: 0 };
      dirs[r.direction].count++;
      if (r.status === "revealed") dirs[r.direction].ok++;
    });
    Object.entries(dirs).forEach(([dir, v]) => s5.addRow({
      dir, count: v.count, ok: v.ok,
      rate: ((v.ok / v.count) * 100).toFixed(2) + "%",
    }));
    this._styleHeader(s5);

    fs.mkdirSync(summary.reportDir, { recursive: true });
    const filename = `ao4c-report-${dayjs().format("YYYYMMDD-HHmmss")}.xlsx`;
    const filepath = path.join(summary.reportDir, filename);
    await workbook.xlsx.writeFile(filepath);
    console.log(`[Report] Excel saved: ${filepath}`);
    return filepath;
  }

  _avg(results) {
    const ok = results.filter(r => r.status === "revealed");
    return ok.length ? Math.round(ok.reduce((s, r) => s + r.latency, 0) / ok.length) : 0;
  }
  _pct(results, p) {
    const ok = results.filter(r => r.status === "revealed").map(r => r.latency).sort((a, b) => a - b);
    return ok.length ? ok[Math.max(0, Math.ceil((p / 100) * ok.length) - 1)] : 0;
  }

  _tpsBySecond(results) {
    if (!results.length) return [];
    const t0 = new Date(results[0].timestamp).getTime();
    const buckets = {};
    results.forEach(r => {
      const sec = Math.floor((new Date(r.timestamp).getTime() - t0) / 1000);
      if (!buckets[sec]) buckets[sec] = { total: 0, success: 0, failed: 0 };
      buckets[sec].total++;
      if (r.status === "revealed") buckets[sec].success++;
      else buckets[sec].failed++;
    });
    return Object.entries(buckets).sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([sec, v]) => ({
        second:  parseInt(sec),
        clock:   this._secToHms(parseInt(sec)),
        tps:     v.success,
        total:   v.total,
        failed:  v.failed,
      }));
  }

  _tpsByMinute(results) {
    if (!results.length) return [];
    const t0 = new Date(results[0].timestamp).getTime();
    const buckets = {};
    results.forEach(r => {
      const min = Math.floor((new Date(r.timestamp).getTime() - t0) / 60000);
      if (!buckets[min]) buckets[min] = { total: 0, success: 0, failed: 0, gasValues: [] };
      buckets[min].total++;
      if (r.status === "revealed") buckets[min].success++;
      else buckets[min].failed++;
      if (r.gasGwei != null) buckets[min].gasValues.push(r.gasGwei);
    });

    let cumSuccess = 0, cumTotal = 0;
    return Object.entries(buckets).sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([min, v]) => {
        cumSuccess += v.success;
        cumTotal   += v.total;
        const elapsed = (parseInt(min) + 1) * 60;
        const gasVals = v.gasValues;
        const minGas  = gasVals.length ? Math.min(...gasVals) : "—";
        const maxGas  = gasVals.length ? Math.max(...gasVals) : "—";
        const avgGas  = gasVals.length ? (gasVals.reduce((s, g) => s + g, 0) / gasVals.length).toFixed(1) : "—";
        return {
          minute:     parseInt(min) + 1,
          clock:      `${String(parseInt(min)).padStart(2,"0")}:00`,
          success:    v.success,
          failed:     v.failed,
          total:      v.total,
          avgTps:     (v.success / 60).toFixed(3),
          cumSuccess,
          cumTotal,
          cumTps:     (cumSuccess / elapsed).toFixed(3),
          minGas,
          maxGas,
          avgGas,
        };
      });
  }

  _secToHms(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }

  _styleHeader(sheet) {
    sheet.getRow(1).eachCell(cell => {
      cell.font  = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F8A" } };
      cell.alignment = { horizontal: "center" };
    });
    sheet.getRow(1).height = 20;
  }
}

module.exports = ReportGenerator;
