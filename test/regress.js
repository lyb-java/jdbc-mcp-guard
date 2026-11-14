#!/usr/bin/env node
/**
 * db-query MCP 回归测试（SQLite 临时文件库，无网络/无公司库依赖）
 * ---------------------------------------------------------------------------
 * 覆盖：单条 table/json、批量分块、只读守卫（写语句/多语句/DDL）、
 *       db_execute 四道闸（allowWrite/WHERE/预演回滚/提交/超上限回滚/审计）、
 *       db_connections、未知连接报错、超上限截断。
 * 用法：node mcp-servers/test/regress.js   （退出码 0=全过）
 * 前置：javac/java 可用；sqlite 驱动若缺失会自动下载（首次约 20s）。
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 回归使用独立 JMG_HOME（默认临时目录），不碰真实 ~/.jdbc-mcp-guard
const JMG_HOME = process.env.JMG_HOME || path.join(os.tmpdir(), "jmg-regress-home");
process.env.JMG_HOME = JMG_HOME;
const SERVER = path.join(__dirname, "..", "server.js");
const DB_DIR = path.join(JMG_HOME, "connections");
const TMP = os.tmpdir();
const TAG = "dbq-regress-" + process.pid;
const { maskLiterals } = require(path.join(__dirname, "..", "write-guard.js"));
const { bridgeJarPath } = require(path.join(__dirname, "..", "java-bridge.js"));
const DB_FILE = path.join(TMP, TAG + ".db");
const CFG = path.join(DB_DIR, TAG + ".json");          // 连接文件必须放 connections/ 才会被发现
const CFG_W = path.join(DB_DIR, TAG + "-w.json");
const CFG_H2 = path.join(DB_DIR, TAG + "-h2.json");   // 跨驱动切换回归用（h2 内存库）
const CFG_BAD = path.join(DB_DIR, TAG + "-bad.json"); // open 必失败的连接（验证失败不污染其它连接）
const CFG_P2 = path.join(DB_DIR, TAG + "-p2.json");   // 并行回归用（同驱动、不同库 → 同 JVM 不同连接）
const DB_FILE2 = path.join(TMP, TAG + "-p2.db");
const DRIVER_DIR = path.join(JMG_HOME, "drivers");
fs.mkdirSync(DB_DIR, { recursive: true });
fs.mkdirSync(DRIVER_DIR, { recursive: true });

// ── 测试用驱动：优先 ~/.m2，缺失则从 Maven Central 下载（一次即可，缓存在 JMG_HOME/drivers）──
const DRIVER_JARS = [
  { file: "sqlite-jdbc-3.46.1.0.jar", path: "org/xerial/sqlite-jdbc/3.46.1.0/sqlite-jdbc-3.46.1.0.jar" },
  { file: "slf4j-api-2.0.16.jar", path: "org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar" },
  { file: "h2-2.3.232.jar", path: "com/h2database/h2/2.3.232/h2-2.3.232.jar" },
];
function ensureDriverJars() {
  for (const d of DRIVER_JARS) {
    const dst = path.join(DRIVER_DIR, d.file);
    if (fs.existsSync(dst)) continue;
    const m2 = path.join(os.homedir(), ".m2", "repository", d.path);
    if (fs.existsSync(m2)) { fs.copyFileSync(m2, dst); continue; }
    const url = "https://repo1.maven.org/maven2/" + d.path;
    console.log("  下载测试驱动 " + d.file + " …");
    try {
      execFileSync("curl", ["-fsSL", url, "-o", dst], { timeout: 180000, stdio: "pipe" });
    } catch (e) {
      console.error("驱动下载失败：" + url + "（可手动放到 " + DRIVER_DIR + " 后重试）");
      process.exit(1);
    }
  }
}
ensureDriverJars();

// ── 预编译 DbQuery（直接 java 调用用来建表/插数；server 启动后也会复用同一 classes 目录）──
const CLASS_DIR = path.join(JMG_HOME, "cache", "classes");
fs.mkdirSync(CLASS_DIR, { recursive: true });
// 有预编译 jar 就不需要 JDK（只用 JRE 跑测试）
if (!bridgeJarPath()) {
  const javac = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "javac.exe") : "javac";
  try {
    execFileSync(javac, ["-encoding", "UTF-8", "-d", CLASS_DIR, path.join(__dirname, "..", "db", "DbQuery.java")], { stdio: "pipe", windowsHide: true, timeout: 120000 });
  } catch (e) {
    console.error("编译 db/DbQuery.java 失败（需要 JDK 17+）：" + String((e.stderr || e.message || "")).slice(0, 400));
    process.exit(1);
  }
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name} ${String(detail).slice(0, 140)}`); }
}

// 数一下"本测试自己的"DbQueryDaemon JVM（按父进程 = 本测试的 MCP server 过滤，
// 不受本机其它会话的 daemon 影响；无 wmic 的机器返回 null 跳过）
function countOwnDaemons() {
  try {
    const out = execFileSync("wmic", ["process", "where", "name='java.exe'", "get", "commandline,parentprocessid,processid"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    });
    let n = 0;
    for (const line of out.split(String.fromCharCode(10))) {
      if (!line.includes("DbQueryDaemon")) continue;
      const m = line.match(/(\d+)\s+(\d+)\s*$/);
      if (m && Number(m[1]) === srv.pid) n++;
    }
    return n;
  } catch {
    return null;
  }
}

// ── 清理上次残留 + 准备 SQLite 临时库 ───────────────────────────────────────
for (const f of fs.existsSync(DB_DIR) ? fs.readdirSync(DB_DIR) : []) {
  if (/^dbq-regress-/.test(f)) { try { fs.unlinkSync(path.join(DB_DIR, f)); } catch { /* */ } }
}
for (const f of fs.readdirSync(TMP)) {
  if (/^dbq-regress-.*\.db$/.test(f)) { try { fs.unlinkSync(path.join(TMP, f)); } catch { /* */ } }
}

