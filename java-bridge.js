/**
 * 预编译 JDBC 桥：db/jdbc-mcp-guard-bridge.jar
 * ---------------------------------------------------------------------------
 * 有 jar 时直接用它当 classpath —— 运行时只需要 JRE（java），不需要 JDK（javac）。
 * 没 jar（例如从源码 clone 后没构建过）才回退到 javac 现场编译。
 * 构建：npm run build:java
 */
const fs = require("fs");
const path = require("path");

const JAR = path.join(__dirname, "db", "jdbc-mcp-guard-bridge.jar");

function bridgeJarPath() {
  try {
    return fs.statSync(JAR).isFile() ? JAR : null;
  } catch {
    return null;
  }
}

module.exports = { JAR, bridgeJarPath };
