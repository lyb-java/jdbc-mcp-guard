import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLNonTransientConnectionException;
import java.sql.SQLRecoverableException;
import java.sql.SQLTransientConnectionException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * DbQueryDaemon —— db-query MCP 的常驻执行器（行协议，一问一答，支持并发）。
 * ---------------------------------------------------------------------------
 * 为什么存在：每次 db_query = JVM 启动(~0.3s) + 建连(~2.3s)，SQL 本身 <10ms。
 * 常驻后：建连只发生一次，后续每条查询只剩执行耗时（毫秒级）。
 *
 * v2（2026-11-09）多连接 + 并发：
 *   - 一个 JVM 可以同时挂着多个库的连接（按 connKey 缓存，LRU 上限 MAX_CONNS）。
 *     同一驱动族的不同库不再互相顶掉，同一 JVM 内查询也不再全局串行。
 *   - 请求交给线程池并发执行；连接本身不是线程安全的，所以**每连接一把锁**：
 *     不同库可并行，同一库的请求按到达顺序串行。
 *   - 连接断掉（服务端空闲回收/网络抖动）时，query 自动重开并重试一次；
 *     write 不重试，避免重复写入。
 *   - 连接打开失败返回 connError=true，Node 侧据此整批报"连接失败"，
 *     与 SQL 级错误（单条失败只标记该块）区分开。
 *
 * 协议（stdin/stdout，每行一个 JSON，UTF-8）：
 *   请求：{"id":1,"op":"query","key":"url|user","url":"jdbc:...","driver":"com.mysql.cj.jdbc.Driver",
 *          "user":"u","password":"p","sql":"SELECT ...","maxRows":200,"timeout":30}
 *         {"id":2,"op":"write", ...同上, "dryRun":false,"maxAffected":1000}
 *         {"id":3,"op":"ping"}
 *         {"id":4,"op":"close"}
 *   响应：{"id":1,"ok":true,"rows":[[...]],"headers":[...],"count":n,"truncated":false}
 *         {"id":2,"ok":true,"affected":n,"committed":true}
 *         {"id":3,"ok":true,"alive":true,"conns":n}
 *   失败：{"id":1,"ok":false,"error":"消息"} / 连接建立失败额外带 "connError":true
 * 结构化 rows 数组（而非渲染文本）——渲染交给 Node 侧，单一职责。
 * 退出：stdin 关闭、收到 close、或 Node 侧空闲回收时 kill。
 */
public class DbQueryDaemon {

    private static final PrintStream OUT = newPrintStream();
    private static final Object OUT_LOCK = new Object();

    private static PrintStream newPrintStream() {
        try {
            return new PrintStream(System.out, true, "UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            return System.out;
        }
    }

    // 每个 JVM 最多挂几个库连接；线程池大小 = 同时执行多少条查询
    private static final int MAX_CONNS = Integer.getInteger("dbq.maxConns", 4);
    private static final int THREADS = Integer.getInteger("dbq.threads", 4);

    // accessOrder=true：迭代顺序 = 最久未用在前，淘汰时直接取第一个
    private static final LinkedHashMap<String, Conn> CONNS =
            new LinkedHashMap<String, Conn>(8, 0.75f, true);
    private static final Object CONN_LOCK = new Object();

    /** 一条 JDBC 连接 + 它自己的锁（JDBC Connection 不是线程安全的） */
    private static final class Conn {
        final Connection c;
        final java.util.concurrent.locks.ReentrantLock lock = new java.util.concurrent.locks.ReentrantLock();

        Conn(Connection c) {
            this.c = c;
        }

        void close() {
            try {
                if (c != null && !c.isClosed()) c.close();
            } catch (Exception ignore) {
                /* 关不掉不影响主流程 */
            }
        }
    }

    /** 建连失败：与"SQL 执行失败"区分，Node 侧要整批报错 */
    private static final class ConnOpenException extends Exception {
        ConnOpenException(String message) {
            super(message);
        }
    }

    /** 一次请求里所有参数（从行 JSON 里解析一次，多个线程各自持有） */
    private static final class Req {
        String key = "";
        String url = "";
        String user = "";
        String password = "";
        String driver = "";
        String sql = "";
        int maxRows = 0;
        int timeout = 0;
        boolean dryRun = false;
        int maxAffected = 0;

        static Req parse(String json) {
            Req r = new Req();
            r.url = nvl(strOf(json, "url"));
            r.user = nvl(strOf(json, "user"));
            r.password = nvl(strOf(json, "password"));
            r.driver = nvl(strOf(json, "driver"));
            r.sql = nvl(strOf(json, "sql"));
            r.key = nvl(strOf(json, "key"));
            if (r.key.isEmpty()) r.key = r.url + "|" + r.user;
            r.maxRows = (int) longOf(json, "maxRows");
            r.timeout = (int) longOf(json, "timeout");
            r.maxAffected = (int) longOf(json, "maxAffected");
            r.dryRun = boolOf(json, "dryRun");
            return r;
        }
    }

    public static void main(String[] args) throws Exception {
        // 建连不要无限等：内网可达性差时尽快报错（查询本身另有 queryTimeout）
        DriverManager.setLoginTimeout(20);
        System.out.println("{\"ready\":true}");
        System.out.flush();

        final ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            final String request = line;
            try {
                pool.submit(new Runnable() {
                    public void run() {
                        respond(handle(request));
                    }
                });
            } catch (RejectedExecutionException e) {
                respond("{\"ok\":false,\"error\":\"daemon 线程池已满\"}");
            }
        }
        pool.shutdown();
        try {
            pool.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException ignore) {
            /* 退出流程不阻塞 */
        }
        closeAll();
    }

