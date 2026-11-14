#!/usr/bin/env node
/**
 * 从旧 DSH 版 db-query 迁移连接配置（幂等，只复制不删除）
 * ---------------------------------------------------------------------------
 *   ~/.dsh/db/*.json              -> $JMG_HOME/connections/
 *   ~/.dsh/db/drivers/*.jar       -> $JMG_HOME/drivers/
 *   ~/.gemini/lowcode.config.json -> $JMG_HOME/connections/default.json（旧 default 连接，仅当不存在时）
 *
 * 用法：node scripts/migrate-from-dsh.js [--dsh-home <dir>] [--dry-run]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const dry = args.includes("--dry-run");
const DSH = path.resolve(argVal("--dsh-home") || process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
const JMG = process.env.JMG_HOME || path.join(os.homedir(), ".jdbc-mcp-guard");
const SRC = path.join(DSH, "db");
const DST = path.join(JMG, "connections");
const DRV_SRC = path.join(SRC, "drivers");
const DRV_DST = path.join(JMG, "drivers");

if (!fs.existsSync(SRC)) {
  console.error("找不到旧配置目录：" + SRC);
  process.exit(1);
}
if (!dry) {
  fs.mkdirSync(DST, { recursive: true });
  fs.mkdirSync(DRV_DST, { recursive: true });
}

let copied = 0, skipped = 0, jars = 0;
for (const f of fs.readdirSync(SRC)) {
  if (!f.endsWith(".json") || f.startsWith("_") || f.includes("example")) continue;
  const to = path.join(DST, f);
  if (fs.existsSync(to)) { skipped++; continue; }
  if (!dry) fs.copyFileSync(path.join(SRC, f), to);
  copied++;
}

const legacy = path.join(os.homedir(), ".gemini", "lowcode.config.json");
const def = path.join(DST, "default.json");
if (!fs.existsSync(def) && fs.existsSync(legacy)) {
  try {
    const j = JSON.parse(fs.readFileSync(legacy, "utf8"));
    if (j.database) {
      if (!dry) fs.writeFileSync(def, JSON.stringify({ database: j.database }, null, 2) + "\n");
      console.log("default.json 已创建（来自 ~/.gemini/lowcode.config.json 的 database 段）");
    }
  } catch (e) {
    console.error("读取旧 lowcode.config.json 失败：" + e.message);
  }
}

if (fs.existsSync(DRV_SRC)) {
  for (const f of fs.readdirSync(DRV_SRC)) {
    if (!f.endsWith(".jar")) continue;
    const to = path.join(DRV_DST, f);
    if (fs.existsSync(to)) continue;
    if (!dry) fs.copyFileSync(path.join(DRV_SRC, f), to);
    jars++;
  }
}

console.log((dry ? "[dry-run] " : "") + "复制连接 " + copied + " 个、跳过已存在 " + skipped + " 个、驱动 " + jars + " 个");
console.log("目标：" + DST);
console.log("下一步：npm run selfcheck");
