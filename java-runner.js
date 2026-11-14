/**
 * java-runner —— DbQueryDaemon 的生命周期管理（db-query MCP 专用）。
 * ---------------------------------------------------------------------------
 * v2（2026-11-09）按驱动缓存 JVM 池：
 *   1. 懒启动：首次用到某个驱动集合（classpath）才 spawn 一个 daemon JVM
 *   2. 按 classpath 复用：达梦 / MySQL / SQL Server 各留一个常驻 JVM，
 *      跨方言切换不再重启 JVM（旧实现只有一个 JVM，换驱动必重启 ~2.2s）
 *   3. 池上限 MAX_DAEMONS（默认 4，可用 JMG_MAX_DAEMONS 覆盖），超了淘汰最久未用的
 *   4. 空闲回收：每个 daemon 独立计时，IDLE_KILL_MS 无请求就 close+kill（默认 10 分钟）
 *   5. 并发：不同 daemon 天然并行；同一个 daemon 内部由 Java 线程池 + 每连接一把锁
 *      并发执行（不同库并行、同库串行），Node 侧不再做全局排队
 *
 * 协议见 DbQueryDaemon.java 头注释。对外只暴露：
 *   runner.query(conn, { sql, maxRows, timeout }) -> {headers, rows, count, truncated}
 *   runner.write(conn, { sql, dryRun, maxAffected, timeout }) -> {affected, committed, aborted}
 *   runner.shutdown()
 */
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const JMG_HOME = process.env.JMG_HOME || path.join(os.homedir(), ".jdbc-mcp-guard");
const DAEMON_SRC = path.join(__dirname, "db", "DbQueryDaemon.java");
const CLASS_CACHE = path.join(JMG_HOME, "cache", "daemon-classes");
const { bridgeJarPath } = require("./java-bridge.js");
const IDLE_KILL_MS = 10 * 60 * 1000;   // 每个 daemon 空闲 10 分钟回收
const REQ_TIMEOUT_MS = 120000;          // 单请求协议级超时（必须 < MCP 的 toolCallTimeoutMs 130s）
const MIN_REQ_TIMEOUT_MS = 30000;
const BOOT_TIMEOUT_MS = 60000;          // 启动/编译超时
const MAX_DAEMONS = (() => {
  const raw = Number(process.env.JMG_MAX_DAEMONS || 4);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
})();
// ── 编译缓存（所有 daemon 共用同一份 class）─────────────────────────────────
function compileIfNeeded() {
  if (bridgeJarPath()) return; // 预编译 jar 优先：运行时只需 JRE
  const target = path.join(CLASS_CACHE, "DbQueryDaemon.class");
  try {
    if (fs.statSync(target).mtimeMs >= fs.statSync(DAEMON_SRC).mtimeMs) return;
  } catch {
    /* 需要编译 */
  }
  fs.mkdirSync(CLASS_CACHE, { recursive: true });
  const javac = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "javac.exe") : "javac";
  execFileSync(javac, ["-encoding", "UTF-8", "-d", CLASS_CACHE, DAEMON_SRC], { stdio: "pipe", windowsHide: true, timeout: 60000 });
}

/** 一个 classpath = 一个常驻 JVM */
class Daemon {
  constructor(classpath, onIdle) {
    this.classpath = classpath;
    this.onIdle = onIdle || (() => {});
    this.proc = null;
    this.pending = new Map();       // id -> {resolve, timer}
    this.nextId = 1;
    this.ready = false;
    this.buf = "";
    this.idleTimer = null;
    this.bootResolver = null;
    this.bootReject = null;
    this.spawnPromise = null;
    this.stderrTail = "";
    this.lastUsed = Date.now();
  }

  async ensure() {
    if (this.proc && this.ready) return;
    // 并发请求同时发现进程不在时，只允许起一个 JVM
    if (this.spawnPromise) return this.spawnPromise;
    this.spawnPromise = this._spawn().finally(() => {
      this.spawnPromise = null;
    });
    return this.spawnPromise;
  }

