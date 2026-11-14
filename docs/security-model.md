# Security model

jdbc-mcp-guard assumes the model is **untrusted**: it may be wrong, may be prompt-injected, or may simply be over-eager. The goal is not to make the model correct — it is to make wrong statements fail loudly and cheaply.

## Defense in depth

| Layer | What it does | Where |
|---|---|---|
| 1. Database account | The account's own privileges are the real boundary. Use a read-only account where possible. | database |
| 2. Statement gate | Rejects writes before they are sent: permission tier, missing `WHERE`, multi-statement, forbidden keywords/file I/O | `write-guard.js` |
| 3. Execution guards | DML dry-run (execute + rollback + row count), DDL static-only preview, `maxAffected` rollback, explicit `confirm: "YES"` | `server.js` / `db/DbQuery.java` |
| 4. Audit | Every write attempt — committed, rolled back, rejected — appended to `audit.jsonl` | `server.js` |

## The statement gate

All checks run on a **masked** copy of the SQL: block comments, string literals and line comments are blanked first (quotes preserved). This prevents the classic bypasses:

| Input | Result |
|---|---|
| `DELETE FROM t # WHERE id=1` (MySQL `#` comment) | rejected — no real `WHERE` |
| `UPDATE t SET note='where'` | rejected — the word is inside a literal |
| `UPDATE t SET note='x\\' WHERE 1=1 #'` | rejected — MySQL backslash escape is handled per dialect |
| `DELETE FROM t WHERE id=1; DROP TABLE t` | rejected — multi-statement |
| `SELECT load_file('/etc/passwd')` | rejected — file I/O, read path included |
| `GRANT ...` / `CALL proc()` | always rejected |

Allowed only when the connection has the matching tier and the statement is a single, well-formed statement.

## Permission tiers

```json
"allowWrite": true        // DML: INSERT / UPDATE / DELETE / MERGE / REPLACE
"allowDdl": true          // DDL: CREATE TABLE|INDEX, ALTER TABLE ADD|MODIFY|ALTER, COMMENT ON, DROP INDEX
"allowDestructive": true  // DROP TABLE, TRUNCATE, DROP COLUMN, DROP VIEW|SCHEMA|DATABASE
```

All default to `false`. Keep `allowDestructive` off in production — destructive DDL cannot be rolled back on MySQL/DM.

## Dry-run semantics

| Kind | Without `confirm` | Why |
|---|---|---|
| DML | executes inside a transaction, then **rolls back**, reports affected rows | rollback is safe and gives a real row count |
| DDL / destructive | **static validation only** — never executed | DDL implicitly commits on MySQL/DM |

To commit: call `db_execute` again with `confirm: "YES"`.

## `maxAffected`

Any write affecting more than `maxAffected` rows (default `1000`, caller-settable) is rolled back automatically:

```
影响行数超过上限 1000，已自动回滚，未落库。
```

This catches the "`WHERE 1=1`" class of mistakes even when a `WHERE` is present.

## Audit

`$JMG_HOME/audit.jsonl` — one JSON object per line:

```json
{"at":"2026-11-14T01:16:24Z","connection":"app","dialect":"mysql","target":"db:3306/app",
 "actor":"ai@host","sqlSha256":"…","sqlPreview":"DELETE FROM t # WHERE id=1",
 "reason":"cleanup","kind":"rejected","ok":false}
```

- rejected writes are audited (`kind:"rejected"`, `ok:false`);
- dry-runs are audited with `committed:false`;
- the file rotates at `JMG_AUDIT_MAX_BYTES` (5 MB default) to `audit.1.jsonl`.

## Known limitations

- The gate is a **lexer-level** checker, not a SQL parser. It is deliberately conservative: false rejections are acceptable, false accepts are not. Do not treat it as a replacement for database permissions or a read-only replica.
- Dialect comment forms that are executable (MySQL `/*! ... */`) are treated as comments by the masker, which can only cause a *rejection*, never an unwanted execution.
- Procedural bodies (`BEGIN ... END`) are not supported; `CALL` / `EXEC` are always rejected.
- The audit is local, append-only and best-effort: if the disk is unwritable, the error is reported in the tool result but the write is not blocked. Ship the audit file to a log collector if you need compliance-grade retention.

## Recommended setup

1. `default.json` → read-only account.
2. One writable connection per database you actually let the agent modify, with `allowWrite:true` only.
3. `maxAffected` as low as your workflow allows.
4. Review `audit.jsonl` (or ship it) — rejected entries are the interesting ones.
