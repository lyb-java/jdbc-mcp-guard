# jdbc-mcp-guard

**Safe writes for any JDBC database, over MCP.**

An [MCP](https://modelcontextprotocol.io) server that lets AI agents query **and safely modify** any JDBC database — with four-level write permissions, an explicit confirm flow, automatic rollback on oversized changes, and a full audit trail.

Works with any JDBC driver: **Dameng (DM8), MySQL / MariaDB / TiDB / OceanBase / Doris / StarRocks, PostgreSQL / openGauss / GaussDB / Kingbase / HighGo / Vastbase, SQL Server, Oracle, SQLite, DB2, ClickHouse, Trino, Presto, H2** — or your own `url` + `driverClass`.

> Most database MCP servers are read-only (safe but limited) or unrestricted (convenient but dangerous). This one is built for the middle ground: **let the agent write, but never blind.**

---

## Why

- **Read-only MCPs** (dbhub, mcp-dbutils) can't do migrations, fixes, or data corrections.
- **Unrestricted MCPs** (mcp-alchemy's `execute_query`) hand the LLM an AUTOCOMMIT connection — one bad `UPDATE` without `WHERE` and the table is gone.
- **jdbc-mcp-guard** adds the missing safety layer:
  - 4 permission tiers per connection: read-only → DML → DDL → destructive;
  - `UPDATE` / `DELETE` / `MERGE` **must** have a `WHERE` (checked on masked SQL, so comments and string literals can't fake it);
  - DML is **dry-run by default** (executed then rolled back, reporting the affected row count);
  - `maxAffected` guard rolls back any write that touches too many rows;
  - every write — **including rejected ones** — is appended to `audit.jsonl`.

## Features

| | |
|---|---|
| **Any JDBC database** | 15 driver families / 27 dialect aliases + arbitrary JDBC via `url` + `driverClass` |
| **Zero driver setup** | drivers are resolved from the connection config, local cache, `~/.m2`, or downloaded from Maven Central |
| **Tiered writes** | `allowWrite` (DML), `allowDdl` (DDL), `allowDestructive` (DROP / TRUNCATE / DROP COLUMN) — off by default |
| **Two-phase DDL** | DDL is *statically validated* first (no execution), then committed with `confirm: "YES"` |
| **Row-count guard** | writes affecting more than `maxAffected` rows (default 1000) are rolled back automatically |
| **Audit** | `$JMG_HOME/audit.jsonl`, includes dry-run, rejected and failed attempts; size-based rotation |
| **Fast path** | pooled long-lived JVM per driver classpath (milliseconds after the first query); falls back to a one-shot process if a driver misbehaves |
| **Schema tools** | `db_schema` / `db_search_columns` for DM, MySQL, PostgreSQL, SQL Server, Oracle, SQLite; cached for 10 minutes (invalidated after DDL) |

## Quick start

Requirements: **Node.js ≥ 20** and **JDK 17+** (the server talks to databases through a small Java JDBC bridge).

```bash
git clone <repo-url> jdbc-mcp-guard
cd jdbc-mcp-guard
npm install
```

Create a connection file (one file per connection):

```bash
mkdir -p ~/.jdbc-mcp-guard/connections
```

`~/.jdbc-mcp-guard/connections/default.json`:

```json
{
  "database": {
    "dialect": "postgresql",
    "host": "127.0.0.1",
    "port": 5432,
    "database": "app",
    "user": "app_user",
    "password": "REPLACE_ME",
    "allowWrite": false,
    "allowDdl": false,
    "allowDestructive": false
  }
}
```

Run it:

```bash
node server.js
```

It speaks MCP over stdio, so you normally register it in your client instead:

```json
{
  "mcpServers": {
    "jdbc": {
      "command": "node",
      "args": ["/absolute/path/to/jdbc-mcp-guard/server.js"],
      "env": { "JMG_HOME": "/absolute/path/to/.jdbc-mcp-guard" }
    }
  }
}
```

See [examples/](examples/) for more connection templates (MySQL, DM8, Oracle, custom JDBC) and [docs/mcp-clients.md](docs/mcp-clients.md) for Claude Desktop / Cursor / generic stdio configs.

## Tools

| Tool | Purpose |
|---|---|
| `db_query` | Read-only SQL. Single statement or a batch of up to 20 (`sqls`). `format: "json"` for JSON output, `maxRows` (default 200). |
| `db_execute` | Write SQL with tiered permissions. Default is **dry-run** (execute + rollback); pass `confirm: "YES"` to commit. Requires a `reason` (≥6 chars) that is written to the audit log. |
| `db_connections` | List configured connections, their dialect/target and write permissions. |
| `db_dialects` | List supported dialects, driver mapping and the live JVM pool. |
| `db_schema` | Table columns / types / nullability / comments (DM, MySQL, PG, MSSQL, Oracle, SQLite). |
| `db_search_columns` | Find which table contains a column name (same six families). |

## Permission model

Everything is **off by default**. Permissions live in the connection file:

```json
"allowWrite": true,        // INSERT / UPDATE / DELETE / MERGE / REPLACE
"allowDdl": true,          // CREATE TABLE|INDEX, ALTER TABLE ADD|MODIFY, COMMENT ON, DROP INDEX
"allowDestructive": false  // DROP TABLE, TRUNCATE, DROP COLUMN — keep this false in production
```

Guard rules (see [docs/security-model.md](docs/security-model.md)):

1. `UPDATE` / `DELETE` / `MERGE` without a real `WHERE` are rejected — verification runs on **masked SQL** (block/line comments and string literals are blanked first; MySQL backslash escapes are dialect-aware).
2. A statement containing multiple statements is rejected.
3. `GRANT` / `REVOKE` / `CALL` / `EXEC` and file I/O (`INTO OUTFILE`, `LOAD_FILE`, `COPY`, `pg_read_file`, …) are always rejected.
4. DDL is never executed during dry-run; DML dry-runs are rolled back.
5. Writes touching more rows than `maxAffected` are rolled back.

**Defense in depth:** the first line of defense is the database account itself. Use a read-only account for read-only connections and grant DML only where you actually need it.

## Configuration

### Connection file

`$JMG_HOME/connections/<name>.json` (default `$JMG_HOME` = `~/.jdbc-mcp-guard`):

| Field | Description |
|---|---|
| `dialect` | `dm` `mysql` `postgresql` `mssql` `oracle` `sqlite` `db2` `clickhouse` `trino` `presto` `h2` + aliases (see `db_dialects`) |
| `host` / `port` / `database` / `user` / `password` | Standard JDBC coordinates |
| `url` | Optional full JDBC URL (overrides host/port/database) |
| `driverClass` | Optional; inferred from `dialect` when omitted |
| `driverJar` | Optional absolute path (or array) to a driver jar |
| `allowWrite` / `allowDdl` / `allowDestructive` | Permission tiers (default `false`) |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `JMG_HOME` | `~/.jdbc-mcp-guard` | Config root: `connections/`, `drivers/`, `audit.jsonl`, `cache/` |
| `JMG_ACTOR` | `ai@<hostname>` | Actor recorded in the audit log |
| `JMG_AUDIT_MAX_BYTES` | `5242880` | Audit rotation threshold |
| `JMG_MAX_DAEMONS` | `4` | Max pooled JVMs |
| `JMG_SCHEMA_TTL_MS` | `600000` | Schema cache TTL |

### Drivers

Drivers are resolved in this order:

1. `driverJar` in the connection file;
2. `$JMG_HOME/drivers.json` `aliases` (custom coordinate overrides);
3. jars already cached in `$JMG_HOME/drivers/`;
4. an existing jar in `~/.m2/repository` (offline-friendly);
5. download from Maven mirrors (`drivers.json.repos`, default Aliyun → Maven Central), then cache.

## Development

```bash
npm install
npm test        # 50 assertions, SQLite + H2, no external database needed
```

The regression suite spins up the MCP server over stdio, exercises every guard tier and cleans up after itself. It needs a JDK and downloads the SQLite/H2 drivers once (`$JMG_HOME/drivers`).

## Limitations / roadmap

- The write guard is a **lexer-level** checker (comments/literals masked, statement classification) — not a full SQL parser. Do not treat it as a substitute for database-side permissions.
- Error messages are currently Chinese; English localization is planned.
- Schema tools cover six dialect families; other dialects can still be queried with `db_query` (`information_schema` etc.).
- stdio transport only; HTTP/SSE transport and multi-tenant auth are on the roadmap.
- `--force`-style escape hatches are intentionally absent: if a write is rejected, fix the SQL or the account permissions.

## License

MIT — see [LICENSE](LICENSE).
