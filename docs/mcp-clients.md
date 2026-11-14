# MCP client configuration

The server speaks MCP over **stdio**. Register it in your client with an absolute path.

## Generic stdio config

```json
{
  "mcpServers": {
    "jdbc": {
      "command": "node",
      "args": ["/absolute/path/to/jdbc-mcp-guard/server.js"],
      "env": { "JMG_HOME": "/absolute/path/to/.jdbc-mcp-guard" }
    }
  }
}
```

## Claude Desktop

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\\Claude\\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "jdbc": {
      "command": "node",
      "args": ["C:/tools/jdbc-mcp-guard/server.js"],
      "env": { "JMG_HOME": "C:/Users/you/.jdbc-mcp-guard" }
    }
  }
}
```

## Cursor

```json
{
  "mcpServers": {
    "jdbc": {
      "command": "node",
      "args": ["/opt/jdbc-mcp-guard/server.js"],
      "env": { "JMG_HOME": "/home/you/.jdbc-mcp-guard" }
    }
  }
}
```

## Tips

- Use `JMG_HOME` to keep credentials out of the repo checkout.
- Put a **read-only** connection as `default.json`; add a separate writable connection only for the database you actually want the agent to modify.
- Check `db_connections` after connecting: it shows every connection and whether it is read-only or writable.
