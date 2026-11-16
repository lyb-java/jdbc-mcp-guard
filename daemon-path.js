/**
 * daemon-path —— db_query 的常驻 JVM 快路径（供 db-query-server.js 调用）。
 * ---------------------------------------------------------------------------
 * server 侧接入点只有两个：
 *   tryDaemonQuery(connMeta, driver, { sql, sqls, maxRows, timeout, format })
 *     -> { text } 结构化结果渲染成文本；不可用返回 null（server 自动 fallback 一次性进程）
 *   tryDaemonWrite(connMeta, driver, { sql, dryRun, maxAffected, timeout })
 *     -> { affected, committed, aborted, dryRun }；不可用返回 null
 *
 * 渲染复刻原 Java dumpResultSet 的 table/json 两种格式，保证输出形态与一次性进程一致。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runner } = require("./java-runner.js");

const JMG_HOME = process.env.JMG_HOME || path.join(os.homedir(), ".jdbc-mcp-guard");
const { bridgeJarPath } = require("./java-bridge.js");

// 方言 → JDBC URL（复刻 DbQuery.java dialectSpec）
const DIALECT_URLS = {
  dm: { driver: "dm.jdbc.driver.DmDriver", tpl: "jdbc:dm://{host}:{port}/{database}?useSSL=false&charset=UTF-8" },
  mysql: { driver: "com.mysql.cj.jdbc.Driver", tpl: "jdbc:mysql://{host}:{port}/{database}?useUnicode=true&characterEncoding=utf8&useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Shanghai" },
  mssql: { driver: "com.microsoft.sqlserver.jdbc.SQLServerDriver", tpl: "jdbc:sqlserver://{host}:{port};databaseName={database};encrypt=false;trustServerCertificate=true" },
  postgresql: { driver: "org.postgresql.Driver", tpl: "jdbc:postgresql://{host}:{port}/{database}" },
  oracle: { driver: "oracle.jdbc.OracleDriver", tpl: null },
  sqlite: { driver: "org.sqlite.JDBC", tpl: "jdbc:sqlite:{database}" },
  db2: { driver: "com.ibm.db2.jcc.DB2Driver", tpl: "jdbc:db2://{host}:{port}/{database}" },
  clickhouse: { driver: "com.clickhouse.jdbc.ClickHouseDriver", tpl: "jdbc:clickhouse://{host}:{port}/{database}" },
  trino: { driver: "io.trino.jdbc.TrinoDriver", tpl: "jdbc:trino://{host}:{port}/{database}" },
  h2: { driver: "org.h2.Driver", tpl: "jdbc:h2:{database}" },
};

function buildJdbcUrl(meta, db) {
  if (db.url && String(db.url).trim()) return { url: String(db.url).trim(), driver: db.driverClass || "" };
  const d = DIALECT_URLS[meta.dialect];
  if (!d) return null;
  if (!d.tpl) {
    const svc = String(db.database || "").includes("/");
    return {
      url: "jdbc:oracle:thin:@" + (db.host || "") + ":" + (db.port || "") + (svc ? "/" : ":") + (db.database || ""),
      driver: db.driverClass || d.driver,
    };
  }
  return {
    url: d.tpl.replace("{host}", db.host || "127.0.0.1").replace("{port}", db.port || "").replace("{database}", db.database || ""),
    driver: db.driverClass || d.driver,
  };
}

function loadRawConn(meta) {
  try { return JSON.parse(fs.readFileSync(meta.file, "utf8")); } catch { return null; }
}

function target(meta, driver) {
  const raw = loadRawConn(meta);
  const db = raw && raw.database ? raw.database : raw || {};
  const jdbc = buildJdbcUrl(meta, db);
  if (!jdbc) return null;
  return {
    url: jdbc.url,
    driver: jdbc.driver,
    user: db.user || "",
    password: db.password || "",
    classpath: [bridgeJarPath() || path.join(JMG_HOME, "cache", "daemon-classes"), ...driver.jars].join(path.delimiter),
  };
}

// ── 渲染：与一次性进程输出保持一致 ───────────────────────────────────────────
function renderTable(headers, rows) {
  const widths = headers.map((h) => Math.max(String(h).length, 4));
  rows.forEach((r) => r.forEach((v, i) => {
    const len = String(v == null ? "NULL" : v).length;
    widths[i] = Math.max(widths[i], Math.min(len, 45));
  }));
  const pad = (v, w) => (String(v).length > w ? String(v).slice(0, Math.max(w - 3, 1)) + "..." : String(v)).padEnd(w);
  const sep = "|-" + widths.map((w) => "-".repeat(w)).join("-|-") + "-|";
  const line = (cells) => "| " + cells.map((v, i) => pad(v == null ? "NULL" : v, widths[i])).join(" | ") + " |";
  const out = [line(headers), sep];
  for (const r of rows) out.push(line(r));
  out.push("");
  out.push("(共 " + rows.length + " 条记录)");
  return out.join("\n");
}

function renderJson(headers, rows) {
  return JSON.stringify(
    rows.map((r) => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i]; });
      return o;
    }),
    null,
    1
  );
}

// ── 对外 API ────────────────────────────────────────────────────────────────
function daemonDisabled() {
  return process.env.JMG_NO_DAEMON === "1";
}

async function tryDaemonQuery(meta, driver, { sql, sqls, maxRows, timeout, format }) {
  if (daemonDisabled()) return null;
  const t = target(meta, driver);
  if (!t) return null;
  const list = sqls && sqls.length ? sqls : [sql];
  const parts = [];
  const total = list.length;
  for (let i = 0; i < total; i++) {
    let r;
    try {
      r = await runner.query(t, { sql: list[i], maxRows, timeout });
    } catch (e) {
      // 连接/daemon 级失败：整批报错（交给 server 呈现为错误）
      return { error: String(e.message || e) };
    }
    if (!r.ok) {
      // 单条失败只标记该块，不炸整批（与一次性进程 --multi 的 @@ERROR 语义一致）
      parts.push("【" + (i + 1) + "/" + total + "】 " + String(list[i]).replace(/\s+/g, " ").slice(0, 90) + "\n@@ERROR " + r.error);
      continue;
    }
    const head = "【" + (i + 1) + "/" + total + "】 " + String(list[i]).replace(/\s+/g, " ").slice(0, 90);
    const truncated = r.truncated ? "（已截断，仅显示前 " + maxRows + " 行，请加 LIMIT）" : "";
    const body = format === "json" ? renderJson(r.headers, r.rows) : renderTable(r.headers, r.rows);
    parts.push(head + "\n" + body + (truncated ? "\n" + truncated : ""));
  }
  return { text: parts.join("\n\n") };
}

async function tryDaemonWrite(meta, driver, { sql, dryRun, maxAffected, timeout }) {
  if (daemonDisabled()) return null;
  const t = target(meta, driver);
  if (!t) return null;
  let r;
  try {
    r = await runner.write(t, { sql, dryRun, maxAffected, timeout });
  } catch (e) {
    return { error: e.message };
  }
  return { affected: r.affected, committed: r.committed, aborted: r.aborted || null, dryRun: r.dryRun || false };
}

/** 常驻 JVM 池状态（db_dialects 展示用）*/
function poolStats() {
  return runner.stats();
}

module.exports = { tryDaemonQuery, tryDaemonWrite, poolStats };
