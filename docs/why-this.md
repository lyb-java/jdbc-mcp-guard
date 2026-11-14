# Why another database MCP?

Because the existing options force a false choice.

| Project | Write safety | Dialects | Dameng / domestic DBs |
|---|---|---|---|
| **jdbc-mcp-guard** | 4 tiers + WHERE guard + dry-run + maxAffected + audit | 15 driver families + any JDBC | ✅ |
| dbhub (bytebase) | read-only only | Go drivers: PG/MySQL/MSSQL/Oracle/SQLite | ❌ |
| mcp-toolbox (Google) | tool allowlist, no SQL guard | 14+ dialects | ❌ |
| postgres-mcp (crystaldba) | two tiers (restricted/unrestricted); restricted had a bypass advisory | PostgreSQL | ❌ |
| mcp-alchemy | none — `execute_query` is AUTOCOMMIT | SQLAlchemy ecosystem | custom dialect only |
| mcp-dbutils | read-only only, stale 18 months | SQLite/MySQL/PG | ❌ |
| dm-mcp-server (Dameng official) | read/write separation, audit | DM/SQLite/MySQL/PG | ✅ (stalled since 2026-07) |

Two things are missing everywhere else:

1. **A credible middle ground for writes.** Agents that can only read cannot do maintenance; agents with unrestricted access are one hallucination away from a data incident. A tiered, audited, dry-run-first write path is the missing piece — for *any* database, not just Postgres.
2. **Coverage for long-tail and domestic databases.** DM8, Kingbase, openGauss/GaussDB, OceanBase, TiDB, DB2, ClickHouse… either have no MCP server or a small stalled one. JDBC is the universal adapter, and this project treats it as a first-class citizen.

## When *not* to use it

- You only need read-only access → dbhub is smaller (Go single binary, no JDK).
- You only use PostgreSQL and want index/EXPLAIN tooling → postgres-mcp.
- You need HTTP/SSE transport and multi-tenant auth today → this project is stdio-only for now.
