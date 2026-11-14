/**
 * write-guard —— db_execute 的语句分级校验（独立模块，可单测）。
 * ---------------------------------------------------------------------------
 * 四级权限（连接 json 里的开关）：
 *   只读          默认                   SELECT 等（由 db_query 走，不进这里）
 *   DML           allowWrite: true       insert / update / delete / merge / replace
 *   DDL           allowDdl: true         create table|index、alter table add|modify|alter、comment on、drop index
 *   破坏性        allowDestructive: true drop table、truncate、drop column、drop view|schema|database
 *
 * 永远禁止（与开关无关）：grant / revoke / call / exec / execute / attach / detach /
 *                        vacuum / pragma，以及一切文件 I/O / 服务端文件外带（见 FILE_IO）。
 *
 * 2026-11-13（P0-1）：所有判定改为跑在 maskLiterals() 的"掩码 body"上。
 *   旧实现直接对原文做正则，两条绕过链：
 *     DELETE FROM t # WHERE id=1   → # 注释里的 WHERE 骗过全表检查（真提交全表删除）
 *     UPDATE t SET note='where'    → 字面量里的 where 骗过全表检查
 *   掩码后注释与字面量内容都变成空白（引号保留），WHERE / 多语句 / 禁词只认真实语法。
 *   顺带修掉三处反向误杀：值里的分号被当多语句、值里的 call/exec 被永久禁止。
 *
 * 注意：DDL 在 MySQL / 达梦是隐式提交，ROLLBACK 无效。所以 DDL 的"预演"只能是
 *      静态校验（不执行），不能像 DML 那样"执行后回滚"。调用方必须区别处理。
 */

const DML_KEYWORDS = new Set(["insert", "update", "delete", "merge", "replace"]);

const DDL_ALLOWED = [
  /^create\s+(table|index|unique\s+index)\b/i,
  /^alter\s+table\s+\S+\s+(add|modify|alter)\b/i,
  /^comment\s+on\b/i,
  /^drop\s+index\b/i,
];

const DDL_DESTRUCTIVE = [
  /^drop\s+table\b/i,
  /^truncate\b/i,
  /^alter\s+table\s+\S+\s+drop\b/i,
  /^drop\s+(view|schema|database)\b/i,
];

/** 权限/存储过程类：任何模式下都不允许 */
const ALWAYS_FORBIDDEN = /\b(grant|revoke|call|exec|execute|attach|detach|vacuum|pragma)\b/i;

/**
 * 文件 I/O / 服务端文件外带：写守卫永远禁止；db-query-server 的只读守卫复用同一张表（P1-2 对称）。
 * - 单标记：load_file / outfile（含 INTO OUTFILE）/ dumpfile / lo_import / lo_export / pg_read_file …
 * - 双词：LOAD DATA
 * - COPY 只在"语句起始"才算（PG COPY table TO/FROM ...），避免把名叫 copy 的列误杀。
 */
const FILE_IO = /\b(load_file|outfile|dumpfile|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_write_file|pg_ls_dir)\b|\bload\s+data\b|(?:^|;)\s*copy\b/i;

