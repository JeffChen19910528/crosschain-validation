/**
 * lib/cliArgs.js — 極簡 `--key value` 參數解析
 *
 * 之前 sender.js / tod-test.js 各自複製了一份一樣的 parseArgs。
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

module.exports = { parseArgs };
