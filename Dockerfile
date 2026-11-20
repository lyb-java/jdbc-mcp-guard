# jdbc-mcp-guard — container image (Node.js + JRE, stdio MCP over `docker run -i`)
# 可用 --build-arg NODE_IMAGE=<mirror>/library/node:20-bookworm-slim 指定镜像源
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE}

RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js write-guard.js java-runner.js daemon-path.js schema-cache.js java-bridge.js index-meta.js explain.js ./
COPY db/ ./db/
COPY examples/ ./examples/
COPY docs/ ./docs/
COPY README.md README.zh-CN.md LICENSE ./

ENV JMG_HOME=/data
VOLUME ["/data"]
ENTRYPOINT ["node", "server.js"]
