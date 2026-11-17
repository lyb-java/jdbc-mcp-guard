#!/usr/bin/env node
/**
 * CLI 冒烟（离线 SQLite）：query / exec 守卫 / connections。
 * 用法：node test/cli.js   （首次会准备 SQLite 驱动；只跑临时目录，不碰真实配置）
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "cli.js");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jmg-cli-"));
const CONN = path.join(HOME, "connections");
const DRV = path.join(HOME, "drivers");
fs.mkdirSync(CONN, { recursive: true });
fs.mkdirSync(DRV, { recursive: true });

const JARS = [
  ["sqlite-jdbc-3.46.1.0.jar", "org/xerial/sqlite-jdbc/3.46.1.0/sqlite-jdbc-3.46.1.0.jar"],
  ["slf4j-api-2.0.16.jar", "org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar"],
];
for (const [name, rel] of JARS) {
  const dst = path.join(DRV, name);
  if (fs.existsSync(dst)) continue;
  const m2 = path.join(os.homedir(), ".m2", "repository", rel);
  const local = path.join(os.homedir(), ".jdbc-mcp-guard", "drivers", name);
  if (fs.existsSync(m2)) { fs.copyFileSync(m2, dst); continue; }
  if (fs.existsSync(local)) { fs.copyFileSync(local, dst); continue; }
  try {
    execFileSync(process.platform === "win32" ? "curl.exe" : "curl", ["-fsSL", "https://repo1.maven.org/maven2/" + rel, "-o", dst], { timeout: 180000, stdio: "pipe", shell: process.platform === "win32" });
  } catch (e) {
    console.error("驱动准备失败（可把 " + name + " 放到 " + DRV + "）：" + e.message);
    process.exit(1);
  }
}

const db = path.join(HOME, "cli.db").replace(/\\/g, "/");
fs.writeFileSync(path.join(CONN, "cli.json"), JSON.stringify({ database: { dialect: "sqlite", database: db, allowWrite: true, allowDdl: true } }, null, 2));

function run(args) {
  try {
    const out = execFileSync(process.execPath, [CLI].concat(args), {
      encoding: "utf8",
      timeout: 120000,
      env: Object.assign({}, process.env, { JMG_HOME: HOME, JMG_NO_DAEMON: "1" }),
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + " " + String(detail || "").slice(0, 160)); }
}

try {
  const q = run(["query", "--conn", "cli", "--sql", "SELECT 1 AS ok"]);
  check("query 可执行且返回数据", q.code === 0 && /(^|\D)1(\D|$)/.test(q.out), q.out);

  const ddl = run(["exec", "--conn", "cli", "--sql", "CREATE TABLE t (id INTEGER)", "--reason", "回归：DDL 预演"]);
  check("DDL 只做静态预演", ddl.code === 0 && /预演|未执行|DDL/.test(ddl.out), ddl.out);

  const nw = run(["exec", "--conn", "cli", "--sql", "UPDATE t SET id = 1", "--reason", "回归：无 WHERE"]);
  check("无 WHERE 被拒", nw.code === 1 && /WHERE/.test(nw.out), nw.out);

  const nr = run(["exec", "--conn", "cli", "--sql", "UPDATE t SET id = 1 WHERE id = 0"]);
  check("缺 reason 被拒", nr.code === 2 && /reason/.test(nr.out), nr.out);

  const cs = run(["connections"]);
  check("connections 列出连接", cs.code === 0 && cs.out.includes("cli:"), cs.out);

  const alias = run(["query", "--connection", "cli", "--sql", "SELECT 2 AS ok"]);
  check("--connection 别名可用", alias.code === 0 && /(^|\D)2(\D|$)/.test(alias.out), alias.out);

  const unk = run(["query", "--conn", "cli", "--sql", "SELECT 1", "--bogus", "x"]);
  check("未知参数被拒", unk.code === 2 && /未知参数/.test(unk.out), unk.out);
} finally {
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
}

console.log("== CLI 结果：" + pass + " PASS / " + fail + " FAIL ==");
process.exit(fail ? 1 : 0);
