# SAP MCP Proxy (Multi-System)

**Container:** `sap-mcp-proxy`
**Port:** `3140` (→ internal `3000`)
**Source:** `docker/sap-mcp-proxy/`
**LibreChat MCP Name:** `sap-multi`

A dynamic MCP proxy that manages multiple SAP S/4HANA system connections. Instead of one VSP process for a hardcoded system, this proxy spawns VSP child processes on demand — one per configured SAP system — and routes tool calls to the right process.

---

## Exposed Tools

### `sap_list_systems`
Lists all configured SAP systems.

**Returns:** System IDs, display labels, URLs, client numbers.

### `sap_execute`
Executes any VSP tool on a specific SAP system.

**Parameters:**
- `system` — System ID from `sap_list_systems`
- `tool` — Tool name (from `sap_list_tools`)
- `args` — Tool arguments object

### `sap_list_tools`
Lists all available VSP tools for a specific system.

**Parameters:**
- `system` — System ID

---

## Configuration: `systems.json`

The systems configuration is a JSON file volume-mounted into the container at `/app/systems.json`. It supports `${ENV_VAR}` placeholder expansion:

```json
{
  "systems": {
    "S4H_PRD": {
      "url": "${SAP_URL_PRD}",
      "client": "100",
      "label": "S/4HANA Production"
    },
    "S4H_DEV": {
      "url": "${SAP_URL_DEV}",
      "client": "001",
      "label": "S/4HANA Development"
    }
  }
}
```

The file is watched with `fs.watch`. Changes are picked up automatically:
- New systems are added to the pool
- Removed systems have their VSP processes terminated
- No container restart required

---

## VSP Process Pool

**File:** `docker/sap-mcp-proxy/vsp-pool.js`

| Behavior | Detail |
|----------|--------|
| Spawning | VSP process is spawned on first tool call to that system |
| Transport | stdio (MCP over stdin/stdout) |
| Tool caching | Tool list is fetched once and cached per system |
| Idle timeout | 600,000 ms (10 minutes). Process is killed after inactivity. |
| On timeout | Cleaned up from pool; re-spawned on next tool call |

---

## Docker Configuration

```yaml
# docker-compose.override.yml
sap-mcp-proxy:
  container_name: sap-mcp-proxy
  build:
    context: ./docker/sap-mcp-proxy
  environment:
    - MCP_PROXY_PORT=3000
    - SYSTEMS_PATH=/app/systems.json
  env_file:
    - .env                          # provides ${ENV_VAR} values for systems.json
  volumes:
    - type: bind
      source: ./docker/sap-mcp-proxy/systems.json
      target: /app/systems.json
  ports:
    - "3140:3000"
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP Streamable HTTP endpoint (new transport per session) |
| `/health` | GET | Returns `{"status":"ok","systems":N}` |

---

## Relation to `vsp-mcp`

| | `vsp-mcp` | `sap-mcp-proxy` |
|--|-----------|-----------------|
| Systems | 1 (hardcoded via env) | N (systems.json, hot-reloadable) |
| Process | Always running | On-demand, idle timeout |
| LibreChat name | `sap` | `sap-multi` |
| Use case | Single-system ABAP Advisor agent | Multi-system queries, Eclipse plugin |
