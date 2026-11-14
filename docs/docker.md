# Docker

The image bundles Node.js 20 and a JRE 17 — nothing else is needed on the host.

```bash
docker build -t jdbc-mcp-guard .
```

Run it as an MCP stdio server (`-i` keeps stdin open):

```bash
docker run -i --rm \
  -v "$HOME/.jdbc-mcp-guard:/data" \
  jdbc-mcp-guard
```

Windows PowerShell:

```powershell
docker run -i --rm -v "${env:USERPROFILE}\.jdbc-mcp-guard:/data" jdbc-mcp-guard
```

Client configuration (Docker as the MCP command):

```json
{
  "mcpServers": {
    "jdbc": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "/home/you/.jdbc-mcp-guard:/data", "jdbc-mcp-guard"]
    }
  }
}
```

Notes:

- `JMG_HOME` is `/data` inside the container; mount your connection directory there.
- The container needs network access to the databases (add `--network host` on Linux, or the appropriate Docker network).
- The image is intentionally stdio-only for now; an HTTP/SSE transport is on the [roadmap](../ROADMAP.md).
