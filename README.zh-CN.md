# jdbc-mcp-guard

[![CI](https://github.com/lyb-java/jdbc-mcp-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/lyb-java/jdbc-mcp-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)
![Java](https://img.shields.io/badge/java-%E2%89%A517-orange.svg)

**给任意 JDBC 数据库的安全写入口，走 MCP。**

让 AI 能查、也能**安全地改**数据库：四级写权限、显式 confirm、超量自动回滚、全量审计。驱动自动解析，支持达梦 DM8、MySQL 协议族、PostgreSQL 协议族、SQL Server、Oracle、SQLite、DB2、ClickHouse 等，也支持任意 JDBC（`url` + `driverClass`）。

> 现有数据库 MCP 大多走两个极端：只读（安全但干不了活）或不设限（能干但一发不可收拾）。这个项目做中间那条线：**允许写，但绝不盲写。**

## 30 秒看懂

```bash
npm i -g jdbc-mcp-guard          # 或 npx jdbc-mcp-guard

# 1) 不带 WHERE 的写：在碰到数据库之前就被拒绝
$ jdbc-mcp-guard exec --conn demo --sql "UPDATE tasks SET done=1" --reason "批量修复"
✗ 写守卫拒绝：UPDATE 必须带 WHERE 条件（禁止全表操作）。

# 2) 同样的语句加上 WHERE：预演（执行 → 计数 → 回滚）
$ jdbc-mcp-guard exec --conn demo --sql "UPDATE tasks SET done=1 WHERE id>0" --reason "批量修复"
[demo · 影响 3 行 · 预演未提交 · 上限 1000]
预演：真实提交请再调用一次并传 confirm="YES"。

# 3) 提交：同一套守卫，落库并写审计
$ jdbc-mcp-guard exec --conn demo --sql "UPDATE tasks SET done=1 WHERE id>0" --reason "批量修复" --confirm YES
[demo · 影响 3 行 · 已提交 · 上限 1000]
已提交。审计已写入 $JMG_HOME/audit.jsonl。
```

CLI、MCP 工具和 `--confirm` 走同一份守卫（`write-guard.js`）与同一份审计，没有第二条代码路径。上面是一次 SQLite 演示的真实输出。

## 核心能力

- **四级权限**（连接级开关，默认全关）：只读 → `allowWrite`(DML) → `allowDdl`(DDL) → `allowDestructive`(DROP/TRUNCATE/DROP COLUMN)
- **WHERE 强制**：UPDATE/DELETE/MERGE 必须带真 WHERE；判定跑在**掩码 SQL** 上（注释、字符串字面量先抹空，MySQL 反斜杠转义按方言处理）
- **两段式写入**：DML 默认“执行后回滚”报影响行数，`confirm:"YES"` 才提交；DDL 预演只做静态校验、绝不执行
- **行数闸门**：影响行数超过 `maxAffected`（默认 1000）自动回滚
- **审计**：`$JMG_HOME/audit.jsonl`，**被拒/预演/失败**都记；按大小轮转
- **驱动零准备**：连接配置 → 本地缓存 → `~/.m2` → Maven 镜像自动下载
- **快路径**：按驱动 classpath 池化常驻 JVM，首次约 2s、之后毫秒级；驱动异常时回退一次性进程

## 快速开始

要求 **Node.js ≥ 20** 与 **Java 17+ 运行时**（JRE 即可，`db/` 里自带预编译桥 jar）。只有想自己重建桥、或改了 `db/*.java` 时才需要 JDK（`npm run build:java`）。

```bash
git clone <repo-url> jdbc-mcp-guard && cd jdbc-mcp-guard
npm install
mkdir -p ~/.jdbc-mcp-guard/connections
```

`~/.jdbc-mcp-guard/connections/default.json`：

```json
{
  "database": {
    "dialect": "mysql",
    "host": "127.0.0.1",
    "port": 3306,
    "database": "app",
    "description": "核心业务库（示例）",
    "user": "app_user",
    "password": "REPLACE_ME",
    "allowWrite": false
  }
}
```

MCP 客户端配置：

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

更多连接模板见 [examples/](examples/)，客户端配置见 [docs/mcp-clients.md](docs/mcp-clients.md)。

## 工具

| 工具 | 用途 |
|---|---|
| `db_query` | 只读 SQL；单条或最多 20 条批量；`format:"json"`、`maxRows`（默认 200） |
| `db_execute` | 分级写入；默认预演（执行后回滚），`confirm:"YES"` 提交；必须带 `reason`（≥6 字）并写入审计 |
| `db_connections` | 列出连接、目标与写权限 |
| `db_dialects` | 方言/驱动映射与常驻 JVM 池 |
| `db_schema` | 表结构（达梦/MySQL/PG/MSSQL/Oracle/SQLite/DB2/ClickHouse/Trino/Presto/H2） |
| `db_indexes` | 主键/唯一键/索引/外键，一列一行（SQLite/MySQL/PG/达梦/Oracle/SQL Server/DB2/ClickHouse） |
| `db_explain` | 只读 SQL 的执行计划（SQLite 用 `EXPLAIN QUERY PLAN`，其余用 `EXPLAIN`）；不会执行原语句 |
| `db_search_columns` | 按列名找表（同上六族） |

## 安全模型

1. 第一条防线是**数据库账号权限**：只读连接就用只读账号；
2. 第二条是掩码后的 SQL 门禁（WHERE/多语句/禁词/文件 IO）；
3. 第三条是执行级保险（预演回滚、maxAffected、confirm）；
4. 第四条是审计（含被拒写）。

细节与已知边界见 [docs/security-model.md](docs/security-model.md)。**守卫是词法级检查，不替代数据库权限。**

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `JMG_HOME` | `~/.jdbc-mcp-guard` | 配置根：`connections/`、`drivers/`、`audit.jsonl`、`cache/` |
| `JMG_ACTOR` | `ai@<hostname>` | 审计里的操作者 |
| `JMG_AUDIT_MAX_BYTES` | 5 MB | 审计轮转阈值 |
| `JMG_MAX_DAEMONS` | 4 | 常驻 JVM 上限 |
| `JMG_SCHEMA_TTL_MS` | 10 分钟 | schema 缓存 TTL |

## 开发

```bash
npm install
npm test    # 61 项断言，SQLite + H2，不需要外部数据库
```

## 限制

- 词法级守卫，不做完整 SQL 解析；不要拿它替代数据库权限；
- 错误文案目前中文，英文 i18n 在路线图里；
- schema 工具覆盖十族方言，其他方言用 `db_query` 查元数据；
- 仅 stdio 传输；HTTP/SSE 与多租户鉴权在路线图里。

## 许可

MIT，见 [LICENSE](LICENSE)。
