#!/usr/bin/env node
/**
 * jdbc-mcp-guard —— 任意 JDBC 数据库的 MCP 网关：只读查询 + 分级写入 + 全量审计
 * ---------------------------------------------------------------------------
 * 设计：不依赖任何厂商 CLI，直接调用 Java 查询器（绕开 PATH/PATHEXT 转发问题）：
 *   java -cp <DbQuery 类目录>;<驱动 jar> DbQuery --file <临时 sql> [--json] --config <连接配置>
 *
 * 方言：dm、mysql 协议族(mariadb/tidb/oceanbase/starrocks/doris/goldendb)、
 *       postgresql 协议族(opengauss/gaussdb/kingbase/highgo/vastbase)、mssql、oracle、
 *       sqlite、db2、clickhouse、trino、presto、hive2、h2；
 *       其它任意数据库可在连接配置里写 "url" + "driverClass"（JDBC 全覆盖）。
 *
 * 驱动 jar：JDBC 必须有驱动，但**不需要你手动准备**——按以下顺序自动找：
 *   1) 连接配置里的 database.driverJar（绝对路径，可数组）
 *   2) $JMG_HOME/drivers.json 的 aliases
 *   3) $JMG_HOME/drivers/*.jar（已缓存的）
 *   4) 本机 ~/.m2 仓库里已有的（离线可用）
 *   5) 从 Maven 镜像自动下载并缓存（默认阿里云 → 中央仓库；可用 drivers.json.repos 覆盖）
 *
 * 配置根：JMG_HOME（默认 ~/.jdbc-mcp-guard）
 *   connections/<name>.json   连接配置（含写开关；default.json 即默认连接）
 *   drivers/                  驱动缓存（自动下载）
 *   audit.jsonl               写操作审计（含被拒/预演）
 */
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { tryDaemonQuery, tryDaemonWrite, poolStats } = require("./daemon-path.js");
const { buildSchemaSql, buildSearchSql, cacheGet, cacheSet, cacheClear, keyOf } = require("./schema-cache.js");
const { assertWriteSafe, classifyStatement, maskLiterals, FILE_IO } = require("./write-guard.js");

const HOME = os.homedir();
const JMG_HOME = process.env.JMG_HOME || path.join(HOME, ".jdbc-mcp-guard");
const DB_DIR = path.join(JMG_HOME, "connections");
const DRIVER_DIR = path.join(JMG_HOME, "drivers");
// ~/.m2 里同名目录下常同时存在 -sources.jar / -javadoc.jar（也有项目手工放），
// 它们体积相似、能被 *.jar 匹配到，但里面没有驱动类 —— 拿去当驱动就是
// "No suitable driver found" / ClassNotFoundException。解析时一律排除。
const DRIVER_JAR_NOISE = /-(sources|javadoc|tests)\.jar$/i;
const CLASS_CACHE = path.join(JMG_HOME, "cache", "classes");
const JAVA_SRC = path.join(__dirname, "db", "DbQuery.java");
const MAX_ROWS_DEFAULT = 200;
const LINE_SAFETY_CAP = 3000;
// db_schema / db_search_columns 的默认预算：daemon 快路径与一次性回退共用（P1-6）
const SCHEMA_MAX_ROWS = 500;
const SCHEMA_TIMEOUT_SEC = 30;
const SEARCH_MAX_ROWS = 300;
const SEARCH_TIMEOUT_SEC = 60;
// 写审计里的操作者标识：优先环境变量（可指向 AI 专用账号），否则 ai@<主机名>
const ACTOR = process.env.JMG_ACTOR || `ai@${os.hostname()}`;

const READONLY_KEYWORDS = new Set(["select", "with", "show", "desc", "describe", "explain", "values"]);

// 反斜杠转义是否生效：MySQL 族 true；达梦/MSSQL/SQLite/PG/Oracle 等标准串里 \ 是普通字符。
// 空/未知方言按 true（安全方向：宁可多掩码导致误拒，不可漏判）。
function mysqlBackslashEscapes(dialect) {
  const d = String(dialect || "").toLowerCase();
  if (!d) return true;
  return /mysql|mariadb/.test(d);
}
// 二次防线：即使首关键字合法（如 WITH ... DELETE），出现这些写/DDL 关键字一律拒绝。
// 判定一律在 maskLiterals() 的掩码 body 上做，否则「WHERE remark='update'」会被误杀（P0-1）。
const WRITE_KEYWORDS = /\b(insert|update|delete|merge|drop|alter|truncate|create|grant|revoke|rename|comment\s+on|call|exec|execute)\b/i;

// ── 方言 → 驱动规格（coords: group:artifact:version[:classifier]）─────────────
// coords 为数组：某些驱动还需伴随依赖（如 sqlite-jdbc 需要 slf4j-api）；cache 与 coords 一一对应
const DRIVER_SPECS = {
  dm: { coords: ["com.dameng:DmJdbcDriver18:8.1.3.62"], m2: ["com", "dameng", "*", "*", "*.jar"] },
  // m2Alt：老项目还在用 mysql:mysql-connector-java（group 不是 com.mysql），两处都认
  mysql: {
    coords: ["com.mysql:mysql-connector-j:9.1.0"],
    m2: ["com", "mysql", "*", "*", "*.jar"],
    m2Alt: [["mysql", "mysql-connector-java", "*", "*", "*.jar"]],
  },
  postgresql: { coords: ["org.postgresql:postgresql:42.7.4"], m2: ["org", "postgresql", "postgresql", "*", "*.jar"] },
  mssql: { coords: ["com.microsoft.sqlserver:mssql-jdbc:12.8.1.jre11"], m2: ["com", "microsoft", "sqlserver", "*", "*", "*.jar"] },
  oracle: { coords: ["com.oracle.database.jdbc:ojdbc11:23.5.0.24.07"], m2: ["com", "oracle", "database", "jdbc", "*", "*", "ojdbc*.jar"] },
  sqlite: { coords: ["org.xerial:sqlite-jdbc:3.46.1.0", "org.slf4j:slf4j-api:2.0.16"], m2: ["org", "xerial", "sqlite-jdbc", "*", "*.jar"] },
  db2: { coords: ["com.ibm.db2:jcc:11.5.9.0"], m2: ["com", "ibm", "db2", "jcc", "*", "*.jar"] },
  clickhouse: { coords: ["com.clickhouse:clickhouse-jdbc:0.6.5:all"], m2: ["com", "clickhouse", "clickhouse-jdbc", "*", "*.jar"] },
  trino: { coords: ["io.trino:trino-jdbc:451"], m2: ["io", "trino", "trino-jdbc", "*", "*.jar"] },
  presto: { coords: ["com.facebook.presto:presto-jdbc:0.287"], m2: ["com", "facebook", "presto", "presto-jdbc", "*", "*.jar"] },
  h2: { coords: ["com.h2database:h2:2.3.232"], m2: ["com", "h2database", "h2", "*", "*.jar"] },
};

