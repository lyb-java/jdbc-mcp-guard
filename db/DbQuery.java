import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 通用只读 SQL 查询器（JDBC）。
 *
 * 用法：DbQuery "<SQL>" [--json] [--config <path>] [--file <sqlPath>] [--output <path>]
 *                 [--url <jdbc:...>] [--driver <class>] [--timeout <sec>] [--max-rows <n>]
 *
 * 连接配置（--config，默认 ./connection.json → ~/.jdbc-mcp-guard/connections/default.json）：
 *   { "database": { "dialect":"dm", "host":"...", "port":5237, "database":"...",
 *                   "user":"...", "password":"...",
 *                   "url":"jdbc:xxx://...",         // 可选：裸 JDBC URL，覆盖 dialect 拼装
 *                   "driverClass":"com.xxx.Driver", // 可选：自定义驱动类
 *                   "queryTimeout": 60,              // 可选：语句超时（秒）
 *                   "readOnly": true } }             // 可选：是否强制只读连接（默认 true）
 */
public class DbQuery {

    /** 批量模式的分隔标记：由上层写入 SQL 文件时插入，避免命令行引号问题 */
    static final String MULTI_MARKER = "\n--@@BATCH_SPLIT@@--\n";

    /** 方言 → {驱动类, URL 模板}。模板占位：{host} {port} {database} */
    static String[] dialectSpec(String dialect) {
        String d = dialect == null ? "" : dialect.trim().toLowerCase();
        switch (d) {
            // 达梦
            case "dm":
            case "dameng":
                return new String[]{"dm.jdbc.driver.DmDriver", "jdbc:dm://{host}:{port}/{database}?useSSL=false&charset=UTF-8"};
            // MySQL 协议族（含 MariaDB / TiDB / OceanBase(mysql) / StarRocks / Doris / GoldenDB）
            case "mysql":
            case "mariadb":
            case "tidb":
            case "oceanbase":
            case "starrocks":
            case "doris":
            case "goldendb":
                return new String[]{"com.mysql.cj.jdbc.Driver",
                        "jdbc:mysql://{host}:{port}/{database}?useUnicode=true&characterEncoding=utf8&useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=Asia/Shanghai"};
            // PostgreSQL 协议族（含 openGauss / GaussDB / 人大金仓 KingbaseES(PG) / 瀚高 / 海量）
            case "postgresql":
            case "postgres":
            case "opengauss":
            case "gaussdb":
            case "kingbase":
            case "highgo":
            case "vastbase":
                return new String[]{"org.postgresql.Driver", "jdbc:postgresql://{host}:{port}/{database}"};
            // SQL Server
            case "mssql":
            case "sqlserver":
                return new String[]{"com.microsoft.sqlserver.jdbc.SQLServerDriver",
                        "jdbc:sqlserver://{host}:{port};databaseName={database};encrypt=false;trustServerCertificate=true"};
            // Oracle（database 含 "/" 视为 service_name，否则视为 SID）
            case "oracle":
                return new String[]{"oracle.jdbc.OracleDriver", "jdbc:oracle:thin:@"};
            // SQLite（database 为文件路径，:memory: 为内存库）
            case "sqlite":
            case "sqlite3":
                return new String[]{"org.sqlite.JDBC", "jdbc:sqlite:{database}"};
            // DB2
            case "db2":
                return new String[]{"com.ibm.db2.jcc.DB2Driver", "jdbc:db2://{host}:{port}/{database}"};
            // ClickHouse
            case "clickhouse":
                return new String[]{"com.clickhouse.jdbc.ClickHouseDriver", "jdbc:clickhouse://{host}:{port}/{database}"};
            // Hive / Impala
            case "hive":
            case "hive2":
                return new String[]{"org.apache.hive.jdbc.HiveDriver", "jdbc:hive2://{host}:{port}/{database}"};
            // Trino / Presto
            case "trino":
                return new String[]{"io.trino.jdbc.TrinoDriver", "jdbc:trino://{host}:{port}/{database}"};
            case "presto":
                return new String[]{"com.facebook.presto.jdbc.PrestoDriver", "jdbc:presto://{host}:{port}/{database}"};
            // H2（本地文件/内存，便于离线自检）
            case "h2":
                return new String[]{"org.h2.Driver", "jdbc:h2:"};
            default:
                return null;
        }
    }

    static String fill(String template, String host, String port, String database) {
        return template
                .replace("{host}", host == null ? "127.0.0.1" : host)
                .replace("{port}", port == null ? "" : port)
                .replace("{database}", database == null ? "" : database);
    }