    private static void respond(String line) {
        synchronized (OUT_LOCK) {
            OUT.println(line);
        }
    }

    private static String handle(String json) {
        long id = longOf(json, "id");
        String op = strOf(json, "op");
        try {
            if ("ping".equals(op)) {
                return "{\"id\":" + id + ",\"ok\":true,\"alive\":true,\"conns\":" + connCount() + "}";
            }
            if ("close".equals(op)) {
                closeAll();
                return "{\"id\":" + id + ",\"ok\":true}";
            }
            if ("query".equals(op)) {
                return doQuery(id, Req.parse(json));
            }
            if ("write".equals(op)) {
                return doWrite(id, Req.parse(json));
            }
            return "{\"id\":" + id + ",\"ok\":false,\"error\":\"unknown op: " + escape(op) + "\"}";
        } catch (ConnOpenException e) {
            return "{\"id\":" + id + ",\"ok\":false,\"connError\":true,\"error\":\"" + escape(e.getMessage()) + "\"}";
        } catch (Throwable t) {
            return "{\"id\":" + id + ",\"ok\":false,\"error\":\"" + escape(String.valueOf(t.getMessage())) + "\"}";
        }
    }

    // ── 查询：连接断掉自动重开重试一次（SELECT 幂等）──────────────────────────
    private static String doQuery(long id, Req r) throws Exception {
        Conn conn = open(r);
        SQLException failure = null;
        conn.lock.lock();
        try {
            return runQuery(id, conn.c, r);
        } catch (SQLException e) {
            failure = e;
        } finally {
            conn.lock.unlock();
        }
        if (!broken(failure)) throw failure;
        drop(r.key, conn);
        Conn retry = open(r);
        retry.lock.lock();
        try {
            return runQuery(id, retry.c, r);
        } finally {
            retry.lock.unlock();
        }
    }

    private static String runQuery(long id, Connection c, Req r) throws SQLException {
        try (Statement stmt = c.createStatement()) {
            if (r.timeout > 0) {
                try {
                    stmt.setQueryTimeout(r.timeout);
                } catch (Exception ignore) {
                    /* 驱动可能不支持 */
                }
            }
            boolean hasRs = stmt.execute(r.sql);
            if (!hasRs) {
                return "{\"id\":" + id + ",\"ok\":true,\"count\":0,\"headers\":[],\"rows\":[]}";
            }
            try (ResultSet rs = stmt.getResultSet()) {
                ResultSetMetaData meta = rs.getMetaData();
                int colCount = meta.getColumnCount();
                List<String> headers = new ArrayList<String>();
                for (int col = 1; col <= colCount; col++) headers.add(meta.getColumnLabel(col));
                List<List<String>> rows = new ArrayList<List<String>>();
                boolean truncated = false;
                while (rs.next()) {
                    if (r.maxRows > 0 && rows.size() >= r.maxRows) {
                        truncated = true;
                        break;
                    }
                    List<String> row = new ArrayList<String>(colCount);
                    for (int col = 1; col <= colCount; col++) row.add(rs.getString(col));
                    rows.add(row);
                }
                StringBuilder sb = new StringBuilder();
                sb.append("{\"id\":").append(id).append(",\"ok\":true,\"count\":").append(rows.size())
                        .append(",\"truncated\":").append(truncated)
                        .append(",\"headers\":").append(toJsonArray(headers))
                        .append(",\"rows\":").append(toJsonMatrix(rows)).append("}");
                return sb.toString();
            }
        }
    }

    // ── 写：绝不自动重试（可能已部分执行）────────────────────────────────────
    private static String doWrite(long id, Req r) throws Exception {
        Conn conn = open(r);
        conn.lock.lock();
        try {
            Connection c = conn.c;
            boolean prevAuto = c.getAutoCommit();
            boolean prevReadOnly = c.isReadOnly();
            try {
                c.setReadOnly(false);
                c.setAutoCommit(false);
                try (Statement stmt = c.createStatement()) {
                    if (r.timeout > 0) {
                        try {
                            stmt.setQueryTimeout(r.timeout);
                        } catch (Exception ignore) {
                            /* 驱动可能不支持 */
                        }
                    }
                    boolean hasRs = stmt.execute(r.sql);
                    int affected = hasRs ? 0 : stmt.getUpdateCount();
                    if (r.maxAffected > 0 && affected > r.maxAffected) {
                        c.rollback();
                        return "{\"id\":" + id + ",\"ok\":true,\"affected\":" + affected
                                + ",\"committed\":false,\"aborted\":\"exceeds-max-affected(" + r.maxAffected + ")\"}";
                    }
                    if (r.dryRun) {
                        c.rollback();
                        return "{\"id\":" + id + ",\"ok\":true,\"affected\":" + affected
                                + ",\"committed\":false,\"dryRun\":true}";
                    }
                    c.commit();
                    return "{\"id\":" + id + ",\"ok\":true,\"affected\":" + affected + ",\"committed\":true}";
                }
            } finally {
                try {
                    c.setAutoCommit(prevAuto);
                    c.setReadOnly(prevReadOnly);
                } catch (Exception ignore) {
                    /* 连接已坏时这里也会抛，忽略 */
                }
            }
        } finally {
            conn.lock.unlock();
        }
    }

