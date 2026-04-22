# LibreChat — SAP Enterprise Extensions

This repository is a **LibreChat deployment extended for SAP enterprise use**.
On top of the standard LibreChat chat platform, it adds:

- AI-powered SAP BTP landscape management and health monitoring
- Multi-system ABAP read-access via vibing-steampunk (VSP)
- SAP documentation full-text search
- Eclipse IDE integration plugin for ABAP developers
- Tool-call normalization proxy for Ollama / DeepSeek models
- Local Sandpack CDN mirror for corporate networks

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    LibreChat API  (:3080)                           │
│   Agent Registry · MCP Registry · Conversation Router              │
└────────┬───────────┬────────────┬─────────────┬────────────────────┘
         │           │            │             │
    ┌────▼────┐ ┌────▼────┐ ┌─────▼────┐ ┌──────▼─────────┐
    │ btp-mcp │ │sap-multi│ │   sap    │ │     docs       │
    │  :4004  │ │  :3140  │ │  :3130   │ │    :3124       │
    │         │ │         │ │          │ │                │
    │ 41 BTP  │ │ Dynamic │ │  Single  │ │  SAP Help /    │
    │  tools  │ │ VSP pool│ │  ABAP    │ │  Community     │
    └─────────┘ └────┬────┘ └──────────┘ │  full-text     │
                     │                   └────────────────┘
              ┌──────▼──────┐
              │ VSP process │  (spawned on demand per system)
              │ (Go binary) │
              └─────────────┘

    ┌─────────────────────────┐    ┌────────────────────────┐
    │  ollama-proxy :4010     │    │  sandpack-bundler :3300│
    │  OpenAI-compat. proxy   │    │  Local CDN mirror for  │
    │  Tool-call normalizer   │    │  Sandpack v2.19.8      │
    └─────────────────────────┘    └────────────────────────┘

    ┌──────────────────────────────────────────────────────┐
    │              Eclipse IDE Plugin                      │
    │  Embedded LibreChat browser · SAP context injection  │
    └──────────────────────────────────────────────────────┘
```

---

## Service Reference

| Container | Host Port | Purpose |
|-----------|-----------|---------|
| `LibreChat` | 3080 | Main chat application |
| `btp-mcp` | 4004 | SAP BTP management (41 MCP tools) |
| `vsp-mcp` | 3130 | Single-system ABAP read access |
| `sap-mcp-proxy` | 3140 | Multi-system SAP routing |
| `sap-docs-mcp` | 3124 | SAP documentation search |
| `ollama-proxy` | 4010 | LLM tool-call normalizer |
| `sandpack-bundler` | 3300 | Local Sandpack CDN mirror |
| `chat-mongodb` | — | LibreChat database |
| `chat-meilisearch` | — | Full-text search index |
| `rag_api` | — | RAG document service |
| `vectordb` | — | Vector embeddings |

---

## Documentation Index

| File | Description |
|------|-------------|
| [architecture.md](architecture.md) | Detailed data-flow and auth diagrams |
| [setup.md](setup.md) | Installation, configuration, .env reference |
| [agents.md](agents.md) | Pre-seeded AI agents (BTP Advisor, ABAP Advisor) |
| [eclipse-plugin.md](eclipse-plugin.md) | Eclipse IDE plugin for ABAP developers |
| [services/btp-mcp.md](services/btp-mcp.md) | BTP MCP server — all 41 tools |
| [services/ollama-proxy.md](services/ollama-proxy.md) | LLM proxy and tool-call normalization |
| [services/sap-mcp-proxy.md](services/sap-mcp-proxy.md) | Multi-system SAP proxy |
| [services/vsp-mcp.md](services/vsp-mcp.md) | Single-system ABAP access |
| [services/sap-docs-mcp.md](services/sap-docs-mcp.md) | SAP documentation search |
| [services/sandpack-bundler.md](services/sandpack-bundler.md) | Local Sandpack CDN mirror |

---

## Quick Start

```bash
# 1. Copy and fill credentials
cp .env.example .env
# edit .env with BTP_USER, BTP_PASSWORD, SAP_URL, SAP_TECH_USER, ...

# 2. Build and start all services
docker compose -f docker-compose.yml -f docker-compose.override.yml up -d

# 3. Open browser
open http://localhost:3080
```

See [setup.md](setup.md) for the full `.env` reference and rebuild instructions.