    public static void main(String[] args) {
        if (args.length == 0 || "-h".equals(args[0]) || "--help".equals(args[0])) {
            System.out.println("Universal Database Query CLI (read-only by default)");
            System.out.println("Usage: DbQuery \"<SQL>\" [--json] [--config <path>] [--file <sqlPath>] [--output <path>]");
            System.out.println("                 [--url <jdbc:...>] [--driver <class>] [--timeout <sec>] [--max-rows <n>]");
            System.out.println("       DbQuery ... --multi                            批量只读：SQL 文件里用 --@@BATCH_SPLIT@@-- 分隔多条");
            System.out.println("       DbQuery ... --write [--dry-run] [--max-affected <n>]   写模式：事务 + 影响行数上限，--dry-run 执行后回滚");
            System.out.println("Dialects: dm, mysql/mariadb/tidb/oceanbase/starrocks/doris/goldendb,");
            System.out.println("          postgresql/opengauss/gaussdb/kingbase/highgo/vastbase, mssql, oracle,");
            System.out.println("          sqlite, db2, clickhouse, hive2, trino, presto, h2（其它库用 url + driverClass）");
            return;
        }

        StringBuilder sqlBuilder = new StringBuilder();
        boolean jsonMode = false;
        String configPath = null;
        String filePath = null;
        String outputPath = null;
        String urlOverride = null;
        String driverOverride = null;
        int timeout = 0;
        int maxRows = 0;
        boolean writeMode = false;
        boolean multiMode = false;
        boolean dryRun = false;
        int maxAffected = 0;

        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            if ("--json".equalsIgnoreCase(arg)) {
                jsonMode = true;
            } else if ("--config".equalsIgnoreCase(arg) && i + 1 < args.length) {
                configPath = args[++i];
            } else if ("--file".equalsIgnoreCase(arg) && i + 1 < args.length) {
                filePath = args[++i];
            } else if ("--output".equalsIgnoreCase(arg) && i + 1 < args.length) {
                outputPath = args[++i];
            } else if ("--url".equalsIgnoreCase(arg) && i + 1 < args.length) {
                urlOverride = args[++i];
            } else if ("--driver".equalsIgnoreCase(arg) && i + 1 < args.length) {
                driverOverride = args[++i];
            } else if ("--timeout".equalsIgnoreCase(arg) && i + 1 < args.length) {
                timeout = parseInt(args[++i], 0);
            } else if ("--max-rows".equalsIgnoreCase(arg) && i + 1 < args.length) {
                maxRows = parseInt(args[++i], 0);
            } else if ("--multi".equalsIgnoreCase(arg)) {
                multiMode = true;
            } else if ("--write".equalsIgnoreCase(arg)) {
                writeMode = true;
            } else if ("--dry-run".equalsIgnoreCase(arg)) {
                dryRun = true;
            } else if ("--max-affected".equalsIgnoreCase(arg) && i + 1 < args.length) {
                maxAffected = parseInt(args[++i], 0);
            } else {
                if (sqlBuilder.length() > 0) sqlBuilder.append(" ");
                sqlBuilder.append(arg);
            }
        }

        String rawSql = sqlBuilder.toString().trim();
        if (filePath != null) {
            rawSql = readText(filePath);
            if (rawSql == null) System.exit(1);
        } else if (rawSql.startsWith("@")) {
            rawSql = readText(rawSql.substring(1).trim());
            if (rawSql == null) System.exit(1);
        }

        String sql = cleanSql(rawSql);
        if (sql.isEmpty()) {
            System.err.println("[ERROR] No SQL statement provided.");
            System.exit(1);
        }

        File configFile = null;
        if (configPath != null) {
            configFile = new File(configPath);
        } else {
            File localConfig = new File("connection.json");
            if (localConfig.exists()) configFile = localConfig;
            else {
                File global = new File(System.getProperty("user.home") + File.separator + ".jdbc-mcp-guard"
                        + File.separator + "connections" + File.separator + "default.json");
                if (global.exists()) configFile = global;
            }
        }
        if (configFile == null || !configFile.exists()) {
            System.err.println("[ERROR] Configuration file not found.");
            System.exit(1);
        }

