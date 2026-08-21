const express = require("express");
const path    = require("path");
const http    = require("http");
const { CHAINS } = require("../lib/chains");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use("/build", express.static(path.join(__dirname, "../build")));

app.get("/web3.min.js", (req, res) => {
  res.sendFile(path.join(__dirname, "../node_modules/web3/dist/web3.min.js"));
});

function rpcProxy(targetPort) {
  return (req, res) => {
    const body    = JSON.stringify(req.body);
    const options = {
      hostname: "127.0.0.1", port: targetPort, path: "/", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode).set("Content-Type", "application/json");
      proxyRes.pipe(res);
    });
    proxyReq.on("error", err => res.status(502).json({ error: err.message }));
    proxyReq.write(body);
    proxyReq.end();
  };
}

app.post("/rpc/chainA", rpcProxy(new URL(CHAINS.A.rpcUrl).port));
app.post("/rpc/chainB", rpcProxy(new URL(CHAINS.B.rpcUrl).port));

// 提供邏輯 chainId 給前端，避免 A/B 的 chainId 在 app.js 中重複寫死
app.get("/api/chains", (req, res) => {
  res.json({ A: { chainId: CHAINS.A.chainId }, B: { chainId: CHAINS.B.chainId } });
});

app.listen(3000, () => {
  console.log("[UI] Server running at http://localhost:3000");
  console.log("[UI] RPC proxy: /rpc/chainA → :8545 | /rpc/chainB → :8546");
});