    // ── 连接池（按 connKey，LRU 上限 MAX_CONNS）───────────────────────────────
    private static Conn open(Req r) throws ConnOpenException {
        synchronized (CONN_LOCK) {
            Conn hit = CONNS.get(r.key);
            if (hit != null && !closed(hit.c)) return hit;
            if (hit != null) CONNS.remove(r.key);
        }
        Connection raw;
        try {
            if (!r.driver.isEmpty()) Class.forName(r.driver);
            raw = DriverManager.getConnection(r.url, r.user, r.password);
            try {
                raw.setReadOnly(true);
            } catch (Exception ignore) {
                /* 驱动可能不支持 */
            }
        } catch (Throwable t) {
            throw new ConnOpenException(String.valueOf(t.getMessage()));
        }
        Conn made = new Conn(raw);
        Conn victim = null;
        synchronized (CONN_LOCK) {
            Conn existing = CONNS.get(r.key);
            if (existing != null && !closed(existing.c)) {
                made.close();   // 并发下别人先建好了，用现成的
                return existing;
            }
            CONNS.put(r.key, made);
            if (CONNS.size() > MAX_CONNS) {
                // 淘汰最久未用的连接；正在被别的线程使用的（tryLock 失败）跳过，
                // 否则会把别人正在跑的查询连根拔掉
                Iterator<Map.Entry<String, Conn>> it = CONNS.entrySet().iterator();
                while (it.hasNext()) {
                    Map.Entry<String, Conn> entry = it.next();
                    if (entry.getKey().equals(r.key)) continue;
                    Conn cand = entry.getValue();
                    if (!cand.lock.tryLock()) continue;
                    try {
                        it.remove();
                        victim = cand;
                    } finally {
                        cand.lock.unlock();
                    }
                    break;
                }
            }
        }
        if (victim != null) victim.close();
        return made;
    }

    private static void drop(String key, Conn conn) {
        synchronized (CONN_LOCK) {
            if (CONNS.get(key) == conn) CONNS.remove(key);
        }
        conn.close();
    }

    private static int connCount() {
        synchronized (CONN_LOCK) {
            return CONNS.size();
        }
    }

    private static void closeAll() {
        synchronized (CONN_LOCK) {
            for (Conn c : CONNS.values()) c.close();
            CONNS.clear();
        }
    }

    private static boolean closed(Connection c) {
        try {
            return c == null || c.isClosed();
        } catch (Exception e) {
            return true;
        }
    }

    /** 连接级故障（断了/被回收）才值得重开重试；SQL 语法错不重试 */
    private static boolean broken(Throwable t) {
        if (t instanceof SQLNonTransientConnectionException
                || t instanceof SQLRecoverableException
                || t instanceof SQLTransientConnectionException) {
            return true;
        }
        String msg = String.valueOf(t.getMessage()).toLowerCase(Locale.ROOT);
        return msg.contains("connection is closed")
                || msg.contains("no operations allowed")
                || msg.contains("communications link failure")
                || msg.contains("socket closed")
                || msg.contains("connection reset")
                || msg.contains("connection closed")
                || msg.contains("连接未打开");
    }

    // ── 极简 JSON 取值（请求体由可信的 Node 侧构造，不追求完全解析）──────────
    private static String strOf(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        if (m.find()) return unescape(m.group(1));
        return null;
    }

    private static long longOf(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*(\\d+)").matcher(json);
        return m.find() ? Long.parseLong(m.group(1)) : 0L;
    }

    private static boolean boolOf(String json, String key) {
        Matcher m = Pattern.compile("\"" + key + "\"\\s*:\\s*(true|false)").matcher(json);
        return m.find() && "true".equals(m.group(1));
    }

    private static String nvl(String s) {
        return s == null ? "" : s;
    }

    private static String toJsonArray(List<String> items) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append("\"").append(escape(items.get(i))).append("\"");
        }
        return sb.append("]").toString();
    }

    private static String toJsonMatrix(List<List<String>> rows) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < rows.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append("[");
            List<String> row = rows.get(i);
            for (int c = 0; c < row.size(); c++) {
                if (c > 0) sb.append(",");
                String value = row.get(c);
                if (value == null) sb.append("null");   // 区分 SQL NULL 与空字符串
                else sb.append("\"").append(escape(value)).append("\"");
            }
            sb.append("]");
        }
        return sb.append("]").toString();
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }

    private static String unescape(String s) {
        if (s == null) return null;
        return s.replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t");
    }
}
