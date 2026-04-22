# Setup & Configuration

## Prerequisites

- **Docker** ≥ 24 with Docker Compose v2
- **Ollama** running natively on the host (accessed via `host.docker.internal:11434`)
- SAP BTP credentials (Global Account admin)
- SAP system credentials (read-only technical user recommended)
- Ollama Cloud API key (for `qwen3.5:397b` and other cloud models)

---

## First-Time Setup

```bash
# Clone / pull the repository
git clone <repo-url>
cd librechat

# Copy environment template and fill in credentials
cp .env.example .env   # if example exists, otherwise edit .env directly

# Build all custom images and start
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --build

# Tail logs to confirm startup
docker logs LibreChat -f
```

---

## Environment Variables

### SAP BTP

| Variable | Required | Description |
|----------|----------|-------------|
| `BTP_USER` | Yes | BTP platform user (e-mail) |
| `BTP_PASSWORD` | Yes | BTP platform password |
| `BTP_GLOBAL_ACCOUNT_SUBDOMAIN` | Yes | Global Account subdomain (from BTP cockpit URL) |
| `BTP_ACCOUNTS_SERVICE_BASE_URL` | Yes | e.g. `https://accounts-service.cfapps.eu10.hana.ondemand.com` |
| `BTP_ACCOUNTS_SERVICE_TOKEN_URL` | Yes | OAuth token endpoint, e.g. `https://subdomain.authentication.eu10.hana.ondemand.com/oauth/token` |
| `BTP_ACCOUNTS_SERVICE_CLIENT_ID` | Yes | Client ID for CIS Central service |
| `BTP_ACCOUNTS_SERVICE_CLIENT_SECRET` | Yes | Client secret for CIS Central service |
| `BTP_SM_BASE_URL` | Optional | Service Manager API base URL |
| `BTP_SM_TOKEN_URL` | Optional | Service Manager OAuth token URL |
| `BTP_SM_CLIENT_ID` | Optional | Service Manager client ID |
| `BTP_SM_CLIENT_SECRET` | Optional | Service Manager client secret |
| `BTP_UDM_BASE_URL` | Optional | Usage Data Management base URL |
| `BTP_UDM_TOKEN_URL` | Optional | UDM OAuth token URL |
| `BTP_UDM_CLIENT_ID` | Optional | UDM client ID |
| `BTP_UDM_CLIENT_SECRET` | Optional | UDM client secret |
| `BTP_CF_API_URL` | Optional | Cloud Foundry API URL (auto-detected if absent) |

### SAP ABAP System

| Variable | Required | Description |
|----------|----------|-------------|
| `SAP_URL` | Yes | SAP system URL, e.g. `https://host:8043` |
| `SAP_TECH_USER` | Yes | Technical user for ABAP read access |
| `SAP_TECH_PASSWORD` | Yes | Password for technical user |
| `SAP_CLIENT` | No | SAP client number (default: `001`) |
| `SAP_INSECURE` | No | Skip TLS verification (`true`/`false`, default: `false`) |

### LLM Endpoints

| Variable | Required | Description |
|----------|----------|-------------|
| `OLLAMA_CLOUD_API_KEY` | Yes | API key for Ollama Cloud models |
| `GROQ_API_KEY` | Optional | Groq API key |
| `UPSTREAM_BASE` | No | Ollama proxy upstream (default: `https://ollama.com`) |

### Sandpack

| Variable | Required | Description |
|----------|----------|-------------|
| `SANDPACK_BUNDLER_URL` | No | Override Sandpack CDN (default: uses codesandbox.io). Set to `http://localhost:3300` for corporate networks. |

### SAP Docs

| Variable | Required | Description |
|----------|----------|-------------|
| `SAP_DOCS_OFFLINE_MODE` | No | `true` = no outbound calls (default: `true`) |

---

## Rebuilding After Code Changes

Any change to `client/` or `api/` requires a Docker image rebuild:

```bash
# Rebuild only the api/client image
docker compose -f docker-compose.yml -f docker-compose.override.yml build api

# Restart with the new image
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d api
```

Changes to files in `api/models/` take effect on the **next container restart** (they are volume-mounted, no rebuild needed):

```bash
docker restart LibreChat
```

Changes to MCP services (`docker/btp-mcp/`, `docker/ollama-proxy/`, etc.) require rebuilding that specific service:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml build btp-mcp
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d btp-mcp
```

---

## Useful Log Commands

```bash
# LibreChat main process
docker logs LibreChat 2>&1 | tail -30

# BTP MCP — check tool calls and auth
docker logs btp-mcp 2>&1 | tail -30

# Ollama proxy — check TOOL_DATA_B64 injection and tool-call parsing
docker logs ollama-proxy 2>&1 | tail -30

# SAP ABAP access
docker logs vsp-mcp 2>&1 | tail -20

# Multi-system proxy — check VSP process pool
docker logs sap-mcp-proxy 2>&1 | tail -20

# All services at once
docker compose -f docker-compose.yml -f docker-compose.override.yml logs --tail=20
```

---

## SAP Multi-System Configuration

Add or update SAP systems without restarting. Edit `docker/sap-mcp-proxy/systems.json`:

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

The file is watched for changes. `${ENV_VAR}` placeholders are resolved from the container's environment (sourced from `.env` via `env_file`). No restart required.
