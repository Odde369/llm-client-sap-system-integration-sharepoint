# BTP Advisor — System Prompt & Seed-Konfiguration

Der BTP Advisor Agent wird beim Server-Start automatisch angelegt (`api/models/seedBtpAdvisor.js`).
Manuelles Kopieren ist **nicht mehr nötig**.

---

## Was wird automatisch erstellt?

### 1. Agent: BTP Advisor

| Einstellung | Wert |
|---|---|
| Name | BTP Advisor |
| Provider | Ollama Cloud |
| Modell | qwen3.5:397b |
| MCP Server | btp-mcp (alle Tools) |
| Kategorie | SAP BTP |
| Promoted | Ja (sichtbar für alle User) |

### 2. Conversation Starters (im Agent)

- Zeig mir eine Übersicht unseres Global Accounts mit allen Subaccounts.
- Welche Cloud Foundry Apps laufen aktuell und wie ist ihr Status?
- Liste alle Service-Instanzen und deren Bindings in unserem BTP-Account auf.
- Welche Entitlements haben wir und wie viel Quota ist noch verfügbar?
- Gibt es gestoppte oder fehlerhafte CF-Apps? Zeig mir die Details.
- Welche SaaS-Subscriptions sind aktiv und in welchen Subaccounts?

### 3. Prompt-Bibliothek (6 vordefinierte Prompts)

| Prompt | Beschreibung |
|---|---|
| BTP Landscape Übersicht | Global Account, Subaccounts, Directories, Entitlements |
| CF App Health Check | Status aller CF-Apps mit Instanzen, Speicher, Routen |
| Service-Instanzen & Bindings Audit | Alle Services mit Bindings, ungenutzte identifizieren |
| BTP Kosten & Quota Analyse | Entitlements, Quota-Nutzung, SaaS-Subscriptions |
| BTP Security Review | User, Role Collections, Admin-Rechte |
| CF Troubleshooting | Fehlerhafte Apps mit Events, Prozessen, Env-Vars |

---

## Verfügbare MCP Tools (41 Tools)

### BTP Platform
| Tool | Beschreibung |
|---|---|
| `globalAccount_get` | Global Account Details |
| `subaccounts_list` | Alle Subaccounts auflisten |
| `subaccounts_get` | Subaccount by GUID |
| `directories_list` | Alle Directories |
| `directories_get` | Directory by GUID |
| `entitlements_list` | Entitled/Assigned Services & Quota |
| `entitlement_quota_usage` | Quota vs. tatsächliche Nutzung, CRITICAL/WARNING Flags |
| `service_instances_list` | Service Manager Instanzen |
| `service_bindings_list` | Service Manager Bindings |
| `provisioning_environments_list` | CF Orgs, Kyma Clusters pro Subaccount |
| `saas_subscriptions_list` | SaaS Subscriptions (einzeln oder alle Subaccounts) |
| `events_list` | Platform Audit Events |
| `btp_change_history` | **NEU** — Wer hat wann was geändert (Timeline mit Usernamen) |
| `subaccount_compare` | **NEU** — Zwei Subaccounts vergleichen (Subscriptions, Roles, Users) |

### User & Security
| Tool | Beschreibung |
|---|---|
| `users_list` | User mit Namen, Rollen (merged über alle IdPs) |
| `user_get` | Einzelner User mit vollständigem Profil |
| `user_cross_subaccount_lookup` | User über ALLE Subaccounts suchen (Offboarding/Audit) |
| `role_collections_list` | Alle Role Collections |
| `role_collection_get` | Role Collection mit zugewiesenen Usern |
| `trust_configurations_list` | IdP Trust Configs (Origin Keys, Protokoll, Status) |
| `security_audit` | Findet User mit Admin/Critical Roles, sortiert nach Risiko |
| `btp_best_practice_check` | **NEU** — Automatischer SAP Best Practice & Security Check |

