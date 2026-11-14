# Changelog

## 0.1.0 — 2026-11-14

Initial public release.

- MCP server over stdio with six tools: `db_query`, `db_execute`, `db_connections`, `db_dialects`, `db_schema`, `db_search_columns`.
- Tiered write permissions: read-only / DML / DDL / destructive, all off by default.
- Masked-SQL write guard: comment- and literal-aware WHERE enforcement (including MySQL backslash escapes), multi-statement and file-I/O rejection.
- Dry-run by default for DML (execute + rollback + affected-row report); static-only preview for DDL.
- `maxAffected` automatic rollback guard.
- Audit log with rejected/dry-run/failed writes and size-based rotation.
- JDBC driver auto-resolution: config → cache → `~/.m2` → Maven mirrors.
- Pooled long-lived JVM fast path with one-shot fallback.
- 11 driver families / 26 dialect aliases + arbitrary JDBC.
- 50-assertion offline regression suite (SQLite + H2).