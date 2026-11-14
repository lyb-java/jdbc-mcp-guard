# Roadmap

## 0.2.0 (current)

- Schema + column-search SQL for **DB2, ClickHouse, Trino/Presto, H2** (10 dialect families in total).
- Docker image (`Dockerfile`, Node 20 + JRE 17).
- Packaged-install smoke test (`npm run test:pack`).
- 55-assertion regression suite.

## 0.3 candidates

- **English i18n** — user-facing messages are currently Chinese; add a message catalog and `JMG_LANG`.
- **HTTP/SSE transport** with token auth, for remote/team deployments.
- Integration tests against real database containers (MySQL, PostgreSQL, DM8) in CI.
- Release automation: npm publish + Docker image + GitHub Release on tag.
- Statement-level cancel on timeout (abort the JDBC statement, not just the MCP request).

## Non-goals

- Becoming a full SQL parser / query planner.
- Replacing database-side permissions — the account is always the first line of defense.
