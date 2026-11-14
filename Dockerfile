# jdbc-mcp-guard — container image (Node.js + JRE, stdio MCP over `docker run -i`)
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js write-guard.js java-runner.js daemon-path.js schema-cache.js java-bridge.js ./
COPY db/ ./db/
COPY examples/ ./examples/
COPY docs/ ./docs/
COPY README.md README.zh-CN.md LICENSE ./

ENV JMG_HOME=/data
VOLUME ["/data"]
ENTRYPOINT ["node", "server.js"]