  request(payload) {
    this.lastUsed = Date.now();
    this._touchIdle();
    if (!this.proc) return Promise.resolve({ ok: false, error: "daemon 未启动" });
    return new Promise((resolve) => {
      const id = this.nextId++;
      payload.id = id;
      // SQL 自带 timeout 时给足预算，但始终不超过协议上限（否则 MCP 工具先超时，请求悬空）
      const budget = payload.timeout > 0
        ? Math.min(REQ_TIMEOUT_MS, Math.max(MIN_REQ_TIMEOUT_MS, payload.timeout * 1000 + 15000))
        : REQ_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "daemon 请求超时（" + budget + "ms）" });
      }, budget);
      this.pending.set(id, { resolve, timer });
      try {
        this.proc.stdin.write(JSON.stringify(payload) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: "daemon 管道已断：" + e.message });
      }
    });
  }

  kill(reason) {
    const child = this.proc;
    this.proc = null;
    this.ready = false;
    this.buf = "";
    this._rejectAll(reason || "daemon 已回收");
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!child) return;
    try {
      child.stdin.write(JSON.stringify({ id: 0, op: "close" }) + "\n");
    } catch {
      /* 管道可能已断 */
    }
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, 500).unref?.();
  }

  _touchIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.onIdle(this);
      this.kill("daemon 空闲回收");
    }, IDLE_KILL_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _rejectAll(reason) {
    for (const [, v] of this.pending) {
      clearTimeout(v.timer);
      v.resolve({ ok: false, error: reason });
    }
    this.pending.clear();
  }

  _spawn() {
    compileIfNeeded();
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java.exe") : "java";
    const child = spawn(java, ["-Dfile.encoding=UTF-8", "-cp", this.classpath, "DbQueryDaemon"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = child;
    this.buf = "";
    this.stderrTail = "";
    this.ready = false;

    child.stdout.on("data", (c) => {
      if (this.proc !== child) return;   // 旧进程残留输出不污染新进程
      this.buf += c.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        if (line.includes("\"ready\":true")) {
          this.ready = true;
          if (this.bootResolver) {
            this.bootResolver();
            this.bootResolver = null;
          }
          continue;
        }
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const entry = m.id && this.pending.get(m.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(m.id);
          entry.resolve(m);
        }
      }
    });
    child.stderr.on("data", (c) => {
      // 只留最后 4KB：正常是 SLF4J 噪声，JVM 起不来时是唯一线索
      this.stderrTail = (this.stderrTail + c.toString("utf8")).slice(-4000);
    });
    child.on("error", (e) => this._failBoot(child, e));
    child.on("exit", (code) => {
      if (this.proc === child) {
        this.proc = null;
        this.ready = false;
      }
      this._rejectAll(code ? "daemon 进程退出（exit " + code + "）" + this._stderrSummary() : "daemon 进程退出");
    });

    return new Promise((resolve, reject) => {
      this.bootResolver = resolve;
      this.bootReject = reject;
      const t = setTimeout(() => {
        if (!this.ready) {
          this.bootResolver = null;
          this.bootReject = null;
          reject(new Error("daemon 启动超时（60s）：java 未就绪" + this._stderrSummary()));
          try {
            child.kill();
          } catch {
            /* 已退出 */
          }
        }
      }, BOOT_TIMEOUT_MS);
      if (t.unref) t.unref();
    });
  }

  _stderrSummary() {
    const lines = String(this.stderrTail || "")
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-3);
    if (!lines.length) return "";
    return "；stderr: " + lines.join(" | ").slice(0, 500);
  }

  _failBoot(child, error) {
    if (this.proc === child) {
      this.proc = null;
      this.ready = false;
    }
    this._rejectAll("daemon 异常：" + error.message);
    const reject = this.bootReject;
    this.bootResolver = null;
    this.bootReject = null;
    if (reject) reject(new Error("daemon 启动失败：" + error.message + this._stderrSummary()));
  }
}

class JavaRunner {
  constructor() {
    this.daemons = new Map();     // classpath -> Daemon
    this.spawning = new Map();    // classpath -> Promise<Daemon>（并发只起一个）
  }