// 方言别名 → 驱动键
const DIALECT_TO_DRIVER = {
  dm: "dm", dameng: "dm",
  mysql: "mysql", mariadb: "mysql", tidb: "mysql", oceanbase: "mysql", starrocks: "mysql", doris: "mysql", goldendb: "mysql",
  postgresql: "postgresql", postgres: "postgresql", opengauss: "postgresql", gaussdb: "postgresql",
  kingbase: "postgresql", highgo: "postgresql", vastbase: "postgresql",
  mssql: "mssql", sqlserver: "mssql",
  oracle: "oracle",
  sqlite: "sqlite", sqlite3: "sqlite",
  db2: "db2",
  clickhouse: "clickhouse",
  trino: "trino",
  presto: "presto",
  h2: "h2",
};

const DEFAULT_REPOS = ["https://maven.aliyun.com/repository/public", "https://repo1.maven.org/maven2"];

// ── 工具函数 ─────────────────────────────────────────────────────────────────
function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function driverSettings() {
  const cfg = loadJson(path.join(DB_DIR, "drivers.json")) || {};
  return {
    aliases: cfg.aliases || {},
    repos: Array.isArray(cfg.repos) && cfg.repos.length ? cfg.repos : DEFAULT_REPOS,
    autoDownload: cfg.autoDownload !== false,
    // P1-5：可选完整性清单（jar 文件名 → sha256）；命中即强校验，未配置时下载后把实际 sha256 打到 stderr
    checksums: cfg.checksums && typeof cfg.checksums === "object" && !Array.isArray(cfg.checksums) ? cfg.checksums : {},
  };
}

function firstGlob(segments) {
  let current = [HOME];
  for (const seg of segments) {
    const next = [];
    for (const base of current) {
      if (!seg.includes("*")) {
        next.push(path.join(base, seg));
        continue;
      }
      let entries = [];
      try {
        entries = fs.readdirSync(base);
      } catch {
        continue;
      }
      const re = new RegExp("^" + seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      for (const entry of entries.sort().reverse()) if (re.test(entry)) next.push(path.join(base, entry));
    }
    current = next;
    if (!current.length) return null;
  }
  // 优先真实 jar（排除 sources/javadoc），全被排除时退回原候选，保持旧行为
  const usable = current.filter((p) => !DRIVER_JAR_NOISE.test(p));
  return usable.find((p) => fs.existsSync(p)) || current.find((p) => fs.existsSync(p)) || null;
}

function mavenRelative(coords) {
  const parts = coords.split(":");
  const [group, artifact, version] = parts;
  const classifier = parts[3] ? `-${parts[3]}` : "";
  const dir = group.split(".").join("/");
  return { rel: `${dir}/${artifact}/${version}/${artifact}-${version}${classifier}.jar`, file: `${artifact}-${version}${classifier}.jar` };
}

function downloadTo(url, dest, depth = 0, opts = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("重定向过多"));
    const req = https.get(url, { timeout: 120000, headers: { "user-agent": "jdbc-mcp-guard/0.1" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return downloadTo(nextUrl, dest, depth + 1, opts).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // P1-5：临时文件名必须唯一 —— 并发首查同一驱动时两个下载流不能互写同一个 .part
      const tmp = dest + ".part." + process.pid + "." + crypto.randomBytes(6).toString("hex");
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on("finish", () => {
        out.close(() => {
          try {
            const size = fs.statSync(tmp).size;
            if (size < 10240) {
              fs.unlink(tmp, () => {});
              return reject(new Error(`下载内容过小（${size} 字节），可能是错误页`));
            }
            // P1-5：jar 本质是 ZIP，先验 PK 魔数，避免把错误页/被劫持内容当驱动加载
            const magic = Buffer.alloc(4);
            const fd = fs.openSync(tmp, "r");
            try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
            if (!(magic[0] === 0x50 && magic[1] === 0x4b)) {
              fs.unlink(tmp, () => {});
              return reject(new Error("下载内容不是 ZIP/JAR（缺少 PK 魔数），已丢弃"));
            }
            // P1-5：记 sha256；drivers.json 配了 checksums[文件名] 就强校验，没配则打 stderr 留痕
            const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tmp)).digest("hex");
            const expected = opts && opts.expectedSha256 ? String(opts.expectedSha256).trim().toLowerCase() : "";
            if (expected && expected !== sha256) {
              fs.unlink(tmp, () => {});
              return reject(new Error(`sha256 校验失败（${path.basename(dest)}）：期望 ${expected}，实际 ${sha256}`));
            }
            if (!expected) {
              process.stderr.write("[db-query] 驱动 " + path.basename(dest) + " 下载完成 sha256=" + sha256 + "（drivers.json 未配置 checksums，跳过校验）\n");
            }
            fs.renameSync(tmp, dest);
            resolve(dest);
          } catch (error) {
            fs.unlink(tmp, () => {});
            reject(error);
          }
        });
      });
      out.on("error", (error) => {
        fs.unlink(tmp, () => {});
        reject(error);
      });
    });
    req.on("timeout", () => req.destroy(new Error("下载超时")));
    req.on("error", reject);
  });
}

/** 在 ~/.m2 里找主驱动 jar（支持一个方言多个 group，如 mysql-connector-j / mysql-connector-java） */
function findM2Jar(spec) {
  for (const group of [spec.m2, ...(spec.m2Alt || [])]) {
    const hit = firstGlob([".m2", "repository", ...group]);
    if (hit) return hit;
  }
  return null;
}

