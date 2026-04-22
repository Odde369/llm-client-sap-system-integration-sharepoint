# Architecture

## Component Overview

```
Browser / Eclipse IDE
        │
        │ HTTP :3080
        ▼
┌───────────────────────────────────────────────────────────┐
│                  LibreChat API (Node.js)                  │
│                                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ Agent Router │  │  MCP Client  │  │  Conversation   │ │
│  │              │  │  (connects   │  │  & Message      │ │
│  │ BTP Advisor  │  │  to MCP      │  │  Storage        │ │
│  │ ABAP Advisor │  │  servers)    │  │  (MongoDB)      │ │
│  └──────┬───────┘  └──────┬───────┘  └─────────────────┘ │
│         │                 │                               │
└─────────┼─────────────────┼───────────────────────────────┘
          │                 │
          │ (via Ollama Cloud endpoint)
          ▼                 │
┌─────────────────┐         │  MCP Streamable HTTP
│  ollama-proxy   │         │
│  :4010          │   ┌─────┼──────────────────────────────┐
│                 │   │     │                              │
│  • Normalizes   │   │  ┌──▼──────┐ ┌──────────┐ ┌──────┐│
│    tool calls   │   │  │btp-mcp  │ │sap-multi │ │ docs ││
│  • Injects      │   │  │:4004    │ │:3140     │ │:3124 ││
│    __respond__  │   │  │         │ │          │ │      ││
│  • TOOL_DATA    │   │  │41 tools │ │VSP pool  │ │FTS   ││
│    _B64 subst.  │   │  └─────────┘ └────┬─────┘ │search││
└────────┬────────┘   │                   │       └──────┘│
         │            │            ┌──────▼──────┐        │
         ▼            │            │  VSP process│        │
  Ollama Cloud /      │            │  (Go binary)│        │
  local Ollama        │            │  per system │        │
                      │            └─────────────┘        │
                      │                                    │
                      │  ┌───────────┐                     │
                      │  │  sap      │                     │
                      │  │  :3130    │                     │
                      │  │ (single   │                     │
                      │  │  system)  │                     │
                      │  └───────────┘                     │
                      └────────────────────────────────────┘

┌───────────────────────────────┐
│  sandpack-bundler  :3300      │
│  Serves Sandpack v2.19.8      │
│  static assets locally        │
│  (no *.codesandbox.io needed) │
└───────────────────────────────┘
```

---

## Data Flow: BTP Health Dashboard Artifact

This is the most complex flow, involving artifact code injection.

```
User: "Dashboard erstellen"
         │
         ▼
LibreChat Agent (BTP Advisor)
  → sends prompt to Ollama Cloud via ollama-proxy
         │
         ▼
ollama-proxy
  → injects __respond__ tool
  → sets tool_choice="required"
  → forwards to upstream LLM
         │
         ▼
LLM (qwen3.5:397b)
  → calls btp_health_dashboard tool
         │
         ▼
btp-mcp
  → queries BTP APIs (CIS, CF, SM, UDM)
  → assembles health snapshot JSON
  → returns large JSON payload
         │
         ▼
ollama-proxy
  ← receives tool result with JSON
  → detects "TOOL_DATA_B64" placeholder in next LLM response
  → replaces TOOL_DATA_B64 with base64(JSON)
  → forwards to LibreChat
         │
         ▼
LibreChat
  → parses :::artifact{type="application/vnd.react"} block
  → renders React component in Sandpack iframe
         │
         ▼
Browser
  → loads Sandpack bundler from http://localhost:3300
  → Sandpack compiles and runs the React artifact
  → artifact calls atob('eyJ...') to decode the BTP data
  → renders interactive dashboard
```

**Why TOOL_DATA_B64?**
LLMs truncate long strings when generating code. Instead of asking the LLM to copy 50KB of JSON into an artifact, the proxy injects the data automatically. The LLM only outputs the literal string `TOOL_DATA_B64` which the proxy replaces with the actual base64-encoded data.

---

## Data Flow: ABAP Tool Call (Multi-System)

```
User: "Zeige Custom-Tabellen in S4H_DEV"
         │
         ▼
LibreChat → btp-mcp or sap-multi MCP server
         │
         ▼
sap-mcp-proxy (:3140)
  → reads systems.json → finds "S4H_DEV"
  → checks VSP pool: no process running?
    → spawns VSP Go binary as child process (stdio transport)
  → forwards tool call to VSP process
         │
         ▼
VSP (vibing-steampunk) Go binary
  → connects to SAP system via HTTP/HTTPS
  → executes ABAP query (read-only)
  → returns results
         │
         ▼
sap-mcp-proxy
  → returns results to LibreChat
  → VSP process stays alive (idle timeout: 10 min)
```

---

## Authentication Flows

### BTP OAuth (btp-mcp)

```
btp-mcp container
  → BTP CLI: authenticates with BTP_USER / BTP_PASSWORD
    → exchanges for platform token (subdomain from BTP_ACCOUNTS_SERVICE_TOKEN_URL)
  → CIS REST: client_credentials with BTP_ACCOUNTS_SERVICE_CLIENT_ID/SECRET
  → Service Manager: client_credentials with BTP_SM_CLIENT_ID/SECRET
  → Cloud Foundry API: UAA token from CF login endpoint
  → UDM: client_credentials with BTP_UDM_CLIENT_ID/SECRET
  → All tokens cached in-memory (5-min TTL for trust configs)
```

### SAP ABAP (vsp-mcp / sap-mcp-proxy)

```
VSP process
  → Basic Auth over HTTPS to SAP_URL
  → Uses SAP_TECH_USER / SAP_TECH_PASSWORD
  → SAP_CLIENT header for client selection
  → SAP_READ_ONLY=true blocks any write operations at VSP level
```

### LLM Authentication

```
LibreChat → ollama-proxy (:4010)
  → Bearer token forwarded transparently from LibreChat
  → ollama-proxy adds normalization logic, then forwards to UPSTREAM_BASE
  → UPSTREAM_BASE = https://ollama.com (Ollama Cloud)
```

---

## Sandpack: Corporate Network Bypass

Standard LibreChat loads the Sandpack code bundler from `https://{version}-sandpack.codesandbox.io/`. Corporate networks often block `*.codesandbox.io`.

**Solution:**

1. `sandpack-bundler` Docker image downloads all Sandpack v2.19.8 assets at build time
2. Serves them locally on port 3300 with required CORS/COEP headers
3. `SANDPACK_BUNDLER_URL=http://localhost:3300` in `.env` tells LibreChat to use the local mirror
4. LibreChat passes the URL to browser via `/api/config` → Sandpack uses it for the iframe

**Required headers for Sandpack iframe:**
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Resource-Policy: cross-origin`

---

## VSP Network Isolation

The `vsp-mcp` container runs with `NET_ADMIN` capability and enforces strict egress filtering:

```
iptables rules (applied at container start via entrypoint.sh):
  ALLOW: loopback (lo)
  ALLOW: established connections
  ALLOW: TCP to SAP_URL host only (port 443 / 8043)
  DROP:  all other outbound traffic
```

This ensures the ABAP introspection process cannot make unexpected outbound connections even if the VSP binary or a loaded ABAP object contains malicious code.
