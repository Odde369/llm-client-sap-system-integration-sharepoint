# SAP Docs MCP

**Container:** `sap-docs-mcp`
**Port:** `3124` (→ internal `3122`)
**Source:** `docker/sap-docs-mcp/` (built from [github.com/marianfoo/mcp-sap-docs](https://github.com/marianfoo/mcp-sap-docs))
**LibreChat MCP Name:** `docs`

Provides full-text search over SAP documentation. By default runs in offline mode — no outbound calls, searches a local full-text index. Users can opt in to online sources per request.

---

## Sources

| Source | Online? | Default |
|--------|---------|---------|
| SAP Help Portal | Yes | Off |
| SAP Community | Yes | Off |
| Software Heroes | Yes | Off |
| Local FTS index | No | On |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SAP_DOCS_OFFLINE_MODE` | `true` | `true` = local FTS only, no outbound calls |
| `MCP_HOST` | `0.0.0.0` | Bind address |
| `MCP_PORT` | `3122` | Listening port |
| `MCP_INCLUDE_ONLINE_DEFAULT` | `false` | Whether online sources are included by default |

To enable online sources as default, set in `.env`:
```env
SAP_DOCS_OFFLINE_MODE=false
```

Users can also pass `includeOnline=true` as a tool parameter on a per-request basis regardless of the default.

---

## Docker Configuration

```yaml
# docker-compose.override.yml
sap-docs-mcp:
  container_name: sap-docs-mcp
  build:
    context: ./docker/sap-docs-mcp
    args:
      - SAP_DOCS_OFFLINE_MODE=${SAP_DOCS_OFFLINE_MODE:-true}
  environment:
    - MCP_HOST=0.0.0.0
    - MCP_PORT=3122
    - MCP_INCLUDE_ONLINE_DEFAULT=false
  ports:
    - "3124:3122"
```

---

## librechat.enterprise.yaml

```yaml
mcpServers:
  docs:
    type: streamable-http
    url: "http://sap-docs-mcp:3122/mcp"
    chatMenu: true
    startup: false
    timeout: 3600000
```

`startup: false` means the MCP connection is established on first use, not at LibreChat startup (saves resources).