/** 解析某个连接应该用哪个驱动 jar：返回 { jar, source } 或 { missing: true, coords } */
async function resolveDriver(meta, settings, allowDownload) {
  const dialect = (meta.dialect || "dm").toLowerCase();
  const driverKey = DIALECT_TO_DRIVER[dialect];

  // 1) 连接配置里显式指定
  const explicit = meta.driverJar ? (Array.isArray(meta.driverJar) ? meta.driverJar : [meta.driverJar]) : [];
  if (explicit.length) {
    const ok = explicit.filter((p) => fs.existsSync(p));
    if (ok.length) return { jars: ok, source: "连接配置 driverJar" };
    return { missing: true, reason: `driverJar 路径不存在：${explicit.join(", ")}` };
  }

  // 2) drivers.json aliases（按方言名或驱动键）
  const aliasKey = [dialect, driverKey].find((k) => k && settings.aliases[k]);
  if (aliasKey) {
    const list = [].concat(settings.aliases[aliasKey]);
    const ok = list.filter((p) => fs.existsSync(p));
    if (ok.length) return { jars: ok, source: "drivers.json aliases" };
  }

  if (!driverKey || !DRIVER_SPECS[driverKey]) {
    return { missing: true, reason: `方言 "${dialect}" 没有内置驱动映射；请在连接配置里写 "url" + "driverClass" + "driverJar"` };
  }
  const spec = DRIVER_SPECS[driverKey];

  // 3) 缓存目录：coords 全部就位才算完整（有的驱动需要伴随依赖 jar）
  const cacheFiles = spec.coords.map((c) => mavenRelative(c).file);
  const cachedJars = cacheFiles.map((f) => path.join(DRIVER_DIR, f));
  if (cachedJars.every((p) => fs.existsSync(p))) return { jars: cachedJars, source: "缓存 db/drivers" };

  // 4) 本机 ~/.m2（主驱动命中可直接用；伴随依赖若缺且允许下载则补齐，否则带上已缓存的）
  const m2 = findM2Jar(spec);
  if (m2) {
    const jars = [m2];
    // 只补"伴随依赖"（coords[0] 就是 m2 里那份主驱动，不重复下载）
    for (const coords of spec.coords.slice(1)) {
      const { rel, file } = mavenRelative(coords);
      const target = path.join(DRIVER_DIR, file);
      if (fs.existsSync(target)) {
        if (!jars.includes(target)) jars.push(target);
        continue;
      }
      if (!allowDownload || !settings.autoDownload) continue;
      for (const repo of settings.repos) {
        try {
          await downloadTo(`${repo.replace(/\/$/, "")}/${rel}`, target, 0, { expectedSha256: (settings.checksums || {})[file] });
          jars.push(target);
          break;
        } catch {
          /* 伴随依赖下载失败不致命：主驱动已就绪，运行时若报 NoClassDefFoundError 再补 */
        }
      }
    }
    return { jars, source: "本机 ~/.m2" };
  }

  // 5) 下载（全部 coords）
  if (!allowDownload || !settings.autoDownload) {
    return {
      missing: true,
      reason: settings.autoDownload
        ? `驱动未缓存（${spec.coords.join(" + ")}）——首次查询时会自动下载，或手动放到 ${DRIVER_DIR}`
        : `未找到驱动（${spec.coords.join(" + ")}）；自动下载已关闭，请手动放到 ${DRIVER_DIR}`,
    };
  }
  const errors = [];
  const jars = [];
  let downloaded = 0;
  for (const coords of spec.coords) {
    const { rel, file } = mavenRelative(coords);
    const target = path.join(DRIVER_DIR, file);
    if (fs.existsSync(target)) {
      jars.push(target);
      continue;
    }
    let done = false;
    for (const repo of settings.repos) {
      try {
        await downloadTo(`${repo.replace(/\/$/, "")}/${rel}`, target, 0, { expectedSha256: (settings.checksums || {})[file] });
        jars.push(target);
        downloaded++;
        done = true;
        break;
      } catch (error) {
        errors.push(`${repo}: ${error.message}`);
      }
    }
    if (!done) return { missing: true, reason: `驱动下载失败（${coords}）：${errors.join("; ")}` };
  }
  return { jars, source: downloaded ? `自动下载 ${downloaded} 个 jar` : "缓存 db/drivers" };
}

// ── 写操作守卫（db_execute 专用，默认关闭）──────────────────────────────────
// 写语句分级校验已抽到 write-guard.js（DML / DDL / 破坏性 三级）

function describePool() {
  const pool = poolStats();
  if (!pool.length) return "无（首次查询时按驱动懒启动）";
  return (
    `${pool.length} 个：` +
    pool
      .map((d) => {
        const jars = d.jars.filter((j) => !/^db-daemon-classes$/.test(j)).join(" + ") || "无驱动";
        return `${jars}${d.ready ? "" : "(启动中)"}`;
      })
      .join("；")
  );
}

const AUDIT_FILE = path.join(JMG_HOME, "audit.jsonl");
const AUDIT_MAX_BYTES = Number(process.env.JMG_AUDIT_MAX_BYTES || 5 * 1024 * 1024);

// 审计不能无限长：超过阈值就把当前文件转成 _audit.1.jsonl（只留一份历史）
function rotateAudit() {
  try {
    if (fs.statSync(AUDIT_FILE).size < AUDIT_MAX_BYTES) return;
    const prev = path.join(JMG_HOME, "audit.1.jsonl");
    try {
      fs.unlinkSync(prev);
    } catch {
      /* 首次轮转没有旧文件 */
    }
    fs.renameSync(AUDIT_FILE, prev);
  } catch {
    /* 轮转失败不影响写入 */
  }
}

// P1-4：审计写失败不再静默（磁盘满/权限问题以前是 fail-open 且无感知）
let lastAuditError = "";

function auditLog(record) {
  try {
    fs.mkdirSync(DB_DIR, { recursive: true });
    rotateAudit();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(record) + "\n", "utf8");
    lastAuditError = "";
    return true;
  } catch (error) {
    lastAuditError = String((error && error.message) || error);
    try {
      process.stderr.write("[db-query] 审计写入失败 " + AUDIT_FILE + "：" + lastAuditError + "\n");
    } catch {
      /* stderr 也写不了时只剩内存标志 */
    }
    return false;
  }
}

/** 结果文本追加"审计写失败"提示（成功时为空串）*/
function auditNote() {
  return lastAuditError ? "\n⚠ 审计写入失败（" + AUDIT_FILE + "）：" + lastAuditError : "";
}

