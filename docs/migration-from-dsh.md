# Migrating from the DSH-bundled db-query MCP

Up to 2026-11-14 the database MCP lived inside the DSH config repo
(`~/.dsh/mcp-servers/`). It now lives here. DSH keeps a two-dozen-line shim that
loads this project.

## What moved where

| Old (DSH) | New (this project) |
|---|---|
| `~/.dsh/mcp-servers/db-query-server.js` + 6 modules | `server.js` + `write-guard.js` + `java-runner.js` + `daemon-path.js` + `schema-cache.js` + `java-bridge.js` |
| `~/.dsh/mcp-servers/db/*.java` | `db/DbQuery.java`, `db/DbQueryDaemon.java` (+ prebuilt jar) |
| `~/.dsh/db/*.json` (connections) | `~/.jdbc-mcp-guard/connections/*.json` |
| `~/.dsh/db/drivers/*.jar` | `~/.jdbc-mcp-guard/drivers/*.jar` |
| `~/.dsh/db/_audit.jsonl` | `~/.jdbc-mcp-guard/audit.jsonl` |
| `DSH_DB_*` env vars | `JMG_*` env vars (`DSH_DB_ACTOR` is mapped by the shim) |

## DSH shim

`~/.dsh/mcp-servers/db-query-server.js` now only locates this project and
`require()`s `server.js`. Lookup order:

1. `JMG_PROJECT`
2. `D:/devSoft/ideaProject/jdbc-mcp-guard`
3. `~/jdbc-mcp-guard`
4. `~/projects/jdbc-mcp-guard`

If none exists it fails loudly with an actionable message.

## Another machine

```bash
git clone <repo-url> ~/jdbc-mcp-guard
cd ~/jdbc-mcp-guard && npm install
# optional: npm test
```

Then either rely on the `~/jdbc-mcp-guard` default, or set `JMG_PROJECT` to the
checkout path (e.g. in the DSH process environment).

## Rollback

The previous implementation is preserved in the DSH git history and, on the
machine where the migration was performed, in `~/.dsh/tmp/db-query-server.legacy.js`:

```bash
cp ~/.dsh/tmp/db-query-server.legacy.js ~/.dsh/mcp-servers/db-query-server.js
# restart DSH
```

## Verify after switching

```bash
node scripts/selfcheck.js                        # runs this project's server
node scripts/selfcheck.js --server ~/.dsh/mcp-servers/db-query-server.js   # runs the DSH shim
```
