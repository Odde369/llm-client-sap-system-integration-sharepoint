# VSP MCP (Single-System ABAP Access)

**Container:** `vsp-mcp`
**Port:** `3130` (→ internal `3000`)
**Source:** `docker/vsp-mcp/`
**LibreChat MCP Name:** `sap`

Provides read-only MCP access to a single SAP S/4HANA system using [vibing-steampunk](https://github.com/oisee/vibing-steampunk) (VSP), an open-source Go tool for ABAP system introspection.

---

## Docker Build

The image is built in two stages:

**Stage 1 — Build VSP binary:**
```dockerfile
FROM golang:1.24 AS builder
RUN git clone --depth 1 --branch v2.25.0 \
    https://github.com/oisee/vibing-steampunk.git .
RUN go build -o vsp .
```

**Stage 2 — Runtime:**
```dockerfile
FROM node:20-alpine
# Copies compiled Go binary from builder
# Installs mcp-proxy (npm global) to wrap VSP over HTTP/MCP
```

VSP communicates via stdio; `mcp-proxy` wraps it into a Streamable HTTP MCP server.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SAP_URL` | (required) | SAP system URL, e.g. `https://host:8043` |
| `SAP_USER` | — | Technical user name |
| `SAP_PASSWORD` | — | Technical user password |
| `SAP_CLIENT` | `001` | SAP client number |
| `SAP_INSECURE` | `false` | Skip TLS certificate verification |
| `SAP_READ_ONLY` | `true` | Block all write operations at VSP level |
| `VSP_MODE` | `focused` | VSP tool group mode (focused = reduced toolset) |
| `VSP_EGRESS_LOCKDOWN` | `true` | Enforce iptables egress filtering |
| `VSP_EXTRA_ARGS` | `--transport-read-only --enable-transports` | Additional VSP CLI flags |
| `MCP_PROXY_PORT` | `3000` | MCP HTTP port inside container |

---

## Network Isolation (Egress Lockdown)

When `VSP_EGRESS_LOCKDOWN=true`, the container's `entrypoint.sh` applies iptables rules:

```bash
# Allow loopback
iptables -A OUTPUT -o lo -j ACCEPT
# Allow established connections
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
# Allow TCP to SAP host only
iptables -A OUTPUT -p tcp --dport <SAP_PORT> -d <SAP_HOST_IP> -j ACCEPT
# Drop everything else
iptables -A OUTPUT -j DROP
```

This requires the `NET_ADMIN` capability (`cap_add: [NET_ADMIN]` in `docker-compose.override.yml`).

The VSP process (and any potentially loaded ABAP content) cannot make outbound connections to anything other than the configured SAP system.

---

## Docker Configuration

```yaml
# docker-compose.override.yml
vsp-mcp:
  container_name: vsp-mcp
  build:
    context: ./docker/vsp-mcp
  cap_add:
    - NET_ADMIN
  environment:
    - SAP_URL=${SAP_URL}
    - SAP_USER=${SAP_TECH_USER}
    - SAP_PASSWORD=${SAP_TECH_PASSWORD}
    - SAP_CLIENT=${SAP_CLIENT}
    - SAP_INSECURE=${SAP_INSECURE}
    - MCP_PROXY_PORT=3000
    - VSP_MODE=focused
    - SAP_READ_ONLY=true
    - VSP_EGRESS_LOCKDOWN=true
    - VSP_EXTRA_ARGS=--transport-read-only --enable-transports
  ports:
    - "3130:3000"
```

---

## Used By

- **SAP ABAP Advisor** agent (LibreChat MCP server `sap`)
- Eclipse plugin sends context to this system for single-system queries

## Upgrading VSP Version

Change the git tag in `docker/vsp-mcp/Dockerfile`:
```dockerfile
RUN git clone --depth 1 --branch v2.26.0 ...
```
Then rebuild: `docker compose ... build vsp-mcp && docker compose ... up -d vsp-mcp`