// ── 只读守卫 ─────────────────────────────────────────────────────────────────
function assertReadOnly(sql, dialect) {
  // P0-1：判定一律用掩码 body —— 注释/字符串字面量里的关键字不再影响只读判定，
  // 同时修掉「值里含分号被当多语句」「WHERE remark='update' 被误杀」。
  const body = maskLiterals(sql, { backslashEscapes: mysqlBackslashEscapes(dialect) }).replace(/;\s*$/, "");
  const first = (body.match(/^[A-Za-z]+/) || [""])[0].toLowerCase();
  if (!READONLY_KEYWORDS.has(first)) {
    throw new Error(
      `只读守卫拒绝执行：语句以 "${first || "?"}" 开头。只允许 SELECT / WITH / SHOW / DESC / EXPLAIN / VALUES；` +
        `写操作（INSERT/UPDATE/DELETE/DDL）请人工在数据库客户端执行。`
    );
  }
  if (WRITE_KEYWORDS.test(body)) {
    throw new Error("只读守卫拒绝执行：语句里含写/DDL 关键字（如 WITH ... DELETE 这类变体也会被拦）。写操作请人工在数据库客户端执行。");
  }
  // P1-2：文件 I/O / 服务端文件外带与写守卫对称（INTO OUTFILE / LOAD_FILE / COPY / pg_read_file …）
  if (FILE_IO.test(body)) {
    throw new Error("只读守卫拒绝执行：语句里含文件 I/O / 服务端文件读取关键字（INTO OUTFILE / LOAD_FILE / COPY / pg_read_file 等），一律不放行。");
  }
  // 多语句检测：在掩码 body 上做，字面量里的分号不再误判
  if (/;\s*\S/.test(body)) {
    throw new Error("只读守卫拒绝执行：检测到多语句（分号后仍有内容），请拆成单条查询。");
  }
}

// ── DbQuery 编译（首次 javac，之后复用；无 JDK 直接报错并给出安装提示）──
function compileClassSync() {
  const target = path.join(CLASS_CACHE, "DbQuery.class");
  try {
    if (fs.statSync(target).mtimeMs >= fs.statSync(JAVA_SRC).mtimeMs) return CLASS_CACHE;
  } catch {
    /* 需要编译 */
  }
  if (!fs.existsSync(JAVA_SRC)) {
    if (fs.existsSync(path.join(legacyDir, "DbQuery.class"))) return legacyDir;
    throw new Error(`找不到查询器源码：${JAVA_SRC}`);
  }
  fs.mkdirSync(CLASS_CACHE, { recursive: true });
  const javac = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "javac.exe") : "javac";
  try {
    execFileSync(javac, ["-encoding", "UTF-8", "-d", CLASS_CACHE, JAVA_SRC], { stdio: "pipe", windowsHide: true, timeout: 60000 });
    return CLASS_CACHE;
  } catch (error) {
    if (fs.existsSync(path.join(legacyDir, "DbQuery.class"))) return legacyDir;
    throw new Error(`DbQuery 编译失败且无预编译副本（${javac}）：${(error.stderr || error.message || "").toString().slice(0, 400)}`);
  }
}

// ── 连接注册 ─────────────────────────────────────────────────────────────────
function readConnectionMeta(file) {
  const raw = loadJson(file);
  if (!raw) return { error: "配置文件不是合法 JSON" };
  const db = raw.database || raw;
  return {
    dialect: (db.dialect || "dm").toLowerCase(),
    host: db.host || "",
    port: db.port || "",
    database: db.database || "",
    user: db.user || "",
    hasPassword: Boolean(db.password),
    url: db.url || "",
    driverClass: db.driverClass || "",
    driverJar: db.driverJar || "",
    // 写权限：连接级显式开关，默认 false（生产库默认不给）
    allowWrite: db.allowWrite === true || String(db.allowWrite).toLowerCase() === "true",
    // 写权限分级：DML / DDL / 破坏性，默认全关（生产库不要开 DDL/破坏性）
    allowDdl: db.allowDdl === true || String(db.allowDdl).toLowerCase() === "true",
    allowDestructive: db.allowDestructive === true || String(db.allowDestructive).toLowerCase() === "true",
  };
}

function listConnections() {
  const result = [];
  let entries = [];
  try {
    entries = fs
      .readdirSync(DB_DIR)
      // 跳过 _ 开头（_index.json 等索引/说明文件）、drivers.json、模板
      .filter((f) => f.toLowerCase().endsWith(".json") && !f.startsWith("_") && f !== "drivers.json" && !f.includes("example"));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const file = path.join(DB_DIR, entry);
    result.push({ name: entry.replace(/\.json$/i, ""), file, ...readConnectionMeta(file) });
  }
  return result;
}

function resolveConnection(name) {
  const want = (name || "default").trim();
  const all = listConnections();
  const hit = all.find((c) => c.name === want);
  if (!hit) {
    throw new Error(`未知连接 "${want}"。可用连接：${all.map((c) => c.name).join(", ") || "(无)"}。新增：在 ${DB_DIR} 放 <name>.json。`);
  }
  if (hit.error) throw new Error(`连接 "${want}" 配置有问题：${hit.error}`);
  return hit;
}

// ── 查询执行 ─────────────────────────────────────────────────────────────────
/**
 * 一次性 JVM 执行（daemon 不可用 / 方言不支持池化 时的兜底）。
 * P1-6：db_schema / db_search_columns 也复用它，不再"daemon 一挂、schema 能力全灭"。
 * @returns {Promise<{text?:string, error?:string}>}
 */