        try {
            String configContent = readText(configFile.getAbsolutePath());
            String cfgDialect = extractJsonValue(configContent, "dialect");
            String host = extractJsonValue(configContent, "host");
            String port = extractJsonValue(configContent, "port");
            String database = extractJsonValue(configContent, "database");
            String user = extractJsonValue(configContent, "user");
            String password = extractJsonValue(configContent, "password");
            String cfgUrl = extractJsonValue(configContent, "url");
            String cfgDriver = extractJsonValue(configContent, "driverClass");
            String cfgTimeout = extractJsonValue(configContent, "queryTimeout");
            String cfgReadOnly = extractJsonValue(configContent, "readOnly");
            if (timeout <= 0) timeout = parseInt(cfgTimeout, 0);

            String driverClass;
            String jdbcUrl;

            if (urlOverride != null) {
                jdbcUrl = urlOverride;
                driverClass = driverOverride != null ? driverOverride : (cfgDriver != null ? cfgDriver : "");
            } else if (cfgUrl != null && !cfgUrl.trim().isEmpty()) {
                jdbcUrl = cfgUrl.trim();
                driverClass = driverOverride != null ? driverOverride : (cfgDriver != null ? cfgDriver : "");
            } else {
                String[] spec = dialectSpec(cfgDialect);
                if (spec == null) {
                    System.err.println("[ERROR] 未知方言: " + cfgDialect
                            + " —— 可在配置里加 \"url\"(JDBC URL) 与 \"driverClass\" 支持任意数据库。");
                    System.exit(1);
                    return;
                }
                driverClass = driverOverride != null ? driverOverride : spec[0];
                if (cfgDialect != null && "oracle".equalsIgnoreCase(cfgDialect.trim())) {
                    String db = database == null ? "" : database;
                    jdbcUrl = db.contains("/")
                            ? spec[1] + host + ":" + port + "/" + db          // service_name
                            : spec[1] + host + ":" + port + ":" + db;         // SID
                } else {
                    jdbcUrl = fill(spec[1], host, port, database);
                }
            }

            if (driverClass != null && !driverClass.isEmpty()) Class.forName(driverClass);

            try (Connection conn = DriverManager.getConnection(jdbcUrl, user, password)) {
                // 防御性只读：即便 SQL 被替换，也尽量让连接层拒绝写入（部分驱动不支持会抛异常，忽略）
                boolean readOnly = cfgReadOnly == null || !"false".equalsIgnoreCase(cfgReadOnly.trim());
                if (writeMode) {
                    try {
                        conn.setReadOnly(false);
                    } catch (Exception ignore) {
                        /* 部分驱动不支持 */
                    }
                    conn.setAutoCommit(false);
                } else if (readOnly) {
                    try {
                        conn.setReadOnly(true);
                    } catch (Exception ignore) {
                        /* 驱动不支持则跳过 */
                    }
                }
                try (Statement stmt = conn.createStatement()) {
                    if (timeout > 0) {
                        try {
                            stmt.setQueryTimeout(timeout);
                        } catch (Exception ignore) {
                            /* 忽略 */
                        }
                    }
                    java.io.PrintStream out = outputPath != null
                            ? new java.io.PrintStream(new java.io.FileOutputStream(outputPath), true, "UTF-8")
                            : System.out;
                    if (multiMode) {
                        // 批量只读：同一连接内顺序执行多条，逐条输出结果块；单条失败不影响其它条
                        String[] parts = sql.split(java.util.regex.Pattern.quote(MULTI_MARKER), -1);
                        for (int idx = 0; idx < parts.length; idx++) {
                            String one = cleanSql(parts[idx]);
                            if (one.isEmpty()) continue;
                            String label = one.replaceAll("\\s+", " ");
                            if (label.length() > 90) label = label.substring(0, 90) + "…";
                            out.println("@@RESULT_BEGIN " + idx + " " + label);
                            try {
                                boolean hasRs = stmt.execute(one);
                                if (hasRs) {
                                    try (ResultSet rs = stmt.getResultSet()) {
                                        dumpResultSet(rs, jsonMode, maxRows, out);
                                    }
                                } else {
                                    out.printf("执行成功，影响行数: %d%n", stmt.getUpdateCount());
                                }
                            } catch (Exception ex) {
                                out.println("@@ERROR " + ex.getMessage());
                            }
                            out.println("@@RESULT_END " + idx);
                        }
                        if (outputPath != null) out.close();
                        return;
                    }
                    boolean hasResultSet = stmt.execute(sql);
                    if (writeMode) {
                        // 写模式：事务 + 影响行数上限 + dry-run 回滚。输出单行摘要供上层解析
                        int affected = hasResultSet ? 0 : stmt.getUpdateCount();
                        if (maxAffected > 0 && affected > maxAffected) {
                            conn.rollback();
                            System.out.println("AFFECTED=" + affected + " COMMITTED=false ABORTED=exceeds-max-affected(" + maxAffected + ")");
                            return;
                        }
                        if (dryRun) {
                            conn.rollback();
                            System.out.println("AFFECTED=" + affected + " COMMITTED=false DRYRUN=true");
                        } else {
                            conn.commit();
                            System.out.println("AFFECTED=" + affected + " COMMITTED=true");
                        }
                        return;
                    }
                    if (hasResultSet) {
                        try (ResultSet rs = stmt.getResultSet()) {
                            dumpResultSet(rs, jsonMode, maxRows, out);
                        }
                    } else {
                        out.printf("执行成功，影响行数: %d%n", stmt.getUpdateCount());
                    }
                    if (outputPath != null) out.close();
                }
            }
        } catch (Exception e) {
            System.err.println("[ERROR] SQL Execution Failed: " + e.getMessage());
            System.exit(1);
        }
    }

    /** 把一个结果集按 table/json 输出（单条查询与批量查询共用同一套渲染） */
    private static void dumpResultSet(ResultSet rs, boolean jsonMode, int maxRows, java.io.PrintStream out) throws Exception {
        ResultSetMetaData meta = rs.getMetaData();
        int colCount = meta.getColumnCount();

        if (jsonMode) {
            out.println("[");
            boolean firstRow = true;
            int shown = 0;
            boolean truncated = false;
            while (rs.next()) {
                if (maxRows > 0 && shown >= maxRows) {
                    truncated = true;
                    break;
                }
                if (!firstRow) out.println(",");
                firstRow = false;
                out.print("  {");
                for (int c = 1; c <= colCount; c++) {
                    String label = meta.getColumnLabel(c);
                    String val = rs.getString(c);
                    if (c > 1) out.print(", ");
                    out.print("\"" + escapeJson(label) + "\": ");
                    if (val == null) out.print("null");
                    else out.print("\"" + escapeJson(val) + "\"");
                }
                out.print("}");
                shown++;
            }
            out.println();
            out.println("]");
            if (truncated) {
                System.out.flush();
                System.err.println("(结果已截断，仅显示前 " + maxRows + " 行；请加 LIMIT 或调大 maxRows)");
            }
        } else {
            String[] headers = new String[colCount];
            int[] widths = new int[colCount];
            for (int c = 1; c <= colCount; c++) {
                headers[c - 1] = meta.getColumnLabel(c);
                widths[c - 1] = Math.max(headers[c - 1].length(), 4);
            }

            List<String[]> rows = new ArrayList<>();
            boolean truncated = false;
            while (rs.next()) {
                if (maxRows > 0 && rows.size() >= maxRows) {
                    truncated = true;
                    break;
                }
                String[] row = new String[colCount];
                for (int c = 1; c <= colCount; c++) {
                    String val = rs.getString(c);
                    row[c - 1] = val == null ? "NULL" : val;
                    widths[c - 1] = Math.max(widths[c - 1], Math.min(row[c - 1].length(), 45));
                }
                rows.add(row);
            }

            printRow(headers, widths, out);
            printSeparator(widths, out);
            for (String[] r : rows) printRow(r, widths, out);
            out.println();
            out.printf("(共 %d 条记录)%s%n", rows.size(),
                    truncated ? "（已截断，仅显示前 " + maxRows + " 行，请加 LIMIT）" : "");
        }
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(value.trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String readText(String path) {
        try {
            return new String(Files.readAllBytes(new File(path).toPath()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            System.err.println("[ERROR] Failed to read file: " + path + ", " + e.getMessage());
            return null;
        }
    }

    private static String cleanSql(String sql) {
        if (sql == null) return "";
        sql = sql.trim();
        while (sql.startsWith("\"") && sql.endsWith("\"") && sql.length() >= 2) {
            sql = sql.substring(1, sql.length() - 1).trim();
        }
        while (sql.startsWith("'") && sql.endsWith("'") && sql.length() >= 2) {
            sql = sql.substring(1, sql.length() - 1).trim();
        }
        return sql;
    }

    private static void printRow(String[] items, int[] widths, java.io.PrintStream out) {
        StringBuilder sb = new StringBuilder("| ");
        for (int i = 0; i < items.length; i++) {
            String item = items[i];
            int width = widths[i];
            if (item.length() > width) {
                item = item.substring(0, Math.max(width - 3, 1)) + "...";
            }
            sb.append(String.format("%-" + width + "s", item)).append(" | ");
        }
        out.println(sb.toString());
    }

    private static void printSeparator(int[] widths, java.io.PrintStream out) {
        StringBuilder sb = new StringBuilder("|-");
        for (int w : widths) {
            for (int i = 0; i < w; i++) sb.append("-");
            sb.append("-|-");
        }
        out.println(sb.substring(0, sb.length() - 1));
    }

    /** 极简 JSON 取值：字符串 / 数字 / 布尔；找不到返回 null。 */
    private static String extractJsonValue(String json, String key) {
        if (json == null) return null;
        Pattern pStr = Pattern.compile("\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
        Matcher m = pStr.matcher(json);
        if (m.find()) return m.group(1);
        Pattern pNum = Pattern.compile("\"" + key + "\"\\s*:\\s*(\\d+)");
        m = pNum.matcher(json);
        if (m.find()) return m.group(1);
        Pattern pBool = Pattern.compile("\"" + key + "\"\\s*:\\s*(true|false)", Pattern.CASE_INSENSITIVE);
        m = pBool.matcher(json);
        if (m.find()) return m.group(1);
        return null;
    }

    private static String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }
}
