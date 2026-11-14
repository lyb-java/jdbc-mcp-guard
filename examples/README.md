# Connection examples

One file per connection: `$JMG_HOME/connections/<name>.json`. The file name (without `.json`) is the connection name used by the tools; `default.json` is used when a tool omits `connection`.

All write permissions default to **off**. Copy a template to `~/.jdbc-mcp-guard/connections/` and fill in real values — never commit real credentials.

| File | Shows |
|---|---|
| `sqlite.json` | file-based database, writes enabled |
| `mysql-readonly.json` | read-only account (recommended default) |
| `postgres.json` | standard host/port/database |
| `dm.json` | Dameng DM8 |
| `custom-jdbc.json` | any database via `url` + `driverClass` + `driverJar` |
| `drivers.example.json` | driver mirror list and coordinate aliases (`$JMG_HOME/drivers.json`) |
