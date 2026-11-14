#!/usr/bin/env node
/**
 * 打包冒烟：npm pack → 安装到临时目录 → 启动 server → tools/list 必须含 6 个工具。
 * 验证发布物完整可用（files 字段、jar、依赖），不依赖源码目录。
 * 用法：node test/pack-smoke.js   （需要网络安装依赖）
 */
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const root = path.join(__dirname, "..");
const tmp = path.join(os.tmpdir(), "jmg-pack-" + process.pid);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, "app"), { recursive: true });

function run(cmd, args, opts) {
  // Windows 上 npm 是 .cmd，Node 20+ 必须经 shell 才能执行
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 300000, windowsHide: true, shell: process.platform === "win32", ...opts });
}

function waitForTools(server, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [server], { env: { ...process.env, JMG_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, reason: "timeout" }); }, 30000);
    child.stdout.on("data", (c) => {
      buf += c.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && m.result) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        }
        if (m.id === 2 && m.result) {
          const names = (m.result.tools || []).map((t) => t.name);
          const want = ["db_query", "db_execute", "db_connections", "db_dialects", "db_schema", "db_search_columns"];
          const missing = want.filter((n) => !names.includes(n));
          clearTimeout(timer);
          child.kill();
          resolve({ ok: missing.length === 0, reason: missing.length ? "missing: " + missing.join(",") : "", names });
        }
      }
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, reason: String(e.message) }); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pack-smoke", version: "1" } } }) + "\n");
  });
}

(async () => {
  try {
    const out = run(NPM, ["pack", "--pack-destination", tmp], { cwd: root });
    const name = out.trim().split("\n").filter(Boolean).pop().trim();
    const tgz = path.join(tmp, name);
    if (!fs.existsSync(tgz)) throw new Error("npm pack 未生成 tgz");
    console.log("packed: " + name);

    run(NPM, ["install", tgz, "--no-audit", "--no-fund"], { cwd: path.join(tmp, "app"), stdio: "pipe" });
    const server = path.join(tmp, "app", "node_modules", "jdbc-mcp-guard", "server.js");
    if (!fs.existsSync(server)) throw new Error("安装后找不到 server.js");

    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, "connections"), { recursive: true });
    const res = await waitForTools(server, home);
    if (!res.ok) { console.error("包冒烟失败：" + (res.reason || "tools/list 不完整")); process.exit(1); }
    console.log("包冒烟通过：6 个工具齐全（" + (res.names || []).join(", ") + "）");
  } catch (e) {
    console.error("包冒烟失败：" + String((e.stderr || e.message || e)).slice(0, 600));
    process.exit(1);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  }
})();