function runOneShot(conn, driver, { sql, batch, rows, timeout, format }) {
  const classDir = compileClassSync();
  const cp = [classDir, ...driver.jars].join(path.delimiter);
  const tmp = path.join(os.tmpdir(), `dbq-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(tmp, batch ? batch.join("\n--@@BATCH_SPLIT@@--\n") : sql, "utf8");

  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java.exe") : "java";
  const args = ["-Dfile.encoding=UTF-8", "-cp", cp, "DbQuery", "--file", tmp, "--config", conn.file, "--max-rows", String(rows)];
  if (batch) args.push("--multi");
  if (format === "json") args.push("--json");
  if (Number.isFinite(timeout) && timeout > 0) args.push("--timeout", String(Math.floor(timeout)));

  return new Promise((resolve) => {
    execFile(java, args, { encoding: "utf8", windowsHide: true, timeout: 150000, maxBuffer: 64 << 20 }, (error, stdout, stderr) => {
      fs.unlink(tmp, () => {});
      if (error) {
        resolve({ error: (stderr || error.message || "").trim() });
        return;
      }
      let text = stdout || "(查询成功，无数据行返回)";
      if (batch && stdout) {
        // 批量：把 @@RESULT_BEGIN/END 标记重组为分块结果
        const blocks = [];
        let cur = null;
        for (const line of stdout.split(/\r?\n/)) {
          const b = line.match(/^@@RESULT_BEGIN (\d+) ?(.*)$/);
          if (b) { cur = { idx: Number(b[1]), label: b[2] || "", lines: [] }; continue; }
          if (/^@@RESULT_END \d+$/.test(line)) { if (cur) { blocks.push(cur); cur = null; } continue; }
          if (cur) cur.lines.push(line);
        }
        if (blocks.length) {
          const parts = blocks.map((blk) => "【" + (blk.idx + 1) + "/" + blocks.length + "】 " + blk.label + "\n" + blk.lines.join("\n").replace(/\n+$/, ""));
          text = parts.join("\n\n");
        }
      }
      if (format !== "json" && !batch) {
        const lines = text.split("\n");
        if (lines.length > LINE_SAFETY_CAP) {
          text = lines.slice(0, LINE_SAFETY_CAP).join("\n") + `\n…（单行内容过长已保护性截断；请只取必要列）`;
        }
      }
      // stderr 只保留真正的错误信息，过滤驱动自带的日志噪声（如 SLF4J 无 provider 警告）
      const note = (stderr || "")
        .split("\n")
        .filter((line) => line.trim() && !/^SLF4J/.test(line.trim()) && !/^StatusLogger/.test(line.trim()))
        .join("\n")
        .trim();
      resolve({ text: text + (note ? "\n" + note : "") });
    });
  });
}

async function runQuery({ sql, sqls, connection, format, maxRows, timeout }) {
  // 批量模式：一次 JVM + 一次建连执行多条只读 SQL（每条独立守卫，单条失败不影响其它条）
  const batch = Array.isArray(sqls) && sqls.length ? sqls.map(String).filter((x) => x.trim()) : null;
  const conn = resolveConnection(connection);
  // 只读守卫按方言决定反斜杠转义语义（MySQL 族支持 \'）；连接解析提前到守卫之前，只为拿 dialect
  if (sql && !batch) assertReadOnly(sql, conn.dialect);
  if (batch) {
    if (batch.length > 20) throw new Error("批量上限 20 条；更多请分批调用。");
    for (const one of batch) assertReadOnly(one, conn.dialect);
  }
  const settings = driverSettings();
  const driver = await resolveDriver(conn, settings, true);
  if (driver.missing) throw new Error(`连接 "${conn.name}" 缺少驱动：${driver.reason}`);

  // 默认行数上限在两条路径上必须一致：常驻 JVM 的 maxRows=0 表示"不限"，
  // 不显式兜底的话 `SELECT * FROM 大表` 会把整表倒进上下文（实测 SHOW TABLES 回 517 行）。
  const rows = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : MAX_ROWS_DEFAULT;

  // ── 快路径：常驻 JVM（同连接首次 ~2.5s，之后毫秒级；失败自动 fallback 一次性进程）──
  let fast = null;
  try {
    fast = await tryDaemonQuery(conn, driver, { sql: batch ? null : sql, sqls: batch, maxRows: rows, timeout, format });
  } catch (daemonErr) {
    fast = { error: String(daemonErr.message || daemonErr) };
  }
  const head = `[${conn.name} / ${conn.dialect}${conn.host ? " " + conn.host + ":" + conn.port + "/" + conn.database : conn.database ? " " + conn.database : ""} · 常驻]`;
  if (fast && fast.error) {
    // daemon 路径的业务性失败（连接拒绝/认证失败等）：语义与一次性进程一致，直接返回错误
    return { isError: true, content: [{ type: "text", text: `${head}\n查询失败：${fast.error}` }] };
  }
  if (fast && fast.text) {
    return { content: [{ type: "text", text: fast.text + String.fromCharCode(10) + head }] };
  }
  // fast === null：方言/驱动不支持 daemon 化，走一次性进程
  const oneShot = await runOneShot(conn, driver, { sql, batch, rows, timeout, format });
  const oneHead = `[${conn.name} / ${conn.dialect}${conn.host ? " " + conn.host + ":" + conn.port + "/" + conn.database : conn.database ? " " + conn.database : ""} · 驱动 ${driver.source}]`;
  if (oneShot.error) {
    return { isError: true, content: [{ type: "text", text: `${oneHead}\n查询失败：${oneShot.error}` }] };
  }
  return { content: [{ type: "text", text: `${oneShot.text}\n${oneHead}` }] };
}

// ── 写执行（db_execute）：连接级白名单 + 事务 + 影响行数上限 + 审计 ──────────
async function runWrite({ sql, connection, reason, confirm, maxAffected, timeout }) {
  if (!reason || String(reason).trim().length < 6) {
    throw new Error('写守卫拒绝：必须用 reason 说明「为什么要改」（≥6 字，会写进审计日志）。');
  }
  const conn = resolveConnection(connection);
  // 分级权限：DML(allowWrite) / DDL(allowDdl) / 破坏性(allowDestructive)
  const verdict = assertWriteSafe(sql, {
    allowWrite: conn.allowWrite,
    allowDdl: conn.allowDdl,
    allowDestructive: conn.allowDestructive,
    connName: conn.name,
    backslashEscapes: mysqlBackslashEscapes(conn.dialect),
  });
  const isDdl = verdict.kind === "ddl" || verdict.kind === "destructive";
  const wCommit = String(confirm || "").toUpperCase() === "YES";

  // DDL 在 MySQL/达梦是隐式提交，ROLLBACK 无效 —— 预演只做静态校验，绝不执行
  if (isDdl && !wCommit) {
    const kindLabel = verdict.kind === "destructive" ? "破坏性 DDL" : "DDL";
    const head = `[${conn.name} · ${conn.dialect} · ${kindLabel} · 预演（未执行）]`;
    const text = [
      head,
      `语句类型：${verdict.first.toUpperCase()}` ,
      `将执行：${String(sql).replace(/\s+/g, " ").slice(0, 300)}`,
      "",
      "DDL 在 MySQL/达梦为隐式提交、不可回滚，故预演不执行、只做静态校验。",
      "确认无误后，再调用一次并传 confirm=\"YES\" 才会真正执行。",
      verdict.kind === "destructive" ? "⚠ 这是破坏性操作（DROP/TRUNCATE/DROP COLUMN），数据可能无法恢复。" : "",
    ].filter(Boolean).join(String.fromCharCode(10));
    auditLog({ at: new Date().toISOString(), connection: conn.name, dialect: conn.dialect, target: `${conn.host}:${conn.port}/${conn.database}`, actor: ACTOR, sqlSha256: require("crypto").createHash("sha256").update(sql).digest("hex"), sqlPreview: String(sql).replace(/\s+/g, " ").slice(0, 300), reason: String(reason), affected: null, committed: false, ddl: true, kind: verdict.kind, ok: true, note: "dry-run (not executed)" });
    return { content: [{ type: "text", text: text + auditNote() }] };
  }

  const settings = driverSettings();
  const driver = await resolveDriver(conn, settings, true);
  if (driver.missing) throw new Error(`连接 "${conn.name}" 缺少驱动：${driver.reason}`);

  // ── 快路径：常驻 JVM ──
  const wCapNum = Number(maxAffected);
  const wCap = Number.isFinite(wCapNum) && wCapNum > 0 ? Math.floor(wCapNum) : 1000;
  let fast = null;
  try {
    fast = await tryDaemonWrite(conn, driver, { sql, dryRun: !wCommit, maxAffected: wCap, timeout });
  } catch (daemonErr) {
    fast = { error: String(daemonErr.message || daemonErr) };
  }
  if (fast && fast.error) {
    return { isError: true, content: [{ type: "text", text: `写执行失败 [${conn.name} · 常驻]\n${fast.error}` }] };
  }
  if (fast && (fast.committed !== undefined || fast.aborted)) {
    const whead = `[${conn.name} · 影响 ${fast.affected} 行 · ${fast.committed ? "已提交" : fast.aborted ? "已回滚（超上限）" : "预演未提交"} · 上限 ${wCap} · 常驻]`;
    auditLog({ at: new Date().toISOString(), connection: conn.name, dialect: conn.dialect, target: `${conn.host}:${conn.port}/${conn.database}`, actor: ACTOR, sqlSha256: require("crypto").createHash("sha256").update(sql).digest("hex"), sqlPreview: sql.replace(/\s+/g, " ").slice(0, 300), reason: String(reason), affected: fast.affected, committed: fast.committed, aborted: Boolean(fast.aborted), ddl: isDdl, kind: verdict.kind, ok: true });
    // P1-1：DDL 提交后 schema 缓存必须失效（否则 db_schema 最长脏 10 分钟）
    if (fast.committed && isDdl) {
      cacheClear(verdict.kind === "destructive" ? undefined : conn.name);
    }
    if (fast.aborted) return { isError: true, content: [{ type: "text", text: `${whead}\n影响行数超过上限 ${wCap}，已自动回滚，未落库。请缩小 WHERE 范围或显式调大 maxAffected。${auditNote()}` }] };
    return { content: [{ type: "text", text: `${whead}\n${fast.committed ? "已提交。审计已记录到 db/_audit.jsonl。" : "预演：真实提交请再调用一次并传 confirm=YES。"} ${auditNote()}` }] };
  }
  // fast === null：走一次性进程

  const classDir = compileClassSync();
  const cp = [classDir, ...driver.jars].join(path.delimiter);
  const tmp = path.join(os.tmpdir(), `dbw-${process.pid}-${Date.now()}.sql`);
  fs.writeFileSync(tmp, sql, "utf8");

  const commit = String(confirm || "").toUpperCase() === "YES";
  const capNum = Number(maxAffected);
  const cap = Number.isFinite(capNum) && capNum > 0 ? Math.floor(capNum) : 1000;
  const args = [
    "-Dfile.encoding=UTF-8",
    "-cp",
    cp,
    "DbQuery",
    "--file",
    tmp,
    "--config",
    conn.file,
    "--write",
    "--max-affected",
    String(cap),
  ];
  if (!commit) args.push("--dry-run");

  const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java.exe") : "java";
  return new Promise((resolve) => {
    execFile(java, args, { encoding: "utf8", windowsHide: true, timeout: 150000, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      fs.unlink(tmp, () => {});
      const raw = `${stdout || ""}\n${stderr || ""}`.trim();
      const m = /AFFECTED=(\d+)\s+COMMITTED=(true|false)/.exec(raw);
      const affected = m ? Number(m[1]) : null;
      const committed = m ? m[2] === "true" : false;
      const aborted = /ABORTED=/.test(raw);

      auditLog({
        at: new Date().toISOString(),
        connection: conn.name,
        dialect: conn.dialect,
        target: `${conn.host}:${conn.port}/${conn.database}`,
        actor: ACTOR,
        sqlSha256: require("crypto").createHash("sha256").update(sql).digest("hex"),
        sqlPreview: sql.replace(/\s+/g, " ").slice(0, 300),
        reason: String(reason),
        affected,
        committed,
        aborted,
        ddl: isDdl,
        kind: verdict.kind,
        ok: !error && m !== null,
      });

      // P1-1：DDL 提交后立即失效 schema 缓存（一次性进程路径）
      if (committed && isDdl) {
        cacheClear(verdict.kind === "destructive" ? undefined : conn.name);
      }

      if (error || !m) {
        resolve({ isError: true, content: [{ type: "text", text: `写执行失败 [${conn.name}]\n${raw.slice(0, 900)}${auditNote()}` }] });
        return;
      }
      const head = `[${conn.name} · 影响 ${affected} 行 · ${committed ? "已提交" : aborted ? "已回滚（超上限）" : "预演未提交"} · 上限 ${cap}]`;
      if (aborted) {
        resolve({
          isError: true,
          content: [{ type: "text", text: `${head}\n影响行数超过上限 ${cap}，已自动回滚，未落库。请缩小 WHERE 范围或显式调大 maxAffected。${auditNote()}` }],
        });
        return;
      }
      const tail = committed
        ? "已提交。审计已记录到 db/_audit.jsonl。"
        : `预演：真实提交请再调用一次并传 confirm="YES"。`;
      resolve({ content: [{ type: "text", text: `${head}\n${tail}${auditNote()}` }] });
    });
  });
}

// ── MCP 服务 ─────────────────────────────────────────────────────────────────
const server = new Server({ name: "db-query", version: "2.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "db_query",
      description:
        "通用只读 SQL 查询（达梦/MySQL 协议族/PostgreSQL 协议族/SQL Server/Oracle/SQLite/DB2/ClickHouse/Trino/H2，任意库也可用 url+driverClass）。" +
        "查表结构、字段、索引、数据核对、SQL 排查一律用它，禁止另写 Python/Java 查库脚本。只放行 SELECT/WITH/SHOW/DESC/EXPLAIN/VALUES。先用 db_connections 看连接。" +
        "【重要】只要这次要查的东西不止一条 SQL，就把它们全部放进 sqls 数组一次提交（≤20 条），不要循环单条调用 sql ——" +
        "每次单条调用都等于一轮完整的模型往返，是真正的时间大头；SQL 执行本身只要 10-30ms。",
      inputSchema: {
        type: "object",
        properties: {
          sqls: {
            type: "array",
            items: { type: "string" },
            maxItems: 20,
            description: "【首选】批量只读 SQL（≤20 条）：一次建连顺序执行，每条独立过只读守卫，单条失败只影响该块。要查 2 条以上就一律用这个。",
          },
          sql: { type: "string", description: "【仅在确实只有一条 SQL 时用】单条只读 SQL（建议带 LIMIT；多语句会被拒绝）" },
          connection: { type: "string", description: "连接名，默认 default（见 db_connections）" },
          format: { type: "string", enum: ["table", "json"], default: "table", description: "table=Markdown 表格；json=JSON 数组" },
          maxRows: { type: "number", description: `返回行数上限，默认 ${MAX_ROWS_DEFAULT}（驱动层截断，两种格式都合法）` },
          timeout: { type: "number", description: "语句超时秒数，默认由驱动决定" },
        },
      },
    },
    {
      name: "db_connections",
      description: "列出本机已配置的数据库连接及其驱动状态（只回显 dialect/host/port/database/user，永不回显密码）。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "db_dialects",
      description: "列出支持的数据库方言、各自驱动是否已就绪（本地/缓存/可自动下载），以及如何接入未内置的数据库。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "db_schema",
      description: "查表结构（列名/类型/可空/注释），带 10 分钟本地缓存；支持达梦/MySQL/MSSQL/PG/Oracle/SQLite。比手写 information_schema 快且省 token。",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", description: "表名（不区分大小写）" },
          schema: { type: "string", description: "schema/owner（默认取连接配置的 database；达梦多 schema 同表名时必填）" },
          connection: { type: "string", description: "连接名，默认 default" },
          refresh: { type: "boolean", description: "跳过缓存强制刷新" },
        },
        required: ["table"],
      },
    },
    {
      name: "db_search_columns",
      description: "全库模糊搜索列名（回答「这个字段在哪些表」），带缓存。",
      inputSchema: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "列名关键字（模糊匹配，不区分大小写）" },
          schema: { type: "string", description: "schema/owner（默认取连接配置的 database）" },
          connection: { type: "string", description: "连接名，默认 default" },
        },
        required: ["keyword"],
      },
    },
    {
      name: "db_execute",
      description:
        "【写操作，分级授权】只读→DML(allowWrite)→DDL(allowDdl)→破坏性(allowDestructive)，默认全关；" +
        "DML: insert/update/delete/merge/replace（UPDATE/DELETE 必须带 WHERE）；DDL: create table|index、alter table add|modify、comment on、drop index；" +
        "破坏性: drop table/truncate/drop column（需 allowDestructive）；grant/revoke/call/exec 永远禁止；" +
        "DML 不传 confirm 时「执行后回滚」报影响行数；DDL 因隐式提交不可回滚，预演只做静态校验不执行；传 confirm=\"YES\" 才真正执行；DML 超 maxAffected（默认 1000）自动回滚；每次写都记审计。必须给 reason。",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "单条写语句（禁 DDL、禁多语句）" },
          connection: { type: "string", description: "连接名（必须在该连接 json 里设 allowWrite: true）" },
          reason: { type: "string", description: "为什么要改（≥6 字，写入审计日志）" },
          confirm: { type: "string", description: '预演不传；确认提交传 "YES"' },
          maxAffected: { type: "number", description: "允许影响的最大行数，默认 1000（超出自动回滚）" },
        },
        required: ["sql", "reason"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  if (name === "db_connections") {
    const all = listConnections();
    if (!all.length) {
      return { content: [{ type: "text", text: `未发现任何连接。把连接配置放到 ${DB_DIR}\\<name>.json（格式见 connections.example.json）。` }] };
    }    const settings = driverSettings();
    const lines = [];
    for (const c of all) {
      if (c.error) {
        lines.push(`- ${c.name}: ${c.error}`);
        continue;
      }
      const driver = await resolveDriver(c, settings, false);
      const drv = driver.missing ? `⚠ ${driver.reason}` : `驱动 ${driver.source}`;
      const target = c.url ? c.url : c.host ? `${c.dialect} ${c.host}:${c.port}/${c.database}` : `${c.dialect} ${c.database || "(未指定库)"}`;
      const grant = c.allowDestructive ? "⚠可写+DDL+破坏性" : c.allowDdl ? "⚠可写+DDL" : c.allowWrite ? "⚠可写" : "只读";
      lines.push(`- ${c.name}: ${target} (user=${c.user}${c.hasPassword ? "" : "，⚠无密码"}) · ${grant} · ${drv}`);
    }
    return { content: [{ type: "text", text: `可用连接：\n${lines.join("\n")}\n\n配置目录：${DB_DIR}` }] };
  }

  if (name === "db_dialects") {
    const settings = driverSettings();
    const groups = [
      ["达梦", ["dm"]],
      ["MySQL 协议族", ["mysql", "mariadb", "tidb", "oceanbase", "starrocks", "doris", "goldendb"]],
      ["PostgreSQL 协议族", ["postgresql", "opengauss", "gaussdb", "kingbase", "highgo", "vastbase"]],
      ["SQL Server", ["mssql", "sqlserver"]],
      ["Oracle", ["oracle"]],
      ["SQLite", ["sqlite", "sqlite3"]],
      ["DB2", ["db2"]],
      ["ClickHouse", ["clickhouse"]],
      ["Trino / Presto", ["trino", "presto"]],
      ["Hive", ["hive2"]],
      ["H2（本地自检）", ["h2"]],
    ];
    const rows = [];
    for (const [label, dialects] of groups) {
      const key = DIALECT_TO_DRIVER[dialects[0]];
      let status;
      if (!key) status = "需自带驱动（url + driverClass + driverJar）";
      else {
        const spec = DRIVER_SPECS[key];
        const cacheFiles = spec.coords.map((c) => path.join(DRIVER_DIR, mavenRelative(c).file));
        const cached = cacheFiles.every((p) => fs.existsSync(p));
        const m2 = findM2Jar(spec);
        status = cached
          ? "已缓存"
          : m2
            ? `本机 ~/.m2（${path.basename(m2)}）`
            : settings.autoDownload
              ? `首次使用自动下载（${spec.coords.join(" + ")}）`
              : "缺失（自动下载已关）";
      }
      rows.push(`| ${label} | ${dialects.join(" / ")} | ${status} |`);
    }
    return {
      content: [
        {
          type: "text",
          text:
            "| 数据库 | dialect 取值 | 驱动状态 |\n|---|---|---|\n" +
            rows.join("\n") +
            `\n\n驱动目录：${DRIVER_DIR}\n镜像顺序：${settings.repos.join(" → ")}\n` +
            `当前常驻 JVM：${describePool()}\n` +
            "任何未内置的库：连接配置里写 \"url\"(JDBC URL) + \"driverClass\" + \"driverJar\"(可选，缺则按类名无法自动下载)。",
        },
      ],
    };
  }

  if (name === "db_query") {
    if ((!args.sql || !String(args.sql).trim()) && !(Array.isArray(args.sqls) && args.sqls.length)) {
      return { isError: true, content: [{ type: "text", text: "缺少 sql 或 sqls 参数。要查多条时请一次用 sqls 数组提交（≤20 条），不要循环单条调用。" }] };
    }
    try {
      return await runQuery({
        sql: args.sql ? String(args.sql) : null,
        sqls: args.sqls,
        connection: args.connection,
        format: args.format,
        maxRows: args.maxRows ?? args.maxLines,
        timeout: args.timeout,
      });
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }

  if (name === "db_schema") {
    if (!args.table) return { isError: true, content: [{ type: "text", text: "缺少 table 参数。" }] };
    try {
      const conn = resolveConnection(args.connection);
      const key = keyOf(conn.name, conn.dialect, (args.schema || conn.database || "") + "." + args.table);
      if (!args.refresh) {
        const hit = cacheGet(key);
        if (hit) return { content: [{ type: "text", text: `（缓存命中）` + String.fromCharCode(10) + hit }] };
      }
      const spec = buildSchemaSql(conn, args.table, args.schema);
      if (!spec) return { isError: true, content: [{ type: "text", text: `方言 ${conn.dialect} 暂不支持 db_schema。` }] };
      const settings = driverSettings();
      const driver = await resolveDriver(conn, settings, true);
      if (driver.missing) throw new Error(`连接 "${conn.name}" 缺少驱动：${driver.reason}`);
      let fast = null;
      try {
        fast = await tryDaemonQuery(conn, driver, { sql: spec.sql, maxRows: SCHEMA_MAX_ROWS, timeout: SCHEMA_TIMEOUT_SEC, format: "table" });
      } catch (e) {
        fast = { error: String(e.message || e) }; // daemon 不可用（无 JDK / 方言未池化 / 进程异常）
      }
      let text = (fast && fast.text) || "";
      let via = "常驻";
      if (!text) {
        // P1-6：daemon 不可用时回退一次性进程，不让"查结构"能力随 daemon 一起全灭
        const one = await runOneShot(conn, driver, { sql: spec.sql, rows: SCHEMA_MAX_ROWS, timeout: SCHEMA_TIMEOUT_SEC, format: "table" });
        if (one.error) {
          return { isError: true, content: [{ type: "text", text: `查询失败：${(fast && fast.error) ? fast.error + "；一次性进程：" : "daemon 不可用，一次性进程："}${one.error}` }] };
        }
        text = one.text;
        via = "一次性";
      }
      cacheSet(key, text);
      const head = `[${conn.name} · ${conn.dialect} · ${args.table} · ${via}]`;
      return { content: [{ type: "text", text: text + String.fromCharCode(10) + head }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }

  if (name === "db_search_columns") {
    if (!args.keyword) return { isError: true, content: [{ type: "text", text: "缺少 keyword 参数。" }] };
    try {
      const conn = resolveConnection(args.connection);
      const key = keyOf(conn.name, conn.dialect, "__colsearch__" + (args.schema || conn.database || "") + "." + args.keyword);
      const hit = cacheGet(key);
      if (hit) return { content: [{ type: "text", text: `（缓存命中）` + String.fromCharCode(10) + hit }] };
      const spec = buildSearchSql(conn, args.keyword, args.schema);
      if (!spec) return { isError: true, content: [{ type: "text", text: `方言 ${conn.dialect} 暂不支持 db_search_columns。` }] };
      const settings = driverSettings();
      const driver = await resolveDriver(conn, settings, true);
      if (driver.missing) throw new Error(`连接 "${conn.name}" 缺少驱动：${driver.reason}`);
      let fast = null;
      try {
        fast = await tryDaemonQuery(conn, driver, { sql: spec.sql, maxRows: SEARCH_MAX_ROWS, timeout: SEARCH_TIMEOUT_SEC, format: "table" });
      } catch (e) {
        fast = { error: String(e.message || e) };
      }
      let text = (fast && fast.text) || "";
      let via = "常驻";
      if (!text) {
        // P1-6：daemon 不可用时回退一次性进程
        const one = await runOneShot(conn, driver, { sql: spec.sql, rows: SEARCH_MAX_ROWS, timeout: SEARCH_TIMEOUT_SEC, format: "table" });
        if (one.error) {
          return { isError: true, content: [{ type: "text", text: `查询失败：${(fast && fast.error) ? fast.error + "；一次性进程：" : "daemon 不可用，一次性进程："}${one.error}` }] };
        }
        text = one.text;
        via = "一次性";
      }
      cacheSet(key, text);
      const head = `[${conn.name} · ${conn.dialect} · 列名含 "${args.keyword}" · ${via}]`;
      return { content: [{ type: "text", text: text + String.fromCharCode(10) + head }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  }
  if (name === "db_execute") {
    if (!args.sql || !String(args.sql).trim()) return { isError: true, content: [{ type: "text", text: "缺少 sql 参数。" }] };
    try {
      return await runWrite({
        sql: String(args.sql),
        connection: args.connection,
        reason: args.reason,
        confirm: args.confirm,
        maxAffected: args.maxAffected,
        timeout: args.timeout,
      });
    } catch (error) {
      // 被拒/参数不全的写尝试也要留痕（「每次写都记，含被拦」）
      auditLog({
        at: new Date().toISOString(),
        connection: String(args.connection || "default"),
        actor: ACTOR,
        sqlSha256: crypto.createHash("sha256").update(String(args.sql || "")).digest("hex"),
        sqlPreview: String(args.sql || "").replace(/\s+/g, " ").slice(0, 300),
        reason: String(args.reason || ""),
        affected: null,
        committed: false,
        aborted: false,
        ddl: false,
        kind: "rejected",
        ok: false,
        note: String(error.message || error).slice(0, 300),
      });
      return { isError: true, content: [{ type: "text", text: error.message + auditNote() }] };
    }
  }

  throw new Error(`未知工具: ${name}`);
});

async function run() {
  await server.connect(new StdioServerTransport());
}

run().catch((err) => {
  process.stderr.write(`db-query MCP 致命错误: ${err.message}\n`);
  process.exit(1);
});
