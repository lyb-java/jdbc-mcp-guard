/**
 * schema-cache —— db_schema / db_search_columns 的方言适配 + 本地缓存。
 * ---------------------------------------------------------------------------
 * 为什么：AI 排查时最高频是"这表有哪些列""这个字段在哪个表"。每次都现写
 * ALL_TAB_COLUMNS / information_schema 大 SQL，跨方言还要记不同写法，且每次
 * 都吃一次建连成本。这里统一封装 + 内存/磁盘缓存（默认 TTL 10 分钟）。
 *
 * 对外：
 *   buildSchemaSql(meta, table)        -> { sql, columns: [name,type,nullable,comment] 映射规则 } | null
 *   buildSearchSql(meta, keyword)      -> { sql } | null
 *   cacheGet(key) / cacheSet(key, val) -> 进程内 + 磁盘缓存
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const JMG_HOME = process.env.JMG_HOME || path.join(os.homedir(), ".jdbc-mcp-guard");
const CACHE_DIR = path.join(JMG_HOME, "cache", "schema");
const TTL_MS = Number(process.env.JMG_SCHEMA_TTL_MS || 10 * 60 * 1000);
const mem = new Map();

const q = (v) => String(v == null ? "" : v).replace(/'/g, "''");

const DIALECT_FAMILY = {
  dm: "dm",
  mysql: "mysql", mariadb: "mysql", tidb: "mysql", oceanbase: "mysql",
  starrocks: "mysql", doris: "mysql", goldendb: "mysql",
  postgresql: "postgresql", postgres: "postgresql", opengauss: "postgresql",
  gaussdb: "postgresql", kingbase: "postgresql", highgo: "postgresql", vastbase: "postgresql",
  mssql: "mssql", sqlserver: "mssql",
  oracle: "oracle",
  sqlite: "sqlite", sqlite3: "sqlite",
  db2: "db2",
  clickhouse: "clickhouse",
  trino: "trino", presto: "trino",
  h2: "h2",
};

function familyOf(dialect) {
  return DIALECT_FAMILY[String(dialect || "").toLowerCase()] || null;
}

/** 表结构查询：返回 SQL（列名统一为 NAME/TYPE/NULLABLE/REMARK）*/
function buildSchemaSql(meta, table, schema) {
  const fam = familyOf(meta.dialect);
  const rawTable = String(table || "");
  const rawSchema = String(schema || meta.database || "");
  if (fam === "dm") {
    const t = q(rawTable.toUpperCase());
    const sc = q(rawSchema.toUpperCase());
    return {
      sql:
        "SELECT c.COLUMN_NAME AS NAME, c.DATA_TYPE AS TYPE, c.NULLABLE AS NULLABLE, " +
        "COALESCE(cm.COMMENTS, '') AS REMARK " +
        "FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cm " +
        "ON cm.OWNER = c.OWNER AND cm.TABLE_NAME = c.TABLE_NAME AND cm.COLUMN_NAME = c.COLUMN_NAME " +
        `WHERE c.TABLE_NAME = '${t}' AND c.OWNER = '${sc}' ORDER BY c.COLUMN_ID`,
    };
  }
  if (fam === "mysql") {
    // MySQL 的 information_schema 是"整个实例"的视图：必须带 TABLE_SCHEMA，
    // 否则同名表（多个库都有 znhj_* 时很常见）会把各库的列混在一起重复输出。
    const t = q(rawTable);
    const sc = q(rawSchema);
    return {
      sql:
        "SELECT COLUMN_NAME AS NAME, COLUMN_TYPE AS TYPE, IS_NULLABLE AS NULLABLE, " +
        "COALESCE(COLUMN_COMMENT, '') AS REMARK FROM information_schema.COLUMNS " +
        `WHERE TABLE_NAME = '${t}' AND TABLE_SCHEMA = '${sc}' ORDER BY ORDINAL_POSITION`,
    };
  }
  if (fam === "mssql") {
    const t = q(rawTable.toUpperCase());
    const sc = q(rawSchema.toUpperCase());
    return {
      sql:
        "SELECT c.COLUMN_NAME AS NAME, c.DATA_TYPE AS TYPE, c.IS_NULLABLE AS NULLABLE, " +
        "COALESCE(CAST(ep.value AS NVARCHAR(4000)), '') AS REMARK FROM INFORMATION_SCHEMA.COLUMNS c " +
        "LEFT JOIN sys.extended_properties ep ON ep.major_id = OBJECT_ID(c.TABLE_NAME) " +
        "AND ep.minor_id = c.ORDINAL_POSITION AND ep.name = 'MS_Description' " +
        `WHERE c.TABLE_NAME = '${t}' AND c.TABLE_SCHEMA = '${sc}' ORDER BY c.ORDINAL_POSITION`,
    };
  }
  if (fam === "postgresql") {
    const t = q(rawTable.toLowerCase());
    const sc = q(rawSchema);
    return {
      sql:
        "SELECT c.column_name AS name, c.data_type AS type, c.is_nullable AS nullable, " +
        "COALESCE(pgd.description, '') AS remark FROM information_schema.columns c " +
        "LEFT JOIN pg_catalog.pg_statio_all_tables st ON st.relname = c.table_name " +
        "LEFT JOIN pg_catalog.pg_description pgd ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position " +
        `WHERE c.table_name = '${t}' AND c.table_schema = '${sc}' ORDER BY c.ordinal_position`,
    };
  }
  if (fam === "oracle") {
    const t = q(rawTable.toUpperCase());
    const sc = q(rawSchema.toUpperCase());
    return {
      sql:
        "SELECT c.COLUMN_NAME AS NAME, c.DATA_TYPE AS TYPE, c.NULLABLE AS NULLABLE, " +
        "COALESCE(m.COMMENTS, '') AS REMARK FROM ALL_TAB_COLUMNS c " +
        "LEFT JOIN ALL_COL_COMMENTS m ON m.OWNER = c.OWNER AND m.TABLE_NAME = c.TABLE_NAME " +
        "AND m.COLUMN_NAME = c.COLUMN_NAME " +
        `WHERE c.TABLE_NAME = '${t}' AND c.OWNER = '${sc}' ORDER BY c.COLUMN_ID`,
    };
  }
  if (fam === "sqlite") {
    // 用表值 PRAGMA 函数并统一列名，避免 sqlite 返回 cid/notnull/pk 这套原始列
    return {
      sql:
        "SELECT name AS NAME, type AS TYPE, CASE WHEN \"notnull\" = 1 THEN 'NO' ELSE 'YES' END AS NULLABLE, " +
        `'' AS REMARK FROM pragma_table_info('${q(rawTable)}') ORDER BY cid`,
    };
  }
  if (fam === "db2") {
    const t = q(rawTable.toUpperCase());
    const sc = q(rawSchema.toUpperCase());
    return {
      sql:
        "SELECT COLNAME AS NAME, TYPENAME AS TYPE, " +
        "CASE WHEN NULLS = 'Y' THEN 'YES' ELSE 'NO' END AS NULLABLE, " +
        "COALESCE(REMARKS, '') AS REMARK FROM SYSCAT.COLUMNS " +
        `WHERE TABNAME = '${t}' AND TABSCHEMA = '${sc}' ORDER BY COLNO`,
    };
  }
  if (fam === "clickhouse") {
    const t = q(rawTable);
    const sc = q(rawSchema);
    return {
      sql:
        "SELECT name AS NAME, type AS TYPE, 'YES' AS NULLABLE, COALESCE(comment, '') AS REMARK " +
        `FROM system.columns WHERE table = '${t}' AND database = '${sc}' ORDER BY position`,
    };
  }
  if (fam === "trino") {
    const t = q(rawTable.toLowerCase());
    const sc = q(rawSchema);
    return {
      sql:
        "SELECT column_name AS NAME, data_type AS TYPE, is_nullable AS NULLABLE, COALESCE(comment, '') AS REMARK " +
        `FROM information_schema.columns WHERE table_name = '${t}' AND table_schema = '${sc}' ORDER BY ordinal_position`,
    };
  }
  if (fam === "h2") {
    const t = q(rawTable.toUpperCase());
    const sc = q(rawSchema.toUpperCase());
    return {
      sql:
        "SELECT COLUMN_NAME AS NAME, DATA_TYPE AS TYPE, IS_NULLABLE AS NULLABLE, COALESCE(REMARKS, '') AS REMARK " +
        `FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${t}' AND TABLE_SCHEMA = '${sc}' ORDER BY ORDINAL_POSITION`,
    };
  }
  return null;
}