function javaArgs(extra) {
  const jars = ["sqlite-jdbc-3.46.1.0.jar", "slf4j-api-2.0.16.jar"].map((f) => path.join(DRIVER_DIR, f)).filter((p) => fs.existsSync(p));
  return ["-Dfile.encoding=UTF-8", "-cp", [bridgeJarPath() || path.join(JMG_HOME, "cache", "classes"), ...jars].join(path.delimiter), "DbQuery", "--config", CFG, ...extra];
}
function runJava(extra) {
  const out = { stdout: "", stderr: "" };
  try {
    out.stdout = execFileSync("java", javaArgs(extra), { encoding: "utf8", windowsHide: true, timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out.stderr = (e.stderr || e.message || "").toString();
  }
  return out;
}

fs.writeFileSync(CFG, JSON.stringify({ database: { dialect: "sqlite", database: DB_FILE.replace(/\\/g, "/") } }));
let r = runJava(["CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT, v INTEGER)", "--write", "--max-affected", "100"]);
if (!/COMMITTED=true/.test(r.stdout)) { console.error("建表失败：", r.stderr); process.exit(1); }
for (let i = 1; i <= 8; i++) runJava([`INSERT INTO t1 (id, name, v) VALUES (${i}, 'row${i}', ${i * 10})`, "--write", "--max-affected", "100"]);

// allowDdl 仅本测试连接（P1-1 用：DDL 提交后 schema 缓存应失效）
fs.writeFileSync(CFG_W, JSON.stringify({ database: { dialect: "sqlite", database: DB_FILE.replace(/\\/g, "/"), allowWrite: true, allowDdl: true } }));

// ── MCP server（stdio）───────────────────────────────────────────────────────
const srv = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const pending = new Map();
srv.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
srv.stderr.on("data", () => { /* 静默，避免 SLF4J 噪声淹没结果 */ });
const req = (id, method, params) => new Promise((res, rej) => { pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => rej(new Error("timeout " + method)), 180000); });
const call = (id, name, args) => req(id, "tools/call", { name, arguments: args });
const txt = (r) => (r.result?.content || []).map((c) => c.text).join("\n").trim();
const isErr = (r) => Boolean(r.result?.isError) || /✗|拒绝|失败|未知连接/.test(txt(r));

(async () => {
  await req(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "regress", version: "1" } });
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");

  console.log("== 工具注册 ==");
  const tools = await req(2, "tools/list", {});
  const names = tools.result.tools.map((t) => t.name);
  check("四个工具都在", ["db_query", "db_connections", "db_dialects", "db_execute"].every((n) => names.includes(n)), names.join(","));

  console.log("== 连接发现 ==");
  const conns = await call(3, "db_connections", {});
  check("测试连接被列出", txt(conns).includes(TAG), txt(conns).slice(0, 120));
  const unknown = await call(4, "db_query", { sql: "SELECT 1", connection: "no-such-conn" });
  check("未知连接有清晰报错", isErr(unknown) && txt(unknown).includes("未知连接"), "");
  check("连接列表标注写权限", /只读|可写/.test(txt(conns)), txt(conns).slice(0, 200));
  const dialects = await call(48, "db_dialects", {});
  check("db_dialects 展示常驻 JVM 池", /当前常驻 JVM：/.test(txt(dialects)), txt(dialects).slice(0, 200));

  console.log("== 单条查询 ==");
  const t = await call(5, "db_query", { sql: "SELECT id, name FROM t1 WHERE id = 3", connection: TAG });
  check("单条 table 出数据", txt(t).includes("row3"), txt(t).slice(0, 150));
  const j = await call(6, "db_query", { sql: "SELECT id, name FROM t1 WHERE id = 3", connection: TAG, format: "json" });
  let jOk = false, jErr = "";
  try { const raw = txt(j); const a = raw.indexOf("["); const b = raw.indexOf("]", a); jOk = JSON.parse(raw.slice(a, b + 1))[0]?.name === "row3"; } catch (e) { jErr = e.message + " 原文:" + txt(j).slice(0, 120); }
  check("单条 json 合法且取到值", jOk, jErr || txt(j).slice(0, 120));
  const trunc = await call(7, "db_query", { sql: "SELECT id FROM t1", connection: TAG, maxRows: 3 });
  check("maxRows=3 截断提示", txt(trunc).includes("截断") || txt(trunc).includes("(共 3"), txt(trunc).slice(-120));

  const schemaSqlite = await call(47, "db_schema", { connection: TAG, table: "t1" });
  check(
    "db_schema(sqlite) 列名统一为 NAME/TYPE/NULLABLE/REMARK",
    ["NAME", "TYPE", "NULLABLE", "REMARK"].every((h) => txt(schemaSqlite).includes(h)) && txt(schemaSqlite).includes("| name "),
    txt(schemaSqlite).slice(0, 200)
  );

  console.log("== 批量查询 ==");
  const b = await call(8, "db_query", { sqls: ["SELECT COUNT(*) AS n FROM t1", "SELECT name FROM t1 WHERE id = 2"], connection: TAG });
  check("批量分块【1/2】【2/2】", txt(b).includes("【1/2】") && txt(b).includes("【2/2】"), txt(b).slice(0, 160));
  check("批量两块都有数据", /8/.test(txt(b)) && txt(b).includes("row2"), "");
  const bBad = await call(9, "db_query", { sqls: ["SELECT 1 AS x FROM t1", "UPDATE t1 SET v = 1 WHERE id = 1"], connection: TAG });
  check("批量混写语句整批拒", isErr(bBad) && /update|写/.test(txt(bBad)), "");
  const bMany = await call(10, "db_query", { sqls: Array(21).fill("SELECT 1 AS x FROM t1"), connection: TAG });
  check("超 20 条拒", isErr(bMany) && txt(bMany).includes("20"), "");
  const bErr = await call(11, "db_query", { sqls: ["SELECT no_such_col FROM t1", "SELECT COUNT(*) AS n FROM t1"], connection: TAG });
  check("单条语法错不炸整批", !isErr(bErr) && txt(bErr).includes("【2/2】") && /no_such_col|error/i.test(txt(bErr)), txt(bErr).slice(0, 140));

  console.log("== 跨驱动切换（JVM 池，不重启） ==");
  // 历史 bug：MCP 进程内只有一个常驻 JVM，先查过 A 方言后，B 方言的连接复用了 A 的 -cp，
  // 于是 Class.forName(B 的驱动) 必失败，报 "连接失败：com.mysql.cj.jdbc.Driver"。
  // v2 起按 classpath 池化：SQLite 与 H2 应各有一个常驻 JVM（H2 驱动缺失时跳过）。
  fs.writeFileSync(CFG_H2, JSON.stringify({ database: { dialect: "h2", database: "mem:" + TAG } }));
  const h2 = await call(40, "db_query", { sql: "SELECT 1 AS ok", connection: TAG + "-h2" });
  if (/缺少驱动|自动下载已关闭/.test(txt(h2))) {
    console.log("  - 跳过：本机没有 H2 驱动（可从 ~/.m2 或首次自动下载获得）");
  } else {
    check("换成 H2 驱动仍能查", !isErr(h2) && /(^|\D)1(\D|$)/.test(txt(h2)), txt(h2).slice(0, 200));
    const backSqlite = await call(41, "db_query", { sql: "SELECT COUNT(*) AS n FROM t1", connection: TAG });
    check("切回 SQLite 仍能查（不再重启 JVM）", !isErr(backSqlite) && txt(backSqlite).includes("8"), txt(backSqlite).slice(0, 200));
    const after = countOwnDaemons();
    if (after === null) {
      console.log("  - 跳过进程计数：本机没有 wmic");
    } else {
      check("SQLite/H2 两个 JVM 同时常驻（池生效）", after === 2, `after=${after}`);
    }
  }

  console.log("== 同 JVM 内并行（不同库不互相等） ==");
  // 旧实现所有连接共用一个 daemon，Node 侧全局排队；新实现每连接一把锁 + 线程池，
  // 不同库可并行。用"慢查询进行中，另一库的查询仍秒回"来验证。
  fs.writeFileSync(CFG_P2, JSON.stringify({ database: { dialect: "sqlite", database: DB_FILE2.split(String.fromCharCode(92)).join("/") } }));
  const heavySql = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<8000000) SELECT max(x) AS m FROM c";
  const heavyStart = Date.now();
  const heavyPending = call(44, "db_query", { connection: TAG, sql: heavySql, timeout: 120 });
  await new Promise((r) => setTimeout(r, 150));
  const lightStart = Date.now();
  const light = await call(45, "db_query", { connection: TAG + "-p2", sql: "SELECT 1 AS ok" });
  const lightMs = Date.now() - lightStart;
  await heavyPending;
  const heavyMs = Date.now() - heavyStart;
  if (heavyMs < 500) {
    console.log(`  - 跳过：重查询只用了 ${heavyMs}ms，压不出串行差异`);
  } else {
    check(`并行：重查询 ${heavyMs}ms 期间另一库 ${lightMs}ms 返回`, !isErr(light) && lightMs < heavyMs * 0.5, `light=${lightMs}ms heavy=${heavyMs}ms`);
  }

  console.log("== 连接失败不污染其它连接 ==");
  // 历史 bug：open 失败时 daemon 会先 close 旧连接，但 Node 侧连接指纹没清，
  // 原连接后续查询会一直报"连接未打开（先 open）"。用"父路径是普通文件"让 open 必然失败。
  const BLOCKER = path.join(TMP, TAG + "-blocker");
  fs.writeFileSync(BLOCKER, "x");
  fs.writeFileSync(CFG_BAD, JSON.stringify({
    database: { dialect: "sqlite", url: "jdbc:sqlite:" + BLOCKER.replace(/\\/g, "/") + "/sub.db", driverClass: "org.sqlite.JDBC" },
  }));
  const bad = await call(42, "db_query", { connection: TAG + "-bad", sql: "SELECT 1" });
  check("坏连接报连接失败（且不是驱动问题）", isErr(bad) && txt(bad).includes("连接失败") && !txt(bad).includes("驱动类未加载"), txt(bad).slice(0, 160));
  const survived = await call(43, "db_query", { sql: "SELECT COUNT(*) AS n FROM t1", connection: TAG });
  check("失败后原连接仍能查（指纹已重置）", !isErr(survived) && txt(survived).includes("8"), txt(survived).slice(0, 160));

  console.log("== 方言族与 schema SQL ==");
  // MySQL 的 information_schema 是全实例视图：少 TABLE_SCHEMA 会把同名表各库的列混在一起返回
  const { buildSchemaSql, buildSearchSql } = require(path.join(__dirname, "..", "schema-cache.js"));
  const mySchema = buildSchemaSql({ dialect: "tidb", database: "demo" }, "t1").sql;
  const mySearch = buildSearchSql({ dialect: "oceanbase", database: "demo" }, "col").sql;
  check("MySQL 族 schema SQL 带 TABLE_SCHEMA", /TABLE_SCHEMA = 'demo'/.test(mySchema) && /TABLE_NAME = 't1'/.test(mySchema), mySchema.slice(0, 140));
  check("MySQL 族列搜索带 TABLE_SCHEMA", /TABLE_SCHEMA = 'demo'/.test(mySearch), mySearch.slice(0, 140));
  check("PG 族别名 kingbase 可用", /table_schema = 'demo'/.test(buildSchemaSql({ dialect: "kingbase", database: "demo" }, "t1").sql), "");
  check("MSSQL 别名 sqlserver 可用", /TABLE_SCHEMA = 'DEMO'/.test(buildSchemaSql({ dialect: "sqlserver", database: "demo" }, "t1").sql), "");
  // v0.2：补 DB2 / ClickHouse / Trino(Presto) / H2 的 schema + 列搜索
  const db2Schema = buildSchemaSql({ dialect: "db2", database: "demo" }, "t1").sql;
  check("DB2 schema SQL（SYSCAT.COLUMNS）", /SYSCAT\.COLUMNS/.test(db2Schema) && /TABSCHEMA = 'DEMO'/.test(db2Schema), db2Schema.slice(0, 140));
  const chSchema = buildSchemaSql({ dialect: "clickhouse", database: "demo" }, "t1").sql;
  check("ClickHouse schema SQL（system.columns）", /system\.columns/.test(chSchema) && /database = 'demo'/.test(chSchema), chSchema.slice(0, 140));
  const trinoSchema = buildSchemaSql({ dialect: "presto", database: "demo" }, "t1").sql;
  check("Trino/Presto schema SQL（information_schema）", /information_schema\.columns/.test(trinoSchema) && /table_schema = 'demo'/.test(trinoSchema), trinoSchema.slice(0, 140));
  const h2Schema = buildSchemaSql({ dialect: "h2", database: "demo" }, "t1").sql;
  check("H2 schema SQL（INFORMATION_SCHEMA）", /INFORMATION_SCHEMA\.COLUMNS/.test(h2Schema) && /TABLE_SCHEMA = 'DEMO'/.test(h2Schema), h2Schema.slice(0, 140));
  check("DB2 列搜索可用", /SYSCAT\.COLUMNS/.test(buildSearchSql({ dialect: "db2", database: "demo" }, "col").sql), "");

  console.log("== 只读守卫 ==");
  const w = await call(12, "db_query", { sql: "UPDATE t1 SET v = 1 WHERE id = 1", connection: TAG });
  check("db_query 拒写语句", isErr(w), "");
  const multi = await call(13, "db_query", { sql: "SELECT 1 AS a FROM t1; SELECT 2 FROM t1", connection: TAG });
  check("单条内分号拒", isErr(multi) && txt(multi).includes("多语句"), "");
  const ddl = await call(14, "db_execute", { sql: "DROP TABLE t1", connection: TAG, reason: "测试 DDL 应被拒" });
  check("db_execute 拒 DDL", isErr(ddl) && /DDL|只允许/.test(txt(ddl)), "");

  console.log("== P0-1 掩码：注释/字面量绕过 ==");
  const hashDelete = await call(60, "db_execute", { sql: "DELETE FROM t1 # WHERE id=1", connection: TAG + "-w", reason: "回归：# 注释不得绕过 WHERE 检查" });
  check("# 注释里的 WHERE 不得绕过全表检查", isErr(hashDelete) && /WHERE/.test(txt(hashDelete)), txt(hashDelete).slice(0, 140));
  const litWhere = await call(61, "db_execute", { sql: "UPDATE t1 SET name = 'where'", connection: TAG + "-w", reason: "回归：字面量 where 不得绕过 WHERE 检查" });
  check("字面量 'where' 不得绕过全表检查", isErr(litWhere) && /WHERE/.test(txt(litWhere)), txt(litWhere).slice(0, 140));
  // 纯函数单测：MySQL 反斜杠转义不得让字符串提前闭合（否则 \' 之后的 WHERE 会被当成真语法）
  const bsMasked = maskLiterals("UPDATE t1 SET name = 'x\\' WHERE 1=1 #'", { backslashEscapes: true });
  check("反斜杠转义不得提前闭合字符串", !/\bwhere\b/i.test(bsMasked), bsMasked.slice(0, 120));
  const semi = await call(62, "db_execute", { sql: "INSERT INTO t1 (id, name) VALUES (100, 'a;b')", connection: TAG + "-w", reason: "回归：值里的分号不算多语句" });
  check("值含分号的 INSERT 不被误杀", !isErr(semi) && /影响 1 行/.test(txt(semi)), txt(semi).slice(0, 140));
  const callWord = await call(63, "db_execute", { sql: "INSERT INTO t1 (id, name) VALUES (101, 'call me')", connection: TAG + "-w", reason: "回归：值里的 call 不算存储过程" });
  check("值含 call me 的 INSERT 不被误杀", !isErr(callWord) && /影响 1 行/.test(txt(callWord)), txt(callWord).slice(0, 140));
  const withDelete = await call(64, "db_query", { sql: "WITH x AS (DELETE FROM t1 RETURNING *) SELECT * FROM x", connection: TAG });
  check("WITH ... DELETE 读路径仍拒", isErr(withDelete) && /关键字|拒绝/.test(txt(withDelete)), txt(withDelete).slice(0, 160));
  const litSelect = await call(65, "db_query", { sql: "SELECT 'update' AS w, 'a;b' AS v", connection: TAG });
  check("只读值里的 update/分号不误杀", !isErr(litSelect) && txt(litSelect).includes("update"), txt(litSelect).slice(0, 160));

  console.log("== P1-2 只读路径文件 I/O ==");
  const outfile = await call(66, "db_query", { sql: "SELECT 1 AS a INTO OUTFILE '/tmp/x'", connection: TAG });
  check("SELECT ... INTO OUTFILE 被拒", isErr(outfile) && /文件/.test(txt(outfile)), txt(outfile).slice(0, 160));
  const loadFile = await call(67, "db_query", { sql: "SELECT load_file('/etc/passwd') AS x", connection: TAG });
  check("SELECT LOAD_FILE 被拒", isErr(loadFile) && /文件/.test(txt(loadFile)), txt(loadFile).slice(0, 160));

  console.log("== db_execute 写路径 ==");
  const noAllow = await call(15, "db_execute", { sql: "UPDATE t1 SET v = 99 WHERE id = 1", connection: TAG, reason: "未开写权限应被拒" });
  check("未开 allowWrite 拒", isErr(noAllow) && txt(noAllow).includes("allowWrite"), "");
  const noWhere = await call(16, "db_execute", { sql: "UPDATE t1 SET v = 99", connection: TAG + "-w", reason: "无 WHERE 应被拒" });
  check("无 WHERE 拒", isErr(noWhere), "");
  const noReason = await call(17, "db_execute", { sql: "UPDATE t1 SET v = 99 WHERE id = 1", connection: TAG + "-w" });
  check("缺 reason 拒", isErr(noReason), "");

  const dry = await call(18, "db_execute", { sql: "UPDATE t1 SET v = 99 WHERE id = 1", connection: TAG + "-w", reason: "预演：执行后应回滚" });
  check("预演返回影响行数且未提交", /影响 1 行/.test(txt(dry)) && /预演/.test(txt(dry)), txt(dry).slice(0, 140));
  const after = await call(19, "db_query", { sql: "SELECT v FROM t1 WHERE id = 1", connection: TAG });
  check("预演后数据未变（仍 10）", txt(after).includes("10"), txt(after).slice(0, 100));
  const commit = await call(20, "db_execute", { sql: "UPDATE t1 SET v = 99 WHERE id = 1", connection: TAG + "-w", reason: "回归测试：验证真实提交", confirm: "YES" });
  check("confirm=YES 提交成功", /影响 1 行/.test(txt(commit)) && /已提交/.test(txt(commit)), txt(commit).slice(0, 140));
  const after2 = await call(21, "db_query", { sql: "SELECT v FROM t1 WHERE id = 1", connection: TAG });
  check("提交后数据已变（99）", txt(after2).includes("99"), "");
  const cap = await call(22, "db_execute", { sql: "UPDATE t1 SET v = v WHERE id > 0", connection: TAG + "-w", reason: "回归测试：超上限应回滚", confirm: "YES", maxAffected: 3 });
  check("超 maxAffected 自动回滚", isErr(cap) && /回滚/.test(txt(cap)), txt(cap).slice(0, 140));

  console.log("== P1-1 DDL 后 schema 缓存失效 ==");
  const schBefore = await call(68, "db_schema", { connection: TAG + "-w", table: "t1" });
  check("DDL 前 schema 无 extra 列", txt(schBefore).includes("NAME") && !txt(schBefore).includes("extra"), txt(schBefore).slice(0, 140));
  const alter = await call(69, "db_execute", { sql: "ALTER TABLE t1 ADD COLUMN extra TEXT", connection: TAG + "-w", reason: "回归：DDL 提交后 schema 缓存应失效", confirm: "YES" });
  check("ALTER TABLE 提交成功", !isErr(alter) && /已提交/.test(txt(alter)), txt(alter).slice(0, 140));
  const schAfter = await call(70, "db_schema", { connection: TAG + "-w", table: "t1" });
  check("DDL 后不传 refresh 立即见新列", txt(schAfter).includes("extra"), txt(schAfter).slice(0, 160));

  console.log("== 审计 ==");
  const auditPath = path.join(JMG_HOME, "audit.jsonl");
  const audit = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").trim().split("\n") : [];
  const mine = audit.filter((l) => l.includes(TAG));
  const last = mine.length ? JSON.parse(mine[mine.length - 1]) : {};
  check("审计日志记录了本连接的操作", mine.length >= 3 && last.reason && typeof last.committed === "boolean", JSON.stringify(last).slice(0, 160));
  const mineRecs = mine.map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  check("审计记录真实 ddl 标记", mineRecs.some((r) => r.ddl === true && r.kind === "ddl" && r.committed === true), "");
  check("被拒写也入审计（kind=rejected）", mineRecs.some((r) => r.kind === "rejected" && r.ok === false), "");

  srv.kill();
  console.log(`\n== 结果：${pass} PASS / ${fail} FAIL ==`);
  if (fail) console.log("失败项：\n" + failures.map((f) => "  - " + f).join("\n"));
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("测试框架故障：", e.message);
  srv.kill();
  cleanup();
  process.exit(1);
});

function cleanup() {
  for (const f of [CFG, CFG_W, CFG_H2, CFG_BAD, CFG_P2, DB_FILE, DB_FILE2, path.join(TMP, TAG + "-blocker")]) {
    try { fs.unlinkSync(f); } catch { /* */ }
  }
}