  // ── 对外 API ──────────────────────────────────────────────────────────────
  async query(conn, { sql, maxRows, timeout }) {
    const r = await this._send(conn, {
      op: "query",
      url: conn.url,
      driver: conn.driver || "",
      user: conn.user || "",
      password: conn.password || "",
      sql,
      maxRows: maxRows || 0,
      timeout: timeout || 0,
    });
    if (r.connError) throw new Error("连接失败：" + (r.error || "未知") + driverHint(r.error, conn));
    return r.ok ? r : { ok: false, error: r.error || "daemon query 失败", sqlError: true };
  }

  async write(conn, { sql, dryRun, maxAffected, timeout }) {
    const r = await this._send(conn, {
      op: "write",
      url: conn.url,
      driver: conn.driver || "",
      user: conn.user || "",
      password: conn.password || "",
      sql,
      dryRun: Boolean(dryRun),
      maxAffected: maxAffected || 0,
      timeout: timeout || 0,
    });
    if (r.connError) throw new Error("连接失败：" + (r.error || "未知") + driverHint(r.error, conn));
    return r.ok ? r : { ok: false, error: r.error || "daemon write 失败", sqlError: true };
  }

  shutdown() {
    for (const d of this.daemons.values()) d.kill("daemon 关闭");
    this.daemons.clear();
  }

  /** 池状态（db_dialects 展示用）：每个常驻 JVM 的驱动 jar 与是否就绪 */
  stats() {
    const list = [];
    for (const d of this.daemons.values()) {
      list.push({
        ready: Boolean(d.proc && d.ready),
        jars: String(d.classpath || "")
          .split(path.delimiter)
          .map((p) => path.basename(p))
          .filter(Boolean),
      });
    }
    return list;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────
  async _send(conn, payload) {
    const daemon = await this._daemon(conn.classpath);
    await daemon.ensure();   // 进程被本机杀过/空闲回收过时自动拉起
    payload.key = conn.url + "|" + (conn.user || "");
    return daemon.request(payload);
  }

  async _daemon(classpath) {
    const hit = this.daemons.get(classpath);
    if (hit) {
      hit.lastUsed = Date.now();
      return hit;
    }
    let pending = this.spawning.get(classpath);
    if (!pending) {
      pending = (async () => {
        const daemon = new Daemon(classpath, (d) => {
          if (this.daemons.get(classpath) === d) this.daemons.delete(classpath);
        });
        try {
          await daemon.ensure();
        } catch (e) {
          this.spawning.delete(classpath);
          throw e;
        }
        this.daemons.set(classpath, daemon);
        this.spawning.delete(classpath);
        this._trim(classpath);
        return daemon;
      })();
      this.spawning.set(classpath, pending);
    }
    return pending;
  }

  /** 池上限：淘汰最久未用、且不是当前 classpath 的 daemon */
  _trim(keep) {
    while (this.daemons.size > MAX_DAEMONS) {
      let victim = null;
      for (const [cp, d] of this.daemons) {
        if (cp === keep) continue;
        if (!victim || d.lastUsed < victim.lastUsed) victim = d;
      }
      if (!victim) return;
      for (const [cp, d] of this.daemons) {
        if (d === victim) this.daemons.delete(cp);
      }
      victim.kill("daemon 池超限淘汰");
    }
  }
}

// 驱动类没加载出来时，ClassNotFoundException 的 message 就是一个类名（如 com.mysql.cj.jdbc.Driver），
// 单看毫无信息量，很容易被误判成"网络不通/口令错"。这里补上当前 classpath 与排查方向。
function driverHint(error, conn) {
  const msg = String(error || "");
  const looksDriver =
    /No suitable driver/i.test(msg) ||
    /ClassNotFound/i.test(msg) ||
    /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(msg.trim());
  if (!looksDriver) return "";
  const jars = String((conn && conn.classpath) || "")
    .split(path.delimiter)
    .map((p) => path.basename(p))
    .filter(Boolean);
  return (
    `（驱动类未加载：当前 JVM classpath = ${jars.join(", ") || "空"}；` +
    `检查连接配置的 driverClass / driverJar，或 $JMG_HOME/drivers.json 的 aliases）`
  );
}

// 模块级单例：MCP server 与整个 Node 进程共享一个池
module.exports = { JavaRunner, runner: new JavaRunner(), MAX_DAEMONS };