/** 全库搜列名（模糊）*/
function buildSearchSql(meta, keyword, schema) {
  const fam = familyOf(meta.dialect);
  const k = q(String(keyword || "").toUpperCase());
  const rawSchema = String(schema || meta.database || "");
  if (fam === "dm") {
    const sc = q(rawSchema.toUpperCase());
    return { sql: `SELECT TABLE_NAME AS TAB, COLUMN_NAME AS COL, DATA_TYPE AS TYPE FROM ALL_TAB_COLUMNS WHERE UPPER(COLUMN_NAME) LIKE '%${k}%' AND OWNER = '${sc}' ORDER BY TABLE_NAME, COLUMN_ID` };
  }
  if (fam === "mysql") {
    const sc = q(rawSchema);
    return { sql: `SELECT TABLE_NAME AS TAB, COLUMN_NAME AS COL, COLUMN_TYPE AS TYPE FROM information_schema.COLUMNS WHERE UPPER(COLUMN_NAME) LIKE '%${k}%' AND TABLE_SCHEMA = '${sc}' ORDER BY TABLE_NAME, ORDINAL_POSITION` };
  }
  if (fam === "mssql") {
    const sc = q(rawSchema.toUpperCase());
    return { sql: `SELECT TABLE_NAME AS TAB, COLUMN_NAME AS COL, DATA_TYPE AS TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE UPPER(COLUMN_NAME) LIKE '%${k}%' AND TABLE_SCHEMA = '${sc}' ORDER BY TABLE_NAME, ORDINAL_POSITION` };
  }
  if (fam === "postgresql") {
    const sc = q(rawSchema);
    return { sql: `SELECT table_name AS tab, column_name AS col, data_type AS type FROM information_schema.columns WHERE UPPER(column_name) LIKE '%${k}%' AND table_schema = '${sc}' ORDER BY table_name, ordinal_position` };
  }
  if (fam === "oracle") {
    const sc = q(rawSchema.toUpperCase());
    return { sql: `SELECT TABLE_NAME AS TAB, COLUMN_NAME AS COL, DATA_TYPE AS TYPE FROM ALL_TAB_COLUMNS WHERE UPPER(COLUMN_NAME) LIKE '%${k}%' AND OWNER = '${sc}' ORDER BY TABLE_NAME, COLUMN_ID` };
  }
  if (fam === "sqlite") {
    return { sql: `SELECT name AS TAB, '' AS COL, sql AS TYPE FROM sqlite_master WHERE type='table' AND UPPER(sql) LIKE '%${k}%' ORDER BY name` };
  }
  if (fam === "db2") {
    const sc = q(rawSchema.toUpperCase());
    return { sql: `SELECT TABNAME AS TAB, COLNAME AS COL, TYPENAME AS TYPE FROM SYSCAT.COLUMNS WHERE UPPER(COLNAME) LIKE '%${k}%' AND TABSCHEMA = '${sc}' ORDER BY TABNAME, COLNO` };
  }
  if (fam === "clickhouse") {
    const sc = q(rawSchema);
    return { sql: `SELECT table AS TAB, name AS COL, type AS TYPE FROM system.columns WHERE UPPER(name) LIKE '%${k}%' AND database = '${sc}' ORDER BY table, position` };
  }
  if (fam === "trino") {
    const sc = q(rawSchema);
    return { sql: `SELECT table_name AS tab, column_name AS col, data_type AS type FROM information_schema.columns WHERE UPPER(column_name) LIKE '%${k}%' AND table_schema = '${sc}' ORDER BY table_name, ordinal_position` };
  }
  if (fam === "h2") {
    const sc = q(rawSchema.toUpperCase());
    return { sql: `SELECT TABLE_NAME AS TAB, COLUMN_NAME AS COL, DATA_TYPE AS TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE UPPER(COLUMN_NAME) LIKE '%${k}%' AND TABLE_SCHEMA = '${sc}' ORDER BY TABLE_NAME, ORDINAL_POSITION` };
  }
  return null;
}

