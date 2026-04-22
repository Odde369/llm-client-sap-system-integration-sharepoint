# BTP MCP Server

**Container:** `btp-mcp`
**Port:** `4004`
**Source:** `docker/btp-mcp/`

Provides 41 MCP tools for managing and monitoring a SAP Business Technology Platform (BTP) landscape. Wraps the BTP CLI, CIS REST API, Service Manager, Cloud Foundry API, and Usage Data Management (UDM) into a unified MCP server.

---

## Authentication

All credentials come from `.env` (passed via `env_file`). The server establishes multiple OAuth2 sessions:

| Service | Auth Method | Credentials |
|---------|-------------|-------------|
| BTP CLI | User/Password | `BTP_USER`, `BTP_PASSWORD` |
| CIS Central | client_credentials | `BTP_ACCOUNTS_SERVICE_CLIENT_ID/SECRET` |
| Service Manager | client_credentials | `BTP_SM_CLIENT_ID/SECRET` |
| Cloud Foundry | UAA password grant | `BTP_USER`, `BTP_PASSWORD` |
| UDM | client_credentials | `BTP_UDM_CLIENT_ID/SECRET` |

Tokens are cached in memory. Trust configurations are cached with a 5-minute TTL.

---

## Tool Reference

### BTP Platform

| Tool | Description |
|------|-------------|
| `globalAccount_get` | Global Account metadata: name, GUID, subdomain, region |
| `subaccounts_list` | All subaccounts with status, region, parent directory |
| `subaccounts_get` | Single subaccount details by GUID |
| `directories_list` | Directory hierarchy |
| `directories_get` | Single directory details |
| `entitlements_list` | All service entitlements with quota |
| `entitlement_quota_usage` | Used vs. available quota per service |
| `service_instances_list` | Service instances (optionally per subaccount) |
| `service_bindings_list` | Service bindings |
| `provisioning_environments_list` | Provisioned environments (CF, Kyma, etc.) |
| `saas_subscriptions_list` | Active SaaS application subscriptions |
| `events_list` | BTP audit events with filtering |
| `btp_change_history` | Compares current state with stored snapshots |
| `subaccount_compare` | Diff between two subaccounts |

### User & Security

| Tool | Description |
|------|-------------|
| `users_list` | Users in a subaccount (merged across all IdP origins) |
| `user_get` | Single user with all role collections |
| `user_cross_subaccount_lookup` | Find a user across all subaccounts |
| `role_collections_list` | Role collections in a subaccount |
| `role_collection_get` | Role collection detail with assigned roles and users |
| `trust_configurations_list` | IdP trust configurations |
| `security_audit` | Global admins, users with excessive permissions |
| `btp_best_practice_check` | Best practice compliance check |

### Cloud Foundry

| Tool | Description |
|------|-------------|
| `cf_orgs_list` | CF organizations |
| `cf_spaces_list` | CF spaces in an org |
| `cf_apps_list` | Applications in a space |
| `cf_app_get` | App details: state, instances, memory, disk |
| `cf_app_processes` | Running processes and health |
| `cf_app_routes` | Bound routes and domains |
| `cf_app_env` | Environment variables (secrets redacted) |
| `cf_app_events` | Recent app events |
| `cf_app_logs` | Recent log lines |
| `cf_app_crashes` | Crash history |
| `cf_app_scaling_analysis` | Memory/CPU usage vs. allocation |
| `cf_service_instances_list` | CF service instances |
| `cf_service_bindings_list` | CF service bindings |
| `cf_service_binding_age_audit` | Bindings older than threshold |
| `cf_org_quotas_list` | Org quota definitions |
| `cf_domains_list` | Registered domains |
| `cf_network_topology` | App → route → domain → service binding topology |

### Operations & Dashboards

| Tool | Description |
|------|-------------|
| `btp_health_dashboard` | Full health snapshot: all subaccounts, CF apps, services, entitlements, security — returned as JSON for artifact injection |
| `btp_cleanup_recommendations` | Identifies waste: orphaned services, idle apps, over-allocated quotas |

---

## Health History

The container persists health snapshots to `/data/btp-health-history.json` (Docker volume `btp-mcp-data`). Up to **60 snapshots** are retained. `btp_change_history` compares the current state with any stored snapshot to detect changes over time.

---

## `btp_health_dashboard` → Artifact Flow

This tool is special: it returns a large JSON object (50–200 KB) containing the full BTP landscape state. The BTP Advisor agent always calls this tool when a dashboard is requested.

1. `btp_health_dashboard` returns JSON
2. `ollama-proxy` detects the `TOOL_DATA_B64` placeholder in the LLM's artifact output
3. Proxy substitutes `TOOL_DATA_B64` → `base64(JSON)`
4. React artifact decodes it: `JSON.parse(atob('eyJ...'))`

See [architecture.md](../architecture.md) for the full data flow.

---

## Configuration

```yaml
# docker-compose.override.yml
btp-mcp:
  environment:
    - PORT=4004
    - LOG_LEVEL=debug
  env_file:
    - .env
  volumes:
    - btp-mcp-data:/data
```

Key `.env` variables:

```env
BTP_USER=user@example.com
BTP_PASSWORD=secret
BTP_GLOBAL_ACCOUNT_SUBDOMAIN=mysubdomain
BTP_ACCOUNTS_SERVICE_BASE_URL=https://accounts-service.cfapps.eu10.hana.ondemand.com
BTP_ACCOUNTS_SERVICE_TOKEN_URL=https://mysubdomain.authentication.eu10.hana.ondemand.com/oauth/token
BTP_ACCOUNTS_SERVICE_CLIENT_ID=sb-...
BTP_ACCOUNTS_SERVICE_CLIENT_SECRET=...
```