/** 只剥注释、不动字面量：仅用于返回给调用方展示的原始 body，不参与判定 */
function stripComments(sql) {
  return String(sql || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
}

/**
 * 掩码：把"注释"与"字符串字面量内容"替换成空白，保留引号与换行。
 * 顺序即 P0-1 要求的：块注释 → '..' / ".." 字面量（含 '' / "" 转义）→ -- 与 # 行注释。
 * 用单次字符扫描实现：纯正则无法区分"引号里的 /* "和真正的块注释，
 * 三段式 regex 在遇到 值里含 /* 时会把后面的引号一起吞掉，造成掩码错位。
 */
function maskLiterals(sql, opts = {}) {
  // MySQL 族默认开启反斜杠转义（\' / \"）；达梦/MSSQL/SQLite/PG 的标准串里 \ 是普通字符。
  // 默认 true 是安全方向：宁可多掩码（可能导致误拒），不可漏判（会让 \' 后的 " WHERE " 被当成真语法）。
  const backslashEscapes = opts.backslashEscapes !== false;
  const src = String(sql == null ? "" : sql);
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // 1) 块注释 /* ... */（未闭合则吃到结尾）
    if (ch === "/" && src[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) { out += "  "; i += 2; }
      continue;
    }
    // 2) 行注释 -- 与 #（MySQL 族）——到行尾，换行保留
    if ((ch === "-" && src[i + 1] === "-") || ch === "#") {
      out += ch === "#" ? " " : "  ";
      i += ch === "#" ? 1 : 2;
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    // 3) 字符串字面量 '...' / "..."：内容抹空白，引号保留；'' / "" 是转义
    if (ch === "'" || ch === '"') {
      out += ch;
      i++;
      while (i < src.length) {
        // 反斜杠转义：不处理会让字符串提前闭合，\' 后面的 WHERE 被当成真语法（P0-1 残留绕过）
        if (backslashEscapes && src[i] === "\\") { out += "  "; i += 2; continue; }
        if (src[i] === ch) {
          if (src[i + 1] === ch) { out += "  "; i += 2; continue; }
          out += ch;
          i++;
          break;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  // 空白压缩：只影响可读性，不改变 token 边界（引号还在，不会把两个标识符粘起来）
  return out.replace(/[ \t]+/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 只做分类，不校验权限（供预演/展示用）*/
function classifyStatement(sql, opts = {}) {
  const body = maskLiterals(sql, opts).replace(/;\s*$/, "");
  if (DDL_DESTRUCTIVE.some((re) => re.test(body))) return "destructive";
  if (DDL_ALLOWED.some((re) => re.test(body))) return "ddl";
  const first = (body.match(/^[A-Za-z]+/) || [""])[0].toLowerCase();
  if (DML_KEYWORDS.has(first)) return "dml";
  return "unknown";
}

/**
 * 校验写语句。
 * @param {string} sql
 * @param {{allowWrite?:boolean, allowDdl?:boolean, allowDestructive?:boolean, connName?:string}} perms
 * @returns {{kind:"dml"|"ddl"|"destructive", first:string, body:string, masked:string}}
 * @throws {Error} 不满足权限或不合法时
 */
function assertWriteSafe(sql, perms = {}) {
  const masked = maskLiterals(sql, { backslashEscapes: perms.backslashEscapes }).replace(/;\s*$/, "");
  const body = stripComments(sql).replace(/;\s*$/, ""); // 原文（只去注释），仅用于返回/展示
  const first = (masked.match(/^[A-Za-z]+/) || [""])[0].toLowerCase();

  if (!first) throw new Error("写守卫拒绝：空语句。");
  // 多语句：只看掩码（值里的 'a;b' 不再被误判）
  if (/;\s*\S/.test(masked)) throw new Error("写守卫拒绝：检测到多语句，请拆成单条。");
  if (ALWAYS_FORBIDDEN.test(masked)) {
    throw new Error("写守卫拒绝：权限/存储过程/系统命令类语句永远禁止（grant/revoke/call/exec 等）。");
  }
  if (FILE_IO.test(masked)) {
    throw new Error("写守卫拒绝：文件 I/O / 服务端文件读写类语句永远禁止（OUTFILE / LOAD_FILE / COPY / pg_read_file 等）。");
  }

  if (DDL_DESTRUCTIVE.some((re) => re.test(masked))) {
    if (!perms.allowDestructive) {
      throw new Error(
        "写守卫拒绝：这是破坏性 DDL（DROP TABLE / TRUNCATE / DROP COLUMN），且不可回滚。" +
          '需要在连接配置里显式加 "allowDestructive": true（生产库不要开）。'
      );
    }
    return { kind: "destructive", first, body, masked };
  }

  if (DDL_ALLOWED.some((re) => re.test(masked))) {
    if (!perms.allowDdl) {
      throw new Error(
        '写守卫拒绝：DDL 未授权。要建表/改表，需在连接 json 里加 "allowDdl": true（建议只对开发/测试库开）。'
      );
    }
    return { kind: "ddl", first, body, masked };
  }

  if (DML_KEYWORDS.has(first)) {
    if (!perms.allowWrite) {
      throw new Error(`写守卫拒绝：连接 "${perms.connName || "?"}" 未开启写权限（allowWrite）。`);
    }
    // 只看掩码：'where' 字面量 / # 注释里的 WHERE 都不再算数
    if (["update", "delete", "merge"].includes(first) && !/\bwhere\b/i.test(masked)) {
      throw new Error(`写守卫拒绝：${first.toUpperCase()} 必须带 WHERE 条件（禁止全表操作）。`);
    }
    return { kind: "dml", first, body, masked };
  }

  throw new Error(
    `写守卫拒绝：不支持的语句类型 "${first}"。允许 DML(insert/update/delete/merge/replace)、` +
      "DDL(create / alter add|modify / comment on / drop index)、破坏性(drop table/truncate/drop column，需 allowDestructive)。"
  );
}

module.exports = { assertWriteSafe, classifyStatement, maskLiterals, FILE_IO, DML_KEYWORDS };
