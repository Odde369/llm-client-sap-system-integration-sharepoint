# LibreChat Enterprise — SAP & M365 Integration

Unternehmensweite KI-Chat-Plattform auf Basis von [LibreChat](https://github.com/danny-avila/LibreChat), erweitert um SAP S/4HANA-Integration, Eclipse-Plugin und mehrere MCP-Server.

---

## Inhaltsverzeichnis

1. [Architekturübersicht](#architekturübersicht)
2. [Verzeichnisstruktur](#verzeichnisstruktur)
3. [Custom Docker Services](#custom-docker-services)
   - [SAP MCP Proxy](#sap-mcp-proxy)
   - [VSP MCP Server](#vsp-mcp-server)
   - [SAP Docs MCP](#sap-docs-mcp)
   - [BTP MCP Server](#btp-mcp-server)
   - [Ollama Proxy](#ollama-proxy)
   - [Sandpack Bundler](#sandpack-bundler)
4. [Eclipse Plugin](#eclipse-plugin)
   - [Installation](#installation)
   - [Funktionen](#funktionen)
   - [SAP-Kontext-Erkennung](#sap-kontext-erkennung)
   - [Architektur des Plugins](#architektur-des-plugins)
   - [Build](#build)
5. [Konfiguration](#konfiguration)
   - [Umgebungsvariablen](#umgebungsvariablen)
   - [systems.json (SAP-Systeme)](#systemsjson)
   - [librechat.enterprise.yaml](#librechatenterpriseyaml)
   - [docker-compose.override.yml](#docker-composeoverrideyml)
6. [Authentifizierung](#authentifizierung)
7. [Deployment](#deployment)
8. [Entwicklung](#entwicklung)

---

## Architekturübersicht

```
┌──────────────────────────────────────────────────────────────┐
│                       Benutzer                                │
│                                                              │
│   ┌─────────────┐         ┌──────────────────────────┐       │
│   │ Eclipse IDE  │         │ Browser (LibreChat UI)   │       │
│   │ + Plugin     │────────►│                          │       │
│   └─────────────┘         └──────────┬───────────────┘       │
└──────────────────────────────────────┼───────────────────────┘
                                       │
                                       ▼
                            ┌──────────────────┐
                            │  LibreChat API   │
                            │  (Node.js)       │
                            └────────┬─────────┘
                                     │ MCP Protocol
                    ┌────────────────┼────────────────┐
                    │                │                │
              ┌─────▼─────┐  ┌──────▼──────┐  ┌─────▼─────┐
              │ sap-multi  │  │   docs      │  │  btp-mcp  │
              │ (Proxy)    │  │ (SAP Docs)  │  │ (BTP Mgmt)│
              └─────┬──────┘  └─────────────┘  └───────────┘
                    │
          ┌────────┼────────┐
          │        │        │
       ┌──▼──┐ ┌──▼──┐ ┌──▼──┐
       │ vsp │ │ vsp │ │ vsp │    ← On-Demand pro SAP-System
       │ S4H │ │ AE1 │ │ ... │
       └──┬──┘ └──┬──┘ └──┬──┘
          │       │       │
       ┌──▼──┐ ┌──▼──┐ ┌──▼──┐
       │ SAP │ │ SAP │ │ SAP │    ← S/4HANA Systeme
       └─────┘ └─────┘ └─────┘
```

**Datenfluss:**

1. Benutzer öffnet LibreChat im Browser oder über das Eclipse-Plugin
2. Das Eclipse-Plugin erkennt automatisch das SAP-System aus dem aktiven ADT-Projekt
3. Der SAP-Kontext wird per URL-Parameter (`promptPrefix`, `agent_id`) übergeben
4. LibreChat leitet Tool-Aufrufe über MCP an den `sap-mcp-proxy` weiter
5. Der Proxy spawnt on-demand einen `vsp`-Prozess für das angeforderte System
6. `vsp` kommuniziert über RFC/HTTP mit dem SAP-System

---

## Verzeichnisstruktur

```
librechat/
├── api/                          # LibreChat Backend (nicht modifiziert)
├── client/                       # LibreChat Frontend (nicht modifiziert)
├── config/
│   └── librechat.enterprise.yaml # Enterprise-Konfiguration (MCP-Server, Endpoints, Auth)
├── docker/
│   ├── sap-mcp-proxy/            # Dynamischer Multi-System SAP Router
│   ├── vsp-mcp/                  # Einzelner VSP MCP-Server
│   ├── sap-docs-mcp/             # SAP-Dokumentationssuche
│   ├── btp-mcp/                  # SAP BTP Management
│   ├── ollama-proxy/             # Ollama Tool-Call-Normalisierung
│   └── sandpack-bundler/         # Lokaler Sandpack-Mirror
├── eclipse-plugin/               # Eclipse IDE Integration
│   ├── META-INF/MANIFEST.MF
│   ├── plugin.xml
│   ├── pom.xml
│   └── src/com/advades/librechat/
│       ├── Activator.java
│       ├── browser/              # JS-Bridge + Kontext-Injection
│       ├── context/              # SAP-Erkennung + Workspace-Scanning
│       ├── handlers/             # Command-Handler (Tastenkürzel)
│       ├── listeners/            # Editor-Wechsel-Listener
│       ├── preferences/          # Einstellungsseite
│       └── views/                # Haupt-View mit Browser
├── docker-compose.yml            # Standard LibreChat
├── docker-compose.override.yml   # Enterprise-Erweiterungen
├── .env                          # Umgebungsvariablen (nicht im Git)
└── .gitignore
```

---

## Custom Docker Services

### SAP MCP Proxy

**Verzeichnis:** `docker/sap-mcp-proxy/`
**Port:** 3140 (extern) → 3000 (intern)
**Zweck:** Zentraler Router für mehrere SAP-Systeme über ein einziges MCP-Interface.

Der Proxy löst das Problem, dass ohne ihn pro SAP-System ein eigener Docker-Container mit statischen Credentials benötigt würde. Stattdessen:

- **Ein Container** bedient alle SAP-Systeme
- **On-Demand Spawning:** `vsp`-Prozesse werden erst bei Bedarf gestartet
- **Idle-Timeout:** Ungenutzte Prozesse werden nach 10 Minuten beendet (konfigurierbar via `VSP_IDLE_TIMEOUT_MS`)
- **Hot-Reload:** Änderungen an `systems.json` werden alle 2 Sekunden erkannt — kein Container-Neustart nötig

**MCP-Tools:**

| Tool | Beschreibung |
|---|---|
| `sap_list_systems` | Zeigt alle konfigurierten SAP-Systeme |
| `sap_list_tools` | Listet verfügbare Tools eines Systems (spawnt vsp bei Bedarf) |
| `sap_execute` | Führt ein vsp-Tool auf einem bestimmten System aus |

**MCP-Ressource:**

| URI | Beschreibung |
|---|---|
| `sap://systems` | JSON-Liste aller Systeme |

**Dateien:**

| Datei | Zweck |
|---|---|
| `index.js` | MCP-Server, HTTP-Endpunkte (`/mcp`, `/health`), Tool-Definitionen |
| `vsp-pool.js` | Prozess-Pool: Spawn, Idle-Timer, Config-Reload, Cleanup |
| `systems.json` | Systemdefinitionen mit `${ENV_VAR}`-Expansion |
| `Dockerfile` | Multi-Stage Build: Go 1.24 (vsp-Binary) + Node 20 (Runtime) |

**Workflow (Browser-Benutzer):**

```
1. sap_list_systems aufrufen → zeigt verfügbare Systeme
2. sap_list_tools mit system="S4H_100" → zeigt Tools
3. sap_execute mit system="S4H_100", tool="read_abap_source", arguments={...}
```

**Workflow (Eclipse-Plugin):**

Der `system`-Parameter wird automatisch über `promptPrefix` vorgegeben — der Benutzer muss ihn nicht manuell angeben.

---

### VSP MCP Server

**Verzeichnis:** `docker/vsp-mcp/`
**Port:** 3130 (extern) → 3000 (intern)
**Zweck:** Einzelner [Vibing Steampunk](https://github.com/oisee/vibing-steampunk) MCP-Server für ein einzelnes SAP-System.

Wird als Fallback oder für einfache Single-System-Setups genutzt. Für Multi-System-Setups wird stattdessen der `sap-mcp-proxy` empfohlen.

---

### SAP Docs MCP

**Verzeichnis:** `docker/sap-docs-mcp/`
**Port:** 3124 (extern) → 3122 (intern)
**Zweck:** Durchsucht SAP-Dokumentation (online + lokal gecachte Inhalte) über MCP.

---

### BTP MCP Server

**Verzeichnis:** `docker/btp-mcp/`
**Port:** 4004
**Zweck:** SAP Business Technology Platform Management. Verwaltet:

- Global Accounts, Subaccounts, Directories
- Entitlements, SaaS Subscriptions
- Service Instances & Bindings
- Cloud Foundry: Orgs, Spaces, Apps, Routes, Processes, Env
- Events

Enthält einen eingebauten BTP Advisor mit System-Prompt (`BTP_ADVISOR_SYSTEM_PROMPT.md`).

---

### Ollama Proxy

**Verzeichnis:** `docker/ollama-proxy/`
**Port:** 4010
**Zweck:** Proxy zwischen LibreChat und Ollama, der Tool-Call-Formate normalisiert. Notwendig, da einige Ollama-Modelle Tool-Calls in nicht-standardkonformen Formaten zurückgeben.

---

### Sandpack Bundler

**Verzeichnis:** `docker/sandpack-bundler/`
**Port:** 3300
**Zweck:** Lokaler Mirror des CodeSandbox Sandpack Bundlers. Verhindert, dass die Artifact-Vorschau in LibreChat durch Corporate-Firewalls blockiert wird.

---

## Eclipse Plugin

### Installation

1. **Build:**
   ```bash
   cd eclipse-plugin
   mvn clean verify
   ```
   Erzeugt `target/com.advades.librechat-2.0.0-SNAPSHOT.jar`

2. **Installation in Eclipse:**
   - JAR nach `<eclipse>/dropins/` kopieren
   - Eclipse neu starten
   - View öffnen: `Window → Show View → Other → LibreChat`

### Funktionen

**Toolbar-Buttons:**

| Button | Tastenkürzel | Aktion |
|---|---|---|
| ↻ Reload | — | LibreChat im Browser neu laden |
| ＋ SAP Chat | Ctrl+Shift+N | Neuen Chat mit SAP-Kontext starten |
| ⇒ Selection | Ctrl+Shift+L | Markierten Code mit Kontext senden |
| ⇒ File | Ctrl+Shift+F | Aktuelle Datei mit Kontext senden |
| ↻ Refresh | Ctrl+Shift+R | SAP-Kontext manuell aktualisieren |

**Kontextmenü (Rechtsklick im Editor):**
- Send Selection to LibreChat
- Send Current File to LibreChat
- New SAP Chat

**Statusbar (unten in der View):**

Zeigt das aktuelle SAP-System und die aktive Datei an:
```
[S4H / Client 100] ZCL_HANDLER.clas.abap
```

### SAP-Kontext-Erkennung

Das Plugin erkennt automatisch das SAP-System des aktiven Projekts in 3 Stufen:

1. **Eclipse-Projekt-Nature:** Prüft ob `com.sap.adt.project.abap.nature` gesetzt ist
2. **ADT-API (Reflection):** Liest Destination-Name, SID, Client, Host über SAP ADT APIs (wenn installiert)
3. **Fallback:** Parst `.settings/com.sap.adt.destinations.prefs` direkt

Der Destination-Name (z.B. `S4H_100_DEV`) wird zerlegt in SID + Client:
```
Pattern: ^([A-Z][A-Z0-9]{2,3})_(\d{3})(?:_.*)?$
S4H_100_DEV → SID=S4H, Client=100
```

### Architektur des Plugins

```
com.advades.librechat
├── Activator                 Plugin-Lifecycle, LibreChat-URL aus Preferences
│
├── context/
│   ├── SapSystemInfo         Immutable Value Object (Builder Pattern)
│   ├── SapProjectContext     3-Stufen SAP-Erkennung (Nature → ADT → Datei)
│   ├── ContextManager        Singleton, PropertyChangeSupport, cacht System+Datei
│   └── WorkspaceScanner      Projektbaum, Datei-Inhalt, ABAP-Typ-Erkennung
│
├── browser/
│   ├── BrowserBridge         SWT Browser ↔ JavaScript Bridge
│   └── ContextInjector       Formatiert Code + SAP-Kontext als Markdown
│
├── handlers/
│   ├── AbstractLibreChatHandler  Template Method (null-safe View-Zugriff)
│   ├── SendSelectionHandler      Ctrl+Shift+L
│   ├── SendFileHandler           Ctrl+Shift+F
│   ├── NewSapChatHandler         Ctrl+Shift+N
│   └── RefreshContextHandler     Ctrl+Shift+R
│
├── listeners/
│   └── EditorPartListener    IPartListener2, delegiert an ContextManager
│
├── preferences/
│   ├── PreferenceConstants   URL, Agent-Mappings, Kontexttiefe, Auto-Kontext
│   ├── PreferenceInitializer Defaults
│   └── SapSystemPreferencePage  Einstellungs-UI
│
└── views/
    └── LibreChatView         ViewPart mit SWT.EDGE Browser, Toolbar, Statusbar
```

**Design Patterns:**
- **Builder Pattern:** `SapSystemInfo.Builder` für immutables Value Object
- **Template Method:** `AbstractLibreChatHandler.execute()` als finale Methode, Subklassen implementieren `doExecute()`
- **Observer:** `ContextManager` feuert `PropertyChangeEvent` bei System-/Datei-Wechsel
- **Singleton:** `ContextManager.getInstance()` als zentraler Zustandshalter

### Build

**Voraussetzungen:**
- Java 17+
- Maven 3.9+
- Eclipse 2024-12 Target Platform (wird automatisch heruntergeladen)

```bash
cd eclipse-plugin
mvn clean verify
```

Der Build verwendet [Eclipse Tycho](https://eclipse.dev/tycho/) 4.0.8 und unterstützt:
- Windows (win32/x86_64)
- Linux (gtk/x86_64)
- macOS (cocoa/x86_64)

---

## Konfiguration

### Umgebungsvariablen

Alle Variablen werden in `.env` definiert (nicht im Git).

**LibreChat Core:**

| Variable | Beschreibung |
|---|---|
| `CREDS_KEY` | Verschlüsselungsschlüssel für Credentials |
| `CREDS_IV` | Initialisierungsvektor |
| `JWT_SECRET` | JWT-Signaturschlüssel |
| `MONGO_URI` | MongoDB-Verbindungsstring |

**SAP-System (Legacy Single-System):**

| Variable | Beschreibung |
|---|---|
| `SAP_URL` | SAP-System URL |
| `SAP_CLIENT` | SAP-Mandant |
| `SAP_TECH_USER` | Technischer Benutzer |
| `SAP_TECH_PASSWORD` | Passwort |

**SAP Multi-System (pro System in systems.json):**

| Variable | Beschreibung |
|---|---|
| `SAP_USER_DEV` | Benutzer für System "DEV" |
| `SAP_PASSWORD_DEV` | Passwort für System "DEV" |
| `SAP_USER_S4H` | Benutzer für System "S4H" |
| `SAP_PASSWORD_S4H` | Passwort für System "S4H" |

**Authentifizierung:**

| Variable | Beschreibung |
|---|---|
| `OPENID_ISSUER` | Entra ID Issuer-URL |
| `OPENID_CLIENT_ID` | Application Client ID |
| `OPENID_CLIENT_SECRET` | Client Secret |
| `OPENID_CALLBACK_URL` | OAuth Callback URL |

### systems.json

Definiert die verfügbaren SAP-Systeme für den `sap-mcp-proxy`. Wird per Bind-Mount in den Container eingebunden und bei Änderungen automatisch neu geladen.

```json
{
  "systems": {
    "S4H_100": {
      "label": "S/4HANA Development",
      "url": "https://s4h.example.com:44300",
      "client": "100",
      "user": "${SAP_USER_S4H}",
      "password": "${SAP_PASSWORD_S4H}",
      "insecure": false,
      "readOnly": true,
      "mode": "focused"
    },
    "AE1_200": {
      "label": "ACME ERP",
      "url": "https://ae1.acme.corp:8043",
      "client": "200",
      "user": "${SAP_USER_AE1}",
      "password": "${SAP_PASSWORD_AE1}",
      "insecure": false,
      "readOnly": true,
      "mode": "focused"
    }
  }
}
```

**Felder:**

| Feld | Typ | Beschreibung |
|---|---|---|
| `label` | string | Anzeigename |
| `url` | string | SAP-System URL (mit Port) |
| `client` | string | SAP-Mandant |
| `user` | string | Benutzername (unterstützt `${ENV_VAR}`) |
| `password` | string | Passwort (unterstützt `${ENV_VAR}`) |
| `insecure` | boolean | TLS-Verifizierung deaktivieren |
| `readOnly` | boolean | Schreibzugriff unterbinden (default: true) |
| `mode` | string | VSP-Modus: `focused` oder `full` |
| `extraArgs` | string | Zusätzliche vsp CLI-Argumente |

### librechat.enterprise.yaml

Zentrale Konfiguration für MCP-Server, LLM-Endpoints und Authentifizierung.

```yaml
mcpServers:
  sap-multi:
    type: streamable-http
    url: "http://sap-mcp-proxy:3000/mcp"
    title: "SAP Multi-System"
    timeout: 3600000
    startupOptions:
      startup: false
    chatMenu: true
```

Die Datei registriert alle MCP-Server und deren Endpoints. Siehe `config/librechat.enterprise.yaml` für die vollständige Konfiguration.

### docker-compose.override.yml

Erweitert die Standard-`docker-compose.yml` um Enterprise-Services:

```yaml
services:
  sap-mcp-proxy:
    build:
      context: ./docker/sap-mcp-proxy
    ports:
      - "3140:3000"
    volumes:
      - ./docker/sap-mcp-proxy/systems.json:/app/systems.json
    env_file:
      - .env
```

Die `systems.json` wird als Bind-Mount eingebunden, damit Änderungen ohne Rebuild wirksam werden.

---

## Authentifizierung

LibreChat ist mit **Microsoft Entra ID (Azure AD)** als einziger Authentifizierungsmethode konfiguriert. Lokale Registrierung ist deaktiviert.

**Anpassungen am LibreChat-Code:**
- On-Behalf-Of (OBO) Token-Flow für durchgereichten Benutzerzugriff
- Session/Cookie-Bugfixes für Enterprise-Umgebungen

Details siehe [Authentifizierungs-Memory](../docs/auth-changes.md) (falls vorhanden) oder die Git-Historie.

---

## Deployment

### Voraussetzungen

- Docker & Docker Compose v2
- `.env`-Datei mit allen erforderlichen Variablen
- Netzwerkzugriff zu den SAP-Systemen

### Start

```bash
docker compose up -d
```

Die `docker-compose.override.yml` wird automatisch mit der Haupt-`docker-compose.yml` zusammengeführt.

### Neues SAP-System hinzufügen

1. `docker/sap-mcp-proxy/systems.json` bearbeiten — neues System hinzufügen
2. `.env` erweitern — `SAP_USER_XXX` und `SAP_PASSWORD_XXX` setzen
3. Fertig — der Proxy lädt die Änderungen automatisch (kein Neustart nötig)

### Eclipse-Plugin verteilen

```bash
cd eclipse-plugin
mvn clean verify
# JAR aus target/ an Benutzer verteilen
```

---

## Entwicklung

### Projektstruktur verstehen

- **Custom-Code** (von uns gepflegt): `docker/`, `eclipse-plugin/`, `config/`, `docker-compose.override.yml`
- **LibreChat-Code** (Upstream): `api/`, `client/`, `src/`, `packages/` — wird nur bei Auth-Patches modifiziert

### Code-Standards (Custom-Code)

- **Java (Eclipse Plugin):** Java 17, keine Wildcardimports, Builder Pattern für Immutables, Template Method für Handler
- **Node.js (MCP-Server):** ESM Modules, JSDoc-Typdefs, `??` statt `||` für Nullish, explizite Imports (`node:crypto`, `node:fs`)
- **Allgemein:** Keine zirkulären Abhängigkeiten, Dependency Injection über Funktionsparameter, optionale Abhängigkeiten via Reflection

### ESLint

Eclipse-Plugin-Dateien sind in `eslint.config.mjs` ignoriert:
```js
ignores: ['eclipse-plugin/**/*']
```

### Git-Konventionen

- Custom-Branches für Feature-Entwicklung
- Hauptbranch: `main`
- `.gitignore` enthält Eclipse-Build-Artefakte (`eclipse-plugin/target/`, `*.class`)
