# Einrichtungsanleitung — LibreChat Enterprise SAP

Schritt-für-Schritt-Anleitung zum vollständigen Einrichten des LibreChat Enterprise Templates mit SAP-Integration und Microsoft Entra ID.

---

## Inhaltsverzeichnis

1. [Voraussetzungen](#1-voraussetzungen)
2. [Repository klonen](#2-repository-klonen)
3. [Sicherheitsgeheimnisse generieren](#3-sicherheitsgeheimnisse-generieren)
4. [Entra ID App Registration](#4-entra-id-app-registration)
5. [.env konfigurieren](#5-env-konfigurieren)
6. [Docker Container bauen und starten](#6-docker-container-bauen-und-starten)
7. [Ersten Admin-Benutzer einrichten](#7-ersten-admin-benutzer-einrichten)
8. [Agents anlegen](#8-agents-anlegen)
9. [Eclipse Plugin installieren (optional)](#9-eclipse-plugin-installieren-optional)
10. [Verifizierung](#10-verifizierung)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Voraussetzungen

### Software

| Komponente | Mindestversion | Zweck |
|---|---|---|
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | 24+ (mit Compose v2) | Container-Runtime |
| [Git](https://git-scm.com/downloads) | beliebig | Repository klonen |
| [Ollama](https://ollama.com/download) | beliebig | Lokale LLM-Ausführung (nativ auf dem Host) |
| Java 17+ & Maven 3.9+ | — | Nur für Eclipse Plugin Build |

> **Hinweis zu Ollama:** Ollama muss **nativ auf dem Host** laufen, nicht in Docker. Der LibreChat-Container erreicht ihn über `host.docker.internal:11434`.

### Zugangsdaten und Tokens (vorab beschaffen)

| Bereich | Was wird benötigt |
|---|---|
| **Azure / Entra ID** | Zugriff auf das Azure Portal mit Berechtigung, App-Registrierungen zu erstellen |
| **SAP ABAP System** | URL, Mandant, Benutzername und Passwort eines technischen Lesebenutzers |
| **SAP BTP** | CIS Central Service-Binding (Client ID + Secret + Token-URL), BTP-User und Passwort |
| **Ollama Cloud** (optional) | API-Key von [ollama.com](https://ollama.com) |
| **Groq** (optional) | API-Key von [console.groq.com](https://console.groq.com) |

---

## 2. Repository klonen

```bash
git clone <repo-url>
cd librechat
```

Alle folgenden Schritte werden im Verzeichnis `librechat/` ausgeführt.

---

## 3. Sicherheitsgeheimnisse generieren

LibreChat benötigt mehrere kryptografische Schlüssel. Diese **einmalig** generieren und sicher aufbewahren:

```bash
# CREDS_KEY (32 Byte = 64 Hex-Zeichen)
openssl rand -hex 32

# CREDS_IV (16 Byte = 32 Hex-Zeichen)
openssl rand -hex 16

# JWT_SECRET
openssl rand -hex 32

# JWT_REFRESH_SECRET
openssl rand -hex 32

# OPENID_SESSION_SECRET (für Entra ID Session)
openssl rand -hex 32
```

Alternativ: Online-Generator unter https://www.librechat.ai/toolkit/creds_generator

Die Ausgaben werden in Schritt 5 in die `.env`-Datei eingetragen.

---

## 4. Entra ID App Registration

Die gesamte Authentifizierung läuft über Microsoft Entra ID (Azure AD). Lokale Registrierung ist deaktiviert.

### 4.1 Neue App-Registrierung anlegen

Im [Entra Admin Center](https://entra.microsoft.com/):

1. **Identity** → **Applications** → **App registrations** → **New registration**
2. Felder ausfüllen:
   - **Name:** z. B. `LibreChat (DEV)`
   - **Supported account types:** Single tenant (empfohlen)
   - **Redirect URI:** Platform `Web` → `http://localhost:3080/oauth/openid/callback`
3. **Register** klicken
4. Notieren: **Application (client) ID** und **Directory (tenant) ID**

### 4.2 Client Secret erstellen

App Registration → **Certificates & secrets** → **New client secret**:

1. Beschreibung und Ablaufdatum wählen
2. **Add** klicken
3. **Secret Value** sofort kopieren — er wird nur einmal angezeigt!

> **Häufiger Fehler:** Die "Secret ID" (UUID) statt dem "Secret Value" kopieren. Der Secret Value ist eine längere, zufällige Zeichenkette.

### 4.3 API exponieren (für Token-Flow)

App Registration → **Expose an API**:

1. **Set** neben "Application ID URI" klicken → Standard `api://<client-id>` bestätigen
2. **Add a scope**:
   - Scope name: `user_impersonation`
   - Who can consent: Admins and users
   - Admin consent display name: `Access LibreChat on behalf of the user`
   - State: **Enabled**
3. Unter **Authorized client applications** → **Add a client application**:
   - Client ID: dieselbe `<client-id>` wie oben
   - Scope `user_impersonation` anhaken

### 4.4 API-Berechtigungen vergeben

App Registration → **API permissions** → **Add a permission**:

| API | Typ | Berechtigung |
|---|---|---|
| Microsoft Graph | Delegated | `Files.Read.All` |
| Office 365 SharePoint Online | Delegated | `AllSites.Read` |

Danach: **Grant admin consent for \<tenant\>** klicken.

> SharePoint findet sich unter "APIs my organization uses" — nach "SharePoint" suchen.

### 4.5 Zusammenfassung der gesammelten Werte

Am Ende von Schritt 4 sollten folgende Werte vorliegen:

| Wert | Woher |
|---|---|
| `OPENID_CLIENT_ID` | Application (client) ID |
| `OPENID_CLIENT_SECRET` | Secret Value (aus 4.2) |
| `OPENID_ISSUER` | `https://login.microsoftonline.com/<tenant-id>/v2.0` |
| `OPENID_AUDIENCE` | `api://<client-id>` (Application ID URI aus 4.3) |

---

## 5. .env konfigurieren

Die `.env`-Datei enthält alle Credentials und Feature-Flags. Sie liegt im Projektverzeichnis und wird **nicht** in Git eingecheckt.

Datei öffnen und folgende Abschnitte befüllen:

### 5.1 Sicherheitsgeheimnisse (aus Schritt 3)

```env
CREDS_KEY=<32-Byte-Hex aus openssl rand -hex 32>
CREDS_IV=<16-Byte-Hex aus openssl rand -hex 16>
JWT_SECRET=<aus openssl rand -hex 32>
JWT_REFRESH_SECRET=<aus openssl rand -hex 32>
```

### 5.2 Domain

```env
DOMAIN_CLIENT=http://localhost:3080
DOMAIN_SERVER=http://localhost:3080
```

Für Produktivbetrieb mit eigenem Hostname anpassen, z. B.:
```env
DOMAIN_CLIENT=https://librechat.firma.de
DOMAIN_SERVER=https://librechat.firma.de
```

### 5.3 Entra ID Authentifizierung

```env
ALLOW_EMAIL_LOGIN=false
ALLOW_REGISTRATION=false
ALLOW_SOCIAL_LOGIN=true
ALLOW_SOCIAL_REGISTRATION=true

OPENID_CLIENT_ID=<Application client ID>
OPENID_CLIENT_SECRET=<Secret Value>
OPENID_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OPENID_SESSION_SECRET=<aus openssl rand -hex 32>
OPENID_CALLBACK_URL=/oauth/openid/callback
OPENID_REUSE_TOKENS=true
OPENID_AUDIENCE=api://<client-id>
OPENID_SCOPE="openid profile email offline_access api://<client-id>/user_impersonation"
```

### 5.4 SAP ABAP System (vsp-mcp)

```env
SAP_URL=https://<sap-host>:<port>
SAP_CLIENT=001
SAP_TECH_USER=<technischer-benutzer>
SAP_TECH_PASSWORD=<passwort>
SAP_INSECURE=true    # DEV-Systeme oft ohne gültiges TLS-Zertifikat
SAP_READ_ONLY=true
```

> `SAP_INSECURE=true` nur für DEV-Systeme verwenden. In Produktion TLS korrekt einrichten und auf `false` setzen.

### 5.5 SAP BTP (btp-mcp)

Die BTP-Credentials stammen aus einer **CIS Central Service-Binding** im BTP Cockpit:

```env
# CIS Central (Accounts, Entitlements, Events, Provisioning)
BTP_ACCOUNTS_SERVICE_BASE_URL=https://accounts-service.cfapps.<region>.hana.ondemand.com
BTP_ACCOUNTS_SERVICE_TOKEN_URL=https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token
BTP_ACCOUNTS_SERVICE_CLIENT_ID=sb-ut-<uuid>|cis-central!b14
BTP_ACCOUNTS_SERVICE_CLIENT_SECRET=<secret>

# BTP Benutzerdaten (für btp CLI-Fallback)
BTP_USER=<email@firma.de>
BTP_PASSWORD=<passwort>

# Service Manager (optional — für Service-Instanzen und Bindings)
BTP_SM_BASE_URL=https://service-manager.cfapps.<region>.hana.ondemand.com
BTP_SM_TOKEN_URL=https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token
BTP_SM_CLIENT_ID=sb-<uuid>|service-manager!b8989
BTP_SM_CLIENT_SECRET=<secret>

# Weitere BTP Service-URLs (werden aus ACCOUNTS_BASE_URL abgeleitet falls leer)
BTP_ENTITLEMENTS_SERVICE_BASE_URL=https://entitlements-service.cfapps.<region>.hana.ondemand.com
BTP_EVENTS_SERVICE_BASE_URL=https://events-service.cfapps.<region>.hana.ondemand.com
BTP_PROVISIONING_SERVICE_BASE_URL=https://provisioning-service.cfapps.<region>.hana.ondemand.com
BTP_SAAS_REGISTRY_BASE_URL=https://saas-manager.cfapps.<region>.hana.ondemand.com
```

**Wo finde ich die CIS-Credentials?**

1. BTP Cockpit → Global Account → Subaccount → **Service Instances**
2. Instanz vom Typ `cis` (Central Instance Service) öffnen
3. **Service Keys / Bindings** → Key anzeigen → JSON-Inhalte kopieren:
   - `uaa.clientid` → `BTP_ACCOUNTS_SERVICE_CLIENT_ID`
   - `uaa.clientsecret` → `BTP_ACCOUNTS_SERVICE_CLIENT_SECRET`
   - `uaa.url` + `/oauth/token` → `BTP_ACCOUNTS_SERVICE_TOKEN_URL`
   - `url` → `BTP_ACCOUNTS_SERVICE_BASE_URL`

### 5.6 LLM Endpoints

```env
# Aktivierte Endpoints (Komma-getrennt)
# "custom" = nur die in librechat.enterprise.yaml definierten Endpoints (Ollama, Groq, Ollama Cloud)
ENDPOINTS=custom,groq

# Ollama Cloud (optional — für Cloud-Modelle wie qwen3.5, deepseek)
OLLAMA_CLOUD_API_KEY=<api-key von ollama.com>

# Groq (optional — für schnelle Inference)
GROQ_API_KEY=<api-key von console.groq.com>
```

> Ollama lokal benötigt keinen API-Key — es läuft nativ auf dem Host und ist unter `host.docker.internal:11434` erreichbar.

---

## 6. Docker Container bauen und starten

### 6.1 Erstes Starten (alle Images bauen)

```bash
docker compose up -d --build
```

Dieser Befehl:
- Liest `docker-compose.yml` + `docker-compose.override.yml` (automatische Zusammenführung)
- Baut lokal: `api`, `btp-mcp`, `vsp-mcp`, `sap-docs-mcp`, `sap-mcp-proxy`, `ollama-proxy`, `sandpack-bundler`
- Startet alle Container im Hintergrund

Der erste Build dauert mehrere Minuten (Go-Kompilierung, npm install, SAP-Docs-Index).

### 6.2 Startvorgang verfolgen

```bash
# Alle Container-Status prüfen
docker compose ps

# LibreChat API-Logs beobachten
docker compose logs -f api

# Kurze Statusübersicht aller Container
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
```

Der API-Container ist bereit, wenn in den Logs erscheint:
```
LibreChat listening on port 3080
```

### 6.3 Erreichbare Dienste nach dem Start

| Dienst | URL |
|---|---|
| LibreChat UI | http://localhost:3080 |
| SAP Docs MCP (Health) | http://localhost:3124/health |
| VSP MCP (SAP ABAP) | http://localhost:3130/health |
| BTP MCP (Health) | http://localhost:4004/health |
| Ollama Proxy | http://localhost:4010 |
| Sandpack Bundler | http://localhost:3300 |

### 6.4 Häufige Befehle im Betrieb

| Befehl | Zweck |
|---|---|
| `docker compose up -d --build` | Alles starten / neu bauen |
| `docker compose down` | Alle Container stoppen |
| `docker compose restart api` | Nur API neu starten (z. B. nach .env-Änderung) |
| `docker compose build btp-mcp && docker compose up -d btp-mcp` | Einzelnen MCP-Server neu bauen und starten |
| `docker compose logs -f <service>` | Live-Logs eines Containers |
| `docker compose ps` | Status aller Container |

### 6.5 Updates einspielen

```bash
docker compose down
git pull
docker compose up -d --build
```

---

## 7. Ersten Admin-Benutzer einrichten

1. http://localhost:3080 aufrufen
2. Auf **"Mit Microsoft anmelden"** klicken
3. Entra ID-Login durchführen (erster eingeloggter Benutzer wird automatisch Admin)
4. Nach erfolgreichem Login erscheint die LibreChat-Oberfläche

> Falls der Login-Button fehlt oder eine Fehlermeldung erscheint, Abschnitt [Troubleshooting](#11-troubleshooting) konsultieren.

---

## 8. Agents anlegen

Agents bündeln MCP-Tools in kontrollierten Workflows. Der Agent Builder ist standardmäßig für alle Nutzer sichtbar — nach dem Anlegen der Agents kann er für normale Nutzer gesperrt werden.

### 8.1 Agent: SAP Dokumentation

1. LibreChat öffnen → **Agents** → **Create Agent**
2. Konfiguration:
   - **Name:** `SAP Docs`
   - **Model:** Bevorzugtes Modell wählen
   - **MCP Server:** `docs` aktivieren
   - Alle Tools des `docs`-Servers aktivieren
3. **Save** klicken

### 8.2 Agent: SAP ABAP Entwicklung

1. **Create Agent**
2. Konfiguration:
   - **Name:** `SAP DEV Read`
   - **Model:** Bevorzugtes Modell wählen
   - **MCP Server:** `sap` aktivieren
   - Nur folgende Tools aktivieren (Lesezugriff):

| Tool | Beschreibung |
|---|---|
| `GetSource` | ABAP-Quellcode lesen |
| `SearchObject`, `GrepObjects`, `GrepPackages` | Objekte suchen |
| `GetPackage`, `GetFunctionGroup` | Paket-/Funktionsgruppen-Info |
| `GetTable`, `GetTableContents` | Tabellendefinition und Inhalt |
| `GetCDSDependencies` | CDS-Abhängigkeiten |
| `GetSystemInfo`, `GetInstalledComponents` | Systeminformationen |
| `GetCallGraph`, `GetObjectStructure` | Aufrufhierarchie |
| `GetDumps`, `GetDump` | Dumps/Short Dumps lesen |
| `ListTraces`, `GetTrace` | Performance Traces |
| `GetSQLTraceState`, `ListSQLTraces` | SQL-Traces |

> **Nicht aktivieren:** `RunQuery`, alle Schreib-/Edit-/Import-/Export-Tools, `ExecuteABAP`, Transport/CTS-Tools.

3. **Save** klicken

### 8.3 Agent: SAP BTP Management

1. **Create Agent**
2. Konfiguration:
   - **Name:** `BTP Advisor`
   - **Model:** Bevorzugtes Modell wählen
   - **MCP Server:** `btp-mcp` aktivieren
   - Alle Tools aktivieren (oder einschränken nach Bedarf)
3. **Save** klicken

### 8.4 Agent Builder für normale Nutzer sperren (optional)

Nach dem Anlegen aller Agents in `config/librechat.enterprise.yaml`:

```yaml
endpoints:
  agents:
    disableBuilder: true    # Agents-Builder für normale Nutzer sperren
```

Dann:
```bash
docker compose restart api
```

---

## 9. Eclipse Plugin installieren (optional)

Das Eclipse Plugin ermöglicht die direkte Integration von LibreChat in die Eclipse IDE mit automatischer SAP-Kontexterkennung.

### 9.1 Plugin bauen

```bash
cd eclipse-plugin
mvn clean verify
```

Das JAR wird erstellt unter: `eclipse-plugin/target/com.advades.librechat-2.0.0-SNAPSHOT.jar`

### 9.2 Plugin in Eclipse installieren

1. JAR-Datei kopieren nach `<eclipse-verzeichnis>/dropins/`
2. Eclipse neu starten
3. View öffnen: **Window** → **Show View** → **Other** → **LibreChat**

### 9.3 Plugin konfigurieren

**Window** → **Preferences** → **LibreChat**:

- **LibreChat URL:** z. B. `http://localhost:3080`
- **Auto-Kontext:** SAP-System automatisch aus aktivem Projekt erkennen
- **Kontexttiefe:** Wie viele Verzeichnisebenen des Projekts werden gescannt (Standard: 3)

### 9.4 Tastenkürzel

| Tastenkürzel | Aktion |
|---|---|
| `Ctrl+Shift+N` | Neuen SAP Chat mit Systemkontext starten |
| `Ctrl+Shift+L` | Markierten Code mit Kontext senden |
| `Ctrl+Shift+F` | Aktuelle Datei mit Kontext senden |
| `Ctrl+Shift+R` | SAP-Kontext manuell aktualisieren |

### 9.5 SAP-Kontext-Erkennung

Das Plugin erkennt automatisch das SAP-System des aktiven ADT-Projekts:

1. Eclipse-Projekt-Nature prüfen (`com.sap.adt.project.abap.nature`)
2. ADT-API auslesen (wenn SAP ADT installiert)
3. Fallback: `.settings/com.sap.adt.destinations.prefs` parsen

Die Statusbar der View zeigt das erkannte System an:
```
[S4H / Client 100] ZCL_HANDLER.clas.abap — Paket: ZPACKAGE
```

---

## 10. Verifizierung

Nach dem Setup folgende Punkte prüfen:

### 10.1 Container-Status

```bash
docker compose ps
```

Alle Container sollten den Status `running` oder `healthy` haben. `vsp-mcp` kann beim Start mehrere Sekunden in Restart-Schleifen sein, bis die DNS-Auflösung des SAP-Hosts klappt (normal, wenn VPN nicht sofort aktiv ist).

### 10.2 Health-Checks

```bash
curl http://localhost:4004/health    # BTP MCP
curl http://localhost:3124/health    # SAP Docs MCP
```

Beide sollten `{"status":"ok"}` oder ähnliches zurückgeben.

### 10.3 UI-Checks

- [ ] Login-Seite zeigt nur "Mit Microsoft anmelden" (kein Email/Passwort-Formular)
- [ ] Nach Login erscheint die Chat-Oberfläche
- [ ] Im Chat-Menü (MCP-Symbol) sind `docs`, `sap` und `btp-mcp` sichtbar
- [ ] Agents `SAP Docs`, `SAP DEV Read`, `BTP Advisor` sind auswählbar
- [ ] Ein Test-Tool-Call liefert Ergebnisse (z. B. "GetSystemInfo" im SAP DEV Agent)

### 10.4 Entra ID Checks

| Was prüfen | Erwartetes Ergebnis |
|---|---|
| Login mit Entra-Account | Weiterleitung zu LibreChat |
| Login mit falschem Account | Fehler / kein Zugriff |
| `OPENID_REUSE_TOKENS=true` in .env | Vorhanden |
| `OPENID_AUDIENCE` gesetzt | `api://<client-id>` |

---

## 11. Troubleshooting

### Container startet nicht

```bash
docker compose logs <service-name> --tail 50
```

Häufige Ursachen:

| Symptom | Ursache | Lösung |
|---|---|---|
| `Could not resolve SAP host` | VPN nicht aktiv oder DNS fehlt | VPN verbinden, dann `docker compose restart vsp-mcp` |
| `btp-mcp health check failing` | Falsche BTP-Credentials | `BTP_ACCOUNTS_SERVICE_*` in `.env` prüfen |
| `api` startet nicht | Abhängiger Container nicht healthy | `docker compose ps` prüfen, failing Container reparieren |
| Secrets fehlen | CREDS_KEY/IV oder JWT-Secrets nicht gesetzt | Schritt 3 wiederholen und in `.env` eintragen |

### Login schlägt fehl

| Fehlermeldung | Ursache | Lösung |
|---|---|---|
| `AADSTS50013` | Falsches Token-Audience | `OPENID_AUDIENCE=api://<client-id>` setzen, "Expose an API" prüfen |
| `AADSTS65001` | Admin Consent fehlt | Im Azure Portal Admin Consent erteilen (Schritt 4.4) |
| `AADSTS50011` | Redirect URI falsch | `DOMAIN_SERVER` und Entra Redirect URI müssen exakt übereinstimmen |
| Leere Seite nach Login | API Image nicht lokal gebaut | `docker compose build api && docker compose up -d api` |
| `JWT timestamp claim failed` | Veraltete Browser-Session | Browser-Cookies löschen oder Inkognito-Modus |

### SAP-Verbindung funktioniert nicht

```bash
docker logs vsp-mcp --tail 30
```

- `Could not resolve SAP host: <host>` → DNS-Problem, VPN prüfen
- Verbindung baut sich auf, Tool-Calls schlagen fehl → Benutzerberechtigungen im SAP-System prüfen
- HTTP 401 → `SAP_TECH_USER` / `SAP_TECH_PASSWORD` falsch

### BTP-Tools liefern keine Daten

```bash
docker logs btp-mcp --tail 30
```

- `401 Unauthorized` → CIS-Service-Binding-Credentials prüfen
- `Token URL not configured` → `BTP_ACCOUNTS_SERVICE_TOKEN_URL` in `.env` setzen
- Leere Subaccount-Liste → `BTP_GLOBAL_ACCOUNT_SUBDOMAIN` prüfen (muss die technische Subdomain sein, nicht der Anzeigename)

### .env-Änderungen wirken nicht

Nach jeder `.env`-Änderung Container neu starten:

```bash
# Nur API (für die meisten Einstellungen)
docker compose restart api

# MCP-Server (wenn BTP/SAP-Credentials geändert)
docker compose up -d --force-recreate btp-mcp vsp-mcp
```

---

## Anhang: Übersicht aller Ports

| Port | Dienst | Intern |
|---|---|---|
| 3080 | LibreChat UI + API | — |
| 3124 | SAP Docs MCP | 3122 |
| 3130 | VSP MCP (SAP ABAP) | 3000 |
| 3140 | SAP MCP Proxy (deaktiviert) | 3000 |
| 3300 | Sandpack Bundler | 3300 |
| 4004 | BTP MCP | 4004 |
| 4010 | Ollama Proxy | 4010 |

## Anhang: Konfigurationsdateien im Überblick

| Datei | Zweck | Im Git |
|---|---|---|
| `.env` | Credentials und Feature-Flags | **Nein** |
| `config/librechat.enterprise.yaml` | MCP-Server, Endpoints, Interface-Einstellungen | Ja |
| `docker-compose.override.yml` | Enterprise-Services, Build-Konfiguration | Ja |
| `docker/sap-mcp-proxy/systems.json` | SAP-Systeme für Multi-System-Proxy | Ja |
