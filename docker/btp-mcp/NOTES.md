# Session Notes — BTP MCP Server

## Repo
`C:\Users\Anwender\Projekte\librechat`
Stack: LibreChat + Docker Compose + custom btp-mcp Node.js MCP server
Aktives Modell: **deepseek-v3.1:671b-cloud** via Ollama Cloud

---

## Aktueller Tool-Stand (25 Tools)

### Account & Struktur (CIS Central REST API)
| Tool | Beschreibung |
|------|-------------|
| `globalAccount_get` | Global Account Details |
| `subaccounts_list` | Alle Subaccounts |
| `subaccounts_get` | Einzelner Subaccount per GUID |
| `directories_list` | Alle Directories |
| `directories_get` | Einzelnes Directory per GUID |
| `entitlements_list` | Service-Pläne & Zuweisungen |
| `events_list` | BTP Audit-Events |

### BTP CLI (gleiche Auth wie Terraform BTP Provider: nur subdomain + user + password)
| Tool | Beschreibung |
|------|-------------|
| `provisioning_environments_list` | CF/Kyma Environments je Subaccount (subaccountGUID required) |
| `saas_subscriptions_list` | SaaS-Subscriptions — ohne subaccountGUID: aggregiert alle Subaccounts server-seitig in einem Call |
| `users_list` | User global oder je Subaccount (inkl. Role Collections) |
| `role_collections_list` | Role Collections global oder je Subaccount |

### Service Manager
| Tool | Beschreibung |
|------|-------------|
| `service_instances_list` | SM Service Instances |
| `service_bindings_list` | SM Service Bindings |

### Cloud Foundry
| Tool | Beschreibung |
|------|-------------|
| `cf_orgs_list` | CF Organisationen |
| `cf_spaces_list` | CF Spaces (mit orgGUID-Filter) |
| `cf_apps_list` | Apps (paginiert, server-seitige Filter) |
| `cf_app_get` | App-Details + Processes + Routes in einem Call |
| `cf_app_processes` | Instanzen, Memory, CPU-Stats |
| `cf_app_routes` | URLs/Routes einer App |
| `cf_app_env` | VCAP_SERVICES, Env-Variablen |
| `cf_app_events` | Crash/Restart/Staging-Events |
| `cf_service_instances_list` | CF-Level Service Instances (mit space/org-Filter) |
| `cf_service_bindings_list` | Welche App bindet welchen Service |
| `cf_org_quotas_list` | Memory/Service/Route-Limits je Org |
| `cf_domains_list` | Routing Domains |

---

## Implementierte Fixes & Optimierungen

### SSE Keepalive (DONE ✅)
Alle 20s ein SSE-Kommentar verhindert Docker TCP-Idle-Timeout (60s).
`httpServer.timeout = 0` verhindert Node-seitige Timeouts zusätzlich.

### recursionLimit (DONE ✅)
`recursionLimit: 100`, `maxRecursionLimit: 200` in `librechat.enterprise.yaml`.

### CF-Apps Paginierung (DONE ✅)
Server-seitiger Filter per `organization_guids` / `space_guids` / `states` wenn GUIDs bekannt.
Client-seitig nur noch Name-Filter (CF API unterstützt kein Partial-Name-Search).

### GUIDs in cf_apps_list (DONE ✅)
`guid`, `space_guid`, `org_guid` im Output — Chaining zu Detail-Tools möglich.

### parallel_tool_calls: false (DONE ✅)
Ollama Cloud unterstützt keine parallelen Tool-Calls (mehrere tool_calls in einem Response führen zu plaintext-Output).
Fix: `parallel_tool_calls: false` in `librechat.enterprise.yaml` addParams für Ollama Cloud.
System-Prompt updated: „Rufe immer nur ein Tool pro Schritt auf."

### dropInvalidParams für Ollama Cloud (DONE ✅)
Verhindert Fehler wenn DeepSeek optionale Params als `null` übergibt.

### Nullable Zod-Parameter (DONE ✅)
`z.string().optional()` → `z.string().nullable().optional()` für alle optionalen Parameter.
Sonst: Groq/DeepSeek schickt `null` und Zod wirft Validierungsfehler.

### NODE_OPTIONS (DONE ✅)
`NODE_OPTIONS=--max-old-space-size=6144` in .env — `NODE_MAX_OLD_SPACE_SIZE` allein hat keinen Effekt.

### btp-mcp Description in YAML (DONE ✅)
Listet alle CF-Capabilities auf → LLM wählt Server auch für CF-Fragen.

### BTP CLI Integration (DONE ✅)
Gleiche Auth wie Terraform BTP Provider: nur `BTP_USER` + `BTP_PASSWORD` + Subdomain aus `BTP_ACCOUNTS_SERVICE_TOKEN_URL`.
Binary (`btp` v2.97.0, Linux x86_64) manuell heruntergeladen und per `COPY` ins Image.
`ca-certificates` im Dockerfile installiert (node:20-bookworm-slim hat kein volles CA-Bundle).
Login-Parameter: `--subdomain` (nicht `--global-account`).

### saas_subscriptions_list Server-side Aggregation (DONE ✅)
BTP CLI unterstützt `list accounts/subscription` nur per `--subaccount`.
Ohne subaccountGUID: Tool holt selbst alle Subaccounts via CIS Central API und iteriert intern → LLM braucht nur einen Tool-Call.

---

## Bekannte Lücken / Noch offen

| Thema | Aufwand | Notiz |
|---|---|---|
| BTP Cost/Metering | Hoch | Eigenes Service Binding benötigt |
| Kyma Cluster | Sehr hoch | Separater Kubeconfig-Zugang |
| sap/docs Keepalive | Mittel | Third-Party Container, kein direkter Fix möglich |
| CF App Logs | Mittel | log-cache API, separater Endpunkt |

---

## BTP CLI Setup (einmalig)

```
1. btp Linux x86_64 binary von https://tools.hana.ondemand.com/#cloud-btpcli herunterladen
   (EULA im Browser akzeptieren, dann .tar.gz downloaden)
2. tar -xzf btp-cli-linux-amd64-*.tar.gz
3. copy btp C:\Users\Anwender\Projekte\librechat\docker\btp-mcp\btp
4. docker compose build btp-mcp && docker compose up -d btp-mcp
```

Benötigte .env-Variablen:
- `BTP_USER` — Admin-User (z.B. o.dede@advades.com)
- `BTP_PASSWORD` — Passwort
- `BTP_ACCOUNTS_SERVICE_TOKEN_URL` — Subdomain wird daraus abgeleitet (`advadesgmbh`)

---

## BTP Advisor Agent Setup

→ Siehe `BTP_ADVISOR_SYSTEM_PROMPT.md` für den kompletten System-Prompt.
Im LibreChat Agent Builder: btp-mcp + sap + docs aktivieren, deepseek-v3.1:671b-cloud wählen.

---

## Build-Workflow

```powershell
# Nach Änderungen an index.js:
docker compose build btp-mcp && docker compose up -d btp-mcp && docker compose restart api

# Nur Config-Änderungen (librechat.enterprise.yaml):
docker compose restart api
```

## Docker-Quirks
- `docker exec` funktioniert nicht (Client v1.43 zu alt) → immer `docker compose exec` nutzen
- SM: client_credentials grant, anderes XSUAA: `advades-dev.authentication.eu10.hana.ondemand.com`
- CF: public OAuth2 client "cf" (kein Client Secret), UAA: `uaa.cf.eu10.hana.ondemand.com`
- BTP CLI Login: `--subdomain` (nicht `--global-account`) + `ca-certificates` Paket im Image nötig
