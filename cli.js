#!/usr/bin/env node
/**
 * jdbc-mcp-guard CLI —— 给没有 MCP 客户端的场景（只会 bash 的 agent / 人类终端）。
 * 复用 server.js 的同一套守卫、权限与审计；写操作默认预演，必须 --reason + --confirm YES 才提交。
 *
 * 退出码：0 成功；1 执行失败/被守卫拒绝；2 参数错误。
 */
const fs = require("fs");
const path = require("path");

// CLI 默认不启常驻 JVM：跑完即退出（需要常驻时设 JMG_NO_DAEMON=0）
if (process.env.JMG_NO_DAEMON === undefined) process.env.JMG_NO_DAEMON = "1";

const argv = process.argv.slice(2);

function usage() {
  const lines = [
    "jdbc-mcp-guard CLI",
    "",
    "  jdbc-mcp-guard                      启动 MCP stdio server",
    "  jdbc-mcp-guard connections          列出连接与写权限",
    '  jdbc-mcp-guard query --sql "..."    只读查询（--file <path> 从文件读）',
    "                  [--conn X]（别名 --connection） [--format table|json] [--max-rows 200] [--timeout 30]",
    '  jdbc-mcp-guard exec  --sql "..." --reason "..."   写操作（默认预演）',
    "                  [--conn X] [--confirm YES] [--max-affected 1000] [--timeout 120]",
    "",
    "环境变量：JMG_HOME（默认 ~/.jdbc-mcp-guard）、JMG_ACTOR、JMG_MAX_DAEMONS、JMG_SCHEMA_TTL_MS",
  ];
  console.log(lines.join("\n"));
}

function parseArgs(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith("--")) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

function fail(msg, code) {
  console.error("✗ " + msg);
  process.exit(code || 1);
}

function render(res) {
  const content = (res && res.content) || [];
  const text = content.map((c) => c.text || "").join("\n").trim();
  if (res && res.isError) fail(text || "执行失败");
  if (text) console.log(text);
}

(async () => {
  if (!argv.length) {
    const { run } = require("./server.js");
    await run();
    return;
  }

  const cmd = argv[0];
  const opts = parseArgs(argv.slice(1));

  if (cmd === "help" || cmd === "--help" || cmd === "-h") { usage(); return; }

  if (cmd === "connections" || cmd === "conns") {
    const { listConnections } = require("./server.js");
    const all = listConnections();
    if (!all.length) {
      console.log("没有连接。把配置放到 " + (process.env.JMG_HOME || "~/.jdbc-mcp-guard") + "/connections/<name>.json");
      return;
    }
    for (const c of all) {
      const perm = c.allowDestructive ? "⚠可写+DDL+破坏性" : c.allowDdl ? "⚠可写+DDL" : c.allowWrite ? "⚠可写" : "只读";
      const target = c.host ? c.host + ":" + c.port + "/" + (c.database || "") : (c.database || "");
      console.log(c.name + ": " + c.dialect + " " + target + " (user=" + (c.user || "?") + ") · " + perm);
    }
    return;
  }

  if (cmd !== "query" && cmd !== "exec") fail("未知子命令：" + cmd + "（用 help 看用法）", 2);

  let sql = typeof opts.sql === "string" ? opts.sql : "";
  if (!sql && typeof opts.file === "string") sql = fs.readFileSync(path.resolve(opts.file), "utf8");
  if (!sql || !sql.trim()) fail("缺少 --sql 或 --file", 2);
  const connection =
    typeof opts.conn === "string"
      ? opts.conn
      : typeof opts.connection === "string"
        ? opts.connection
        : "default";
  const allowed =
    cmd === "query"
      ? ["sql", "file", "conn", "connection", "format", "max-rows", "timeout"]
      : ["sql", "file", "conn", "connection", "reason", "confirm", "max-affected", "timeout"];
  const unknown = Object.keys(opts).filter((k) => k !== "_" && !allowed.includes(k));
  if (unknown.length)
    fail(
      "未知参数 " + unknown.map((k) => "--" + k).join(", ") + "；" + cmd + " 可用参数：" + allowed.map((k) => "--" + k).join(" "),
      2
    );

  if (cmd === "query") {
    const { runQuery } = require("./server.js");
    const res = await runQuery({
      sql: sql,
      connection: connection,
      format: opts.format === "json" ? "json" : "table",
      maxRows: opts["max-rows"] ? Number(opts["max-rows"]) : undefined,
      timeout: opts.timeout ? Number(opts.timeout) : undefined,
    });
    render(res);
    return;
  }

  const reason = typeof opts.reason === "string" ? opts.reason : "";
  if (!reason || reason.trim().length < 6) fail('写操作必须带 --reason "为什么要改"（≥6 字，会进审计）', 2);
  const { runWrite } = require("./server.js");
  const res = await runWrite({
    sql: sql,
    connection: connection,
    reason: reason,
    confirm: opts.confirm === "YES" ? "YES" : undefined,
    maxAffected: opts["max-affected"] ? Number(opts["max-affected"]) : undefined,
    timeout: opts.timeout ? Number(opts.timeout) : undefined,
  });
  render(res);
})().catch((e) => fail(e.message));
