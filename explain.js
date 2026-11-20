/**
 * explain —— db_explain 的方言适配。
 * 只生成只读的 EXPLAIN 语句，绝不加 ANALYZE（部分方言的 EXPLAIN ANALYZE 会真正执行）。
 */
const FAMILY = {
  sqlite: "sqlite", sqlite3: "sqlite",
  mysql: "mysql", mariadb: "mysql", tidb: "mysql", oceanbase: "mysql", starrocks: "mysql", doris: "mysql", goldendb: "mysql",
  postgresql: "postgresql", postgres: "postgresql", opengauss: "postgresql", gaussdb: "postgresql",
  kingbase: "postgresql", highgo: "postgresql", vastbase: "postgresql",
  dm: "dm",
  oracle: "oracle",
  mssql: "mssql", sqlserver: "mssql",
  db2: "db2",
  clickhouse: "clickhouse",
  trino: "trino", presto: "trino",
  hive2: "hive",
  h2: "h2",
};

function normalize(sql) {
  return String(sql == null ? "" : sql).trim().replace(/;+\s*$/, "");
}

/** 返回 { sql } 或 { error } */
function buildExplainSql(dialect, inner) {
  const sql = normalize(inner);
  if (!sql) return { error: "缺少要分析的 SQL（sql 参数）。" };
  if (/;/.test(sql)) return { error: "db_explain 只接受单条语句。" };
  const fam = FAMILY[String(dialect || "").toLowerCase()];
  switch (fam) {
    case "sqlite":
      return { sql: `EXPLAIN QUERY PLAN ${sql}`, note: "SQLite 的 QUERY PLAN 只有访问路径，不含真实耗时。" };
    case "mysql":
      return { sql: `EXPLAIN ${sql}` };
    case "postgresql":
    case "dm":
    case "clickhouse":
    case "trino":
    case "hive":
    case "h2":
      return { sql: `EXPLAIN ${sql}` };
    case "oracle":
      return { error: "Oracle 需要两步：先 EXPLAIN PLAN FOR <sql>，再查 TABLE(DBMS_XPLAN.DISPLAY())。请用 db_query 分两次执行。" };
    case "mssql":
      return { error: "SQL Server 的 SHOWPLAN 必须单独一批执行：请用 db_query 先 SET SHOWPLAN_TEXT ON，再另发一条查询。" };
    case "db2":
      return { error: "DB2 的 EXPLAIN 需要 EXPLAIN 表；暂未封装，请用 db_query 手工执行。" };
    default:
      return { error: `方言 ${dialect} 暂不支持 db_explain。` };
  }
}

module.exports = { buildExplainSql };
