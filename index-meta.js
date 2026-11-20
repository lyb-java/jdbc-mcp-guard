/**
 * index-meta —— db_indexes 的方言适配。
 * 统一五列：NAME（索引/约束名）、KIND（PRIMARY/UNIQUE/INDEX/FOREIGN）、
 *           COL（列名，一列一行）、REF（外键指向的表）、SEQ（列在索引中的位置）。
 * 一列一行而不是聚合：跨方言不必记住 string_agg / group_concat 的差异。
 */
const q = (v) => String(v == null ? "" : v).replace(/'/g, "''");

const FAMILY = {
  dm: "dm",
  mysql: "mysql", mariadb: "mysql", tidb: "mysql", oceanbase: "mysql", starrocks: "mysql", doris: "mysql", goldendb: "mysql",
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

function buildIndexSql(meta, table, schema) {
  const fam = FAMILY[String(meta.dialect || "").toLowerCase()];
  const t = String(table || "");
  const sc = String(schema || meta.database || "");
  if (!t) return { error: "缺少 table 参数。" };

  if (fam === "sqlite") {
    const tt = q(t);
    return {
      sql:
        "SELECT il.name AS NAME, CASE WHEN il.origin='pk' THEN 'PRIMARY' WHEN il.\"unique\"=1 THEN 'UNIQUE' ELSE 'INDEX' END AS KIND, " +
        "ii.name AS COL, '' AS REF_TABLE, ii.seqno+1 AS SEQ " +
        `FROM pragma_index_list('${tt}') il JOIN pragma_index_info(il.name) ii ` +
        "UNION ALL " +
        "SELECT 'PRIMARY' AS NAME, 'PRIMARY' AS KIND, name AS COL, '' AS REF_TABLE, pk AS SEQ " +
        `FROM pragma_table_info('${tt}') WHERE pk > 0 AND NOT EXISTS (SELECT 1 FROM pragma_index_list('${tt}') x WHERE x.origin='pk') ` +
        "UNION ALL " +
        "SELECT 'fk_'||id AS NAME, 'FOREIGN' AS KIND, \"from\" AS COL, \"table\" AS REF_TABLE, seq+1 AS SEQ " +
        `FROM pragma_foreign_key_list('${tt}') ORDER BY 1, 5`,
    };
  }
  if (fam === "mysql") {
    return {
      sql:
        "SELECT INDEX_NAME AS NAME, CASE WHEN INDEX_NAME='PRIMARY' THEN 'PRIMARY' WHEN NON_UNIQUE=0 THEN 'UNIQUE' ELSE 'INDEX' END AS KIND, " +
        "COLUMN_NAME AS COL, '' AS REF_TABLE, SEQ_IN_INDEX AS SEQ " +
        `FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='${q(sc)}' AND TABLE_NAME='${q(t)}' ` +
        "UNION ALL " +
        "SELECT CONSTRAINT_NAME, 'FOREIGN', COLUMN_NAME, CONCAT(REFERENCED_TABLE_NAME, '(', REFERENCED_COLUMN_NAME, ')'), ORDINAL_POSITION " +
        `FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA='${q(sc)}' AND TABLE_NAME='${q(t)}' ` +
        "AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY 1, 5",
    };
  }
  if (fam === "postgresql") {
    const tt = q(t.toLowerCase());
    const ss = q(sc);
    return {
      sql:
        "SELECT c.relname AS name, CASE WHEN i.indisprimary THEN 'PRIMARY' WHEN i.indisunique THEN 'UNIQUE' ELSE 'INDEX' END AS kind, " +
        "a.attname AS col, '' AS ref, k.ord AS seq " +
        "FROM pg_index i " +
        "JOIN pg_class tt ON tt.oid = i.indrelid " +
        "JOIN pg_class c ON c.oid = i.indexrelid " +
        "JOIN LATERAL unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord) ON true " +
        "JOIN pg_attribute a ON a.attrelid = tt.oid AND a.attnum = k.attnum " +
        `WHERE tt.relname='${tt}' AND tt.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='${ss}') ` +
        "UNION ALL " +
        "SELECT con.conname, 'FOREIGN', att.attname, cl2.relname, k.ord " +
        "FROM pg_constraint con " +
        "JOIN pg_class cl ON cl.oid = con.conrelid " +
        "JOIN pg_class cl2 ON cl2.oid = con.confrelid " +
        "JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true " +
        "JOIN pg_attribute att ON att.attrelid = cl.oid AND att.attnum = k.attnum " +
        `WHERE con.contype='f' AND cl.relname='${tt}' AND cl.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='${ss}') ` +
        "ORDER BY 1, 5",
    };
  }
  if (fam === "dm" || fam === "oracle") {
    const tt = q(t.toUpperCase());
    const ss = q(sc.toUpperCase());
    return {
      sql:
        "SELECT i.INDEX_NAME AS NAME, CASE WHEN c.CONSTRAINT_TYPE='P' THEN 'PRIMARY' WHEN i.UNIQUENESS='UNIQUE' THEN 'UNIQUE' ELSE 'INDEX' END AS KIND, " +
        "ic.COLUMN_NAME AS COL, '' AS REF_TABLE, ic.COLUMN_POSITION AS SEQ " +
        "FROM ALL_INDEXES i " +
        "JOIN ALL_IND_COLUMNS ic ON ic.INDEX_OWNER=i.OWNER AND ic.INDEX_NAME=i.INDEX_NAME " +
        "LEFT JOIN ALL_CONSTRAINTS c ON c.OWNER=i.OWNER AND c.INDEX_NAME=i.INDEX_NAME AND c.CONSTRAINT_TYPE='P' " +
        `WHERE i.TABLE_NAME='${tt}' AND i.OWNER='${ss}' ` +
        "UNION ALL " +
        "SELECT c.CONSTRAINT_NAME, 'FOREIGN', cc.COLUMN_NAME, rc.TABLE_NAME, cc.POSITION " +
        "FROM ALL_CONSTRAINTS c " +
        "JOIN ALL_CONS_COLUMNS cc ON cc.OWNER=c.OWNER AND cc.CONSTRAINT_NAME=c.CONSTRAINT_NAME " +
        "JOIN ALL_CONSTRAINTS rc ON rc.OWNER=c.R_OWNER AND rc.CONSTRAINT_NAME=c.R_CONSTRAINT_NAME " +
        `WHERE c.CONSTRAINT_TYPE='R' AND c.TABLE_NAME='${tt}' AND c.OWNER='${ss}' ORDER BY 1, 5`,
    };
  }
  if (fam === "mssql") {
    const obj = q(sc ? sc + "." + t : t);
    return {
      sql:
        "SELECT i.name AS NAME, CASE WHEN i.is_primary_key=1 THEN 'PRIMARY' WHEN i.is_unique=1 THEN 'UNIQUE' ELSE 'INDEX' END AS KIND, " +
        "c.name AS COL, '' AS REF_TABLE, ic.key_ordinal AS SEQ " +
        "FROM sys.indexes i " +
        "JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id AND ic.is_included_column=0 " +
        "JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id " +
        `WHERE i.object_id=OBJECT_ID('${obj}') ` +
        "UNION ALL " +
        "SELECT fk.name, 'FOREIGN', pc.name, OBJECT_NAME(fk.referenced_object_id), fkc.constraint_column_id " +
        "FROM sys.foreign_keys fk " +
        "JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id " +
        "JOIN sys.columns pc ON pc.object_id=fkc.parent_object_id AND pc.column_id=fkc.parent_column_id " +
        `WHERE fk.parent_object_id=OBJECT_ID('${obj}') ORDER BY 1, 5`,
    };
  }
  if (fam === "db2") {
    return {
      sql:
        "SELECT i.INDNAME AS NAME, CASE WHEN i.UNIQUERULE='P' THEN 'PRIMARY' WHEN i.UNIQUERULE='U' THEN 'UNIQUE' ELSE 'INDEX' END AS KIND, " +
        "c.COLNAME AS COL, '' AS REF_TABLE, c.COLSEQ AS SEQ " +
        "FROM SYSCAT.INDEXES i JOIN SYSCAT.INDEXCOLUSE c ON c.INDSCHEMA=i.INDSCHEMA AND c.INDNAME=i.INDNAME " +
        `WHERE i.TABNAME='${q(t.toUpperCase())}' AND i.TABSCHEMA='${q(sc.toUpperCase())}' ORDER BY 1, 5`,
    };
  }
  if (fam === "clickhouse") {
    return {
      sql:
        "SELECT 'PRIMARY' AS NAME, 'PRIMARY' AS KIND, primary_key AS COL, '' AS REF_TABLE, 1 AS SEQ " +
        `FROM system.tables WHERE database='${q(sc)}' AND name='${q(t)}' ` +
        "UNION ALL " +
        "SELECT name, 'INDEX', expr, '', 1 FROM system.data_skipping_indices " +
        `WHERE database='${q(sc)}' AND table='${q(t)}' ORDER BY 1, 5`,
    };
  }
  if (fam === "trino") {
    return { error: "Trino/Presto 的 information_schema 不暴露索引信息，db_indexes 不支持；可用 db_query 查 information_schema.columns。" };
  }
  if (fam === "h2") {
    return { error: "H2 暂不支持 db_indexes；可用 db_query 查 INFORMATION_SCHEMA.INDEXES。" };
  }
  return { error: `方言 ${meta.dialect} 暂不支持 db_indexes。` };
}

module.exports = { buildIndexSql };
