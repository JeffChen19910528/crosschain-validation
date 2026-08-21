/**
 * lib/statsUtils.js — Spearman 相關係數 / 排名 / Excel 表頭樣式
 *
 * 之前 report-generator.js、tod-report-generator.js、tod-test.js
 * 各自實作了一份幾乎一模一樣的 spearman / getRanks / 表頭樣式邏輯。
 */

function getRanks(arr, descending = false) {
  const nums = arr.map(Number);
  const sorted = [...nums].sort((a, b) => (descending ? b - a : a - b));
  return nums.map(v => sorted.indexOf(v) + 1);
}

function spearman(arrX, arrY) {
  const n = arrX.length;
  if (n < 2) return 0;
  const rankX = getRanks(arrX);
  const rankY = getRanks(arrY);
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rankX[i] - rankY[i];
    sumD2 += d * d;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

function styleHeader(sheet, color = "FF2C5F8A") {
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    cell.alignment = { horizontal: "center" };
  });
  sheet.getRow(1).height = 20;
}

module.exports = { getRanks, spearman, styleHeader };
