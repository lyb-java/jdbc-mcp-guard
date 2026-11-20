#!/usr/bin/env node
/**
 * 构建 JDBC 桥 jar：db/jdbc-mcp-guard-bridge.jar
 * 需要 JDK 17+（javac + jar）。构建后运行时只需要 JRE。
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "build", "java-classes");
const jarFile = path.join(root, "db", "jdbc-mcp-guard-bridge.jar");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const javac = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "javac.exe" : "javac") : "javac";
const jar = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "jar.exe") : "jar";
const srcs = [path.join(root, "db", "DbQuery.java"), path.join(root, "db", "DbQueryDaemon.java")];

execFileSync(javac, ["-encoding", "UTF-8", "--release", "17", "-d", out, ...srcs], { stdio: "inherit" });
execFileSync(jar, ["--create", "--file", jarFile, "-C", out, "."], { stdio: "inherit" });
fs.rmSync(path.join(root, "build"), { recursive: true, force: true });
console.log("built " + path.relative(root, jarFile));
