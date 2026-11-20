# Changelog

## 0.3.2 — 2026-11-20

- **Fix**: first-run logs no longer print `[db-query]` — the rebrand is complete in driver, audit and fatal-error messages.
- **Fix**: the commit message points at the real `$JMG_HOME/audit.jsonl` instead of a non-existent `db/_audit.jsonl`.
- **Release automation**: `.github/workflows/release.yml` — on a `v*` tag: tests → GitHub Release (npm tarball) → `npm publish --provenance` → `ghcr.io/lyb-java/jdbc-mcp-guard`.
- **MCP Registry**: `server.json` plus `mcpName` in `package.json`, with the publish/verify flow in `docs/publishing.md`.
- Docs: README gains a 30-second demo, badges and a release section.

## 0.3.1 — 2026-11-17

- **Fix**: `serverInfo` now reports `jdbc-mcp-guard` and the real package version (was `db-query` / `2.1.0`, leaking the old DSH incarnation).
- **Fix**: CLI accepts `--connection` as an alias of `--conn`; unknown flags are now rejected (exit code 2) instead of being silently ignored and falling back to `default`.
- **Fix**: the DSH-side shim must call `run()` explicitly since 0.3.0 added a `require.main` guard — the shim is updated accordingly; `db-query` MCP no longer exits silently.
- Offline CLI regression extended to 7 assertions.

## 0.3.0 — 2026-11-16

- **CLI**: `jdbc-mcp-guard query|exec|connections` reuses the exact same guards, permission tiers and audit as the MCP server — for agents without MCP support and for humans. Writes still require `--reason` and default to dry-run.
- `JMG_NO_DAEMON=1` runs everything through the one-shot JVM path (clean exit, no background daemon).
- Offline CLI regression (`npm run test:cli`, 5 assertions).

## 0.2.1 — 2026-11-14

- `npm run migrate:from-dsh` — idempotent migration of connections and driver cache from the old DSH-bundled layout.
- `npm run docker:smoke` — verifies the image over stdio (`docker run -i`) with a full MCP handshake.
- Dockerfile: `ARG NODE_IMAGE` for registry mirrors; Debian apt mirror is configurable.
- `docs/github-access.md`: per-machine SSH deploy key setup for networks that block github.com:443.

## 0.2.0 — 2026-11-14

- **Schema coverage**: `db_schema` / `db_search_columns` now support **DB2** (`SYSCAT.COLUMNS`), **ClickHouse** (`system.columns`), **Trino/Presto** (`information_schema.columns`) and **H2** (`INFORMATION_SCHEMA`), bringing the total to 10 dialect families.
- **Docker**: `Dockerfile` + `.dockerignore` + `docs/docker.md` (Node 20 + JRE 17 image, stdio over `docker run -i`).
- **Packaged-install smoke test**: `npm run test:pack` — packs the tarball, installs it into a temp dir and verifies the MCP handshake and the six tools.
- `npm pack` file list fixed (java-bridge.js was missing from the published package).
- Regression suite: **55 assertions**.

## 0.1.1 — 2026-11-14

- **Prebuilt JDBC bridge jar** (`db/jdbc-mcp-guard-bridge.jar`): runtime needs only a JRE — `javac` is no longer required unless you rebuild the bridge yourself.
- Added `npm run build:java` (JDK 17+) and shared `java-bridge.js` helper.
- Docs: clarified JRE/JDK requirements; added Claude Code CLI setup.

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