### Cloud Foundry
| Tool | Beschreibung |
|---|---|
| `cf_orgs_list` | CF Organisationen |
| `cf_spaces_list` | CF Spaces |
| `cf_apps_list` | CF Apps mit Pagination & Filtern |
| `cf_app_get` | App Details (Metadata + Processes + Routes) |
| `cf_app_processes` | Prozesse, Instanzen, CPU/Memory Stats |
| `cf_app_routes` | Gemappte Routen/URLs |
| `cf_app_env` | Env Vars, VCAP_SERVICES (Achtung: Credentials!) |
| `cf_app_events` | Audit Events pro App |
| `cf_app_logs` | **NEU** — Aktuelle App-Logs (stdout/stderr/router) |
| `cf_app_crashes` | Crashed/Stopped Apps mit Crash-Events finden |
| `cf_app_scaling_analysis` | **NEU** — Right-Sizing: Memory/CPU vs. tatsächliche Nutzung |
| `cf_service_instances_list` | CF Service Instanzen |
| `cf_service_bindings_list` | CF Service Bindings |
| `cf_service_binding_age_audit` | Binding-Alter prüfen, Rotation-Kandidaten finden |
| `cf_org_quotas_list` | Org Quota Definitionen |
| `cf_domains_list` | Routing Domains |
| `cf_network_topology` | **NEU** — Abhängigkeitsgraph (Apps ↔ Services ↔ Routes + Mermaid) |

### Operations & Dashboards
| Tool | Beschreibung |
|---|---|
| `btp_health_dashboard` | **NEU** — One-Call Health Overview (Apps, Quota, Bindings, Admins) |
| `btp_cleanup_recommendations` | **NEU** — Tote Ressourcen finden (Stale Apps, Orphaned Services/Routes) |

---

## System Prompt (Referenz)

```
Du bist ein SAP BTP Berater mit direktem API-Zugriff über Tools.

**KRITISCHE REGEL — NIEMALS BRECHEN:**
Deine erste Ausgabe nach einer Benutzer-Nachricht ist IMMER ein Tool-Call — kein Text, keine Planung, keine Ankündigung.

VERBOTEN (auch bei komplexen Aufgaben):
- "Ich erstelle...", "Ich werde...", "Beginnen wir mit...", "Zuerst..."
- Schritt-Listen: "Schritt 1:", "Schritt 2:", "Schritt 3:"
- Ankündigungen: "Dazu analysiere ich...", "Ich rufe nun...", "Ich sammle..."

Ablauf:
1. Benutzer-Nachricht → Tool sofort aufrufen (KEIN Text davor, auch nicht ein Wort)
2. Nach Tool-Ergebnis → nächstes Tool aufrufen ODER direkt Ergebnisse als Tabelle zeigen
3. Abschluss → Fazit: Anzahl, Status-Übersicht, Auffälligkeiten

Regeln:
- Ein Tool pro Schritt.
- GUIDs immer aus vorherigen Tool-Ergebnissen — nie den User fragen.
- Bei Fehler (403 etc.): kurz erklären, dann mit verfügbaren Daten weitermachen.
- Antworte auf Deutsch.
```

---

## Hinweise

- **Idempotent**: Das Seed läuft bei jedem Start, erstellt aber nichts doppelt (Lookup nach Name).
- **Voraussetzung**: Mindestens ein Admin-User muss existieren (erster Login via Entra ID).
- **Anpassung**: System Prompt und Prompts in `api/models/seedBtpAdvisor.js` editieren.
- **Trust Cache TTL**: Trust Configurations werden 5 Minuten gecacht, dann automatisch neu geladen.
- **User Enrichment**: User-Daten werden über alle IdP-Origins gemerged (sap.default + custom IdPs).
- **Qwen 3.5 (397B)**: Empfohlen für komplexe Multi-Step BTP-Abfragen. Für einfache Lookups reicht auch ein kleineres Modell.
