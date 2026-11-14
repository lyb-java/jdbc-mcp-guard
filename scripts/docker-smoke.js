#!/usr/bin/env node
/**
 * Docker 冒烟：docker run -i 启动镜像 → initialize → tools/list 必须 6 个工具。
 * 用法：node scripts/docker-smoke.js [image]   （默认 jdbc-mcp-guard:0.2.0）
 */
const { spawn, execFileSync } = require("child_process");

const image = process.argv[2] || "jdbc-mcp-guard:0.2.0";
const DOCKER = process.env.DOCKER_BIN || "docker";

const child = spawn(DOCKER, ["run", "-i", "--rm", image], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let seq = 1;
const pending = new Map();

function call(method, params) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error("timeout " + method))), 30000);
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
    if (m.id && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); }
  }
});
child.stderr.on("data", (c) => { const s = c.toString("utf8").trim(); if (s) console.error("[docker] " + s.slice(0, 300)); });
child.on("error", (e) => { console.error("无法启动 docker：" + e.message); process.exit(1); });

(async () => {
  try {
    const init = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "docker-smoke", version: "1" } });
    if (!init.result) throw new Error("initialize 失败");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    const tools = await call("tools/list", {});
    const names = (tools.result && tools.result.tools || []).map((t) => t.name);
    const want = ["db_query", "db_execute", "db_connections", "db_dialects", "db_schema", "db_search_columns"];
    const missing = want.filter((n) => !names.includes(n));
    if (missing.length) throw new Error("缺少工具: " + missing.join(","));
    console.log("Docker 冒烟通过：" + image + " → " + names.length + " 个工具（" + names.join(", ") + "）");
    child.kill();
    process.exit(0);
  } catch (e) {
    console.error("Docker 冒烟失败：" + e.message);
    child.kill();
    process.exit(1);
  }
})();
