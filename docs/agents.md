# Pre-Seeded AI Agents

Two agents are automatically created (or updated) on every LibreChat startup via `api/models/seedBtpAdvisor.js`. The seeding is idempotent — if an agent with the same name and provider already exists, it is updated in place, not duplicated.

---

## BTP Advisor

| Field | Value |
|-------|-------|
| Name | `BTP Advisor` |
| Model | `qwen3.5:397b` |
| Endpoint | Ollama Cloud (via `ollama-proxy`) |
| MCP Servers | `btp-mcp` (all 41 tools) |
| Category | SAP BTP |
| Language | German |

### System Prompt Philosophy

The system prompt enforces two strict rules:

1. **Tool-first**: The agent's first output after any user message is always a tool call — no planning text, no "I will...", no step lists.
2. **Artifact-only after `btp_health_dashboard`**: After calling `btp_health_dashboard`, the agent outputs only the `:::artifact` block. No text before or after.

### `TOOL_DATA_B64` Mechanism

The React artifact contains `atob('TOOL_DATA_B64')`. The system prompt explicitly instructs the LLM to **never replace this placeholder**. Instead, `ollama-proxy` intercepts the streaming response and substitutes `TOOL_DATA_B64` with the base64-encoded JSON result from `btp_health_dashboard`.

This avoids LLM truncation of large JSON payloads (50–200 KB) embedded in artifact code strings.

### Conversation Starters

1. Create an interactive React dashboard with the current BTP Health Status
2. Full Global Account overview: subaccounts, regions, statuses, entitlements
3. Security review: users, role collections, admin identification
4. Cloud Foundry troubleshooting: failed apps, events, environment variables

---

## SAP ABAP Advisor

| Field | Value |
|-------|-------|
| Name | `SAP ABAP Advisor` |
| Model | `qwen3.5:397b` |
| Endpoint | Ollama Cloud (via `ollama-proxy`) |
| MCP Servers | `sap` (single-system VSP read access) |
| Category | SAP ABAP |
| Language | German |

### System Prompt Philosophy

Same tool-first rule as BTP Advisor. Additional constraints:

- Uses SAP terminology correctly (Mandant, Transportauftrag, Entwicklungsklasse/Paket)
- Formats ABAP table results as Markdown tables with field names as headers
- Technical names (tables, transactions, function modules) always in `monospace`
- On RFC errors (403, timeout): short explanation, then continues with available data
- Explicitly read-only — explains manual steps if user requests changes

### Conversation Starters

1. Full system overview: SAP release, kernel version, database, OS
2. Custom development analysis: Z\* and Y\* objects by package
3. User audit: lock status, last login, SAP_ALL, inactive >90 days
4. Transport requests: open/released, grouped by status and age

---

## Seeding Mechanism

**File:** `api/models/seedBtpAdvisor.js`

The seed function runs on every server start:

1. Finds the first admin user (fallback: first user). If no users exist yet (first boot before login), skips and retries on next restart.
2. For each agent:
   - If the agent (`name` + `provider` unique) already exists → `updateOne` with latest instructions and starters
   - If not → creates a new agent with a UUID-based `agent_id`
3. Ensures all users have ACL entries (`permBits: 15` = full access) for each agent.

The `api/models/` directory is volume-mounted into the container, so changes to the seed file take effect on the next `docker restart LibreChat` without a full rebuild.
