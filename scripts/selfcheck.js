#!/usr/bin/env node
/**
 * 连接自检（真实配置，不做写操作）
 * ---------------------------------------------------------------
 * 启动 MCP server → initialize → tools/list → db_connections →
 * 对 default 连接跑 SELECT 1（--all 时对每个连接都跑，只读）。
 *
 * 用法：
 *   node scripts/selfcheck.js                 # 用本仓库 server.js
 *   node scripts/selfcheck.js --all           # 所有连接都探活
 *   node scripts/selfcheck.js --server <js>   # 指定 server（例如 DSH 的 shim）
 */
const { spawn } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const all = args.includes("--all");
const server = path.resolve(argVal("--server") || path.join(__dirname, "..", "server.js"));

const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let seq = 1;
const pending = new Map();

function call(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error("timeout: " + method))), 60000);
  });
}

child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      p.resolve(m);
    }
  }
});
child.stderr.on("data", (c) => { const s = c.toString("utf8").trim(); if (s) console.error("[server] " + s.slice(0, 300)); });
child.on("exit", (code) => { if (code && code !== 0) console.error("server 退出码 " + code); });

const callTool = (name, args) => call("tools/call", { name, arguments: args || {} });

const text = (r) => (r.result && r.result.content ? r.result.content.map((c) => c.text).join("\n") : JSON.stringify(r.error || r.result));

(async () => {
  let failed = 0;
  const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selfcheck", version: "1" } });
  console.log("initialize: " + (init.result ? "OK" : "FAIL"));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  const tools = await call("tools/list", {});
  const names = (tools.result && tools.result.tools || []).map((t) => t.name);
  console.log("tools/list: " + names.length + " 个（" + names.join(", ") + "）");

  const conns = text(await callTool("db_connections"));
  console.log("db_connections:\n" + conns.split("\n").map((l) => "  " + l).join("\n"));

  if (all) {
    const rows = [...conns.matchAll(/^- ([^:\n]+):/gm)].map((m) => m[1]);
    for (const name of rows) {
      const r = await callTool("db_query", { connection: name, sql: "SELECT 1 AS ok" });
      const ok = !r.result?.isError && /(^|\D)1(\D|$)/.test(text(r));
      console.log((ok ? "  ✓ " : "  ✗ ") + name);
      if (!ok) failed++;
    }
  } else {
    const r = await callTool("db_query", { connection: "default", sql: "SELECT 1 AS ok" });
    const ok = !r.result?.isError && /(^|\D)1(\D|$)/.test(text(r));
    console.log((ok ? "default SELECT 1: ✓" : "default SELECT 1: ✗ " + text(r).slice(0, 200)));
    if (!ok) failed++;
  }

  console.log(failed ? "自检：FAIL " + failed : "自检：PASS");
  child.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("自检异常：" + e.message); child.kill(); process.exit(1); });