// ── 缓存：进程内 Map + 磁盘 JSON（跨会话复用）────────────────────────────────
function keyOf(connName, dialect, table) {
  return connName + "|" + dialect + "|" + String(table).toUpperCase();
}

function cacheGet(key) {
  const now = Date.now();
  const hit = mem.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.val;
  try {
    const f = path.join(CACHE_DIR, encodeURIComponent(key) + ".json");
    const disk = JSON.parse(fs.readFileSync(f, "utf8"));
    if (disk && now - disk.at < TTL_MS) {
      mem.set(key, disk);
      return disk.val;
    }
  } catch { /* miss */ }
  return null;
}

function cacheSet(key, val) {
  const entry = { at: Date.now(), val };
  mem.set(key, entry);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, encodeURIComponent(key) + ".json"), JSON.stringify(entry), "utf8");
  } catch { /* 缓存失败不影响主流程 */ }
}

function cacheClear(connName) {
  let n = 0;
  for (const k of [...mem.keys()]) {
    if (!connName || k.startsWith(connName + "|")) { mem.delete(k); n++; }
  }
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const key = decodeURIComponent(f.replace(/\.json$/, ""));
      if (!connName || key.startsWith(connName + "|")) { fs.unlinkSync(path.join(CACHE_DIR, f)); n++; }
    }
  } catch { /* ignore */ }
  return n;
}

module.exports = { buildSchemaSql, buildSearchSql, cacheGet, cacheSet, cacheClear, keyOf, TTL_MS };
