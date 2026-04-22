# BTP Advisor — System-Prompt & Predefined Prompts

## System-Prompt (kurz — in den Agent Builder eintragen)

```
Du bist ein SAP BTP Berater mit direktem API-Zugriff über die bereitgestellten Tools.

Regeln:
- Rufe das erste Tool SOFORT auf — keine Einleitung, kein "Ich werde jetzt...".
- Ein Tool pro Schritt. GUIDs aus vorherigen Ergebnissen holen, nie den User fragen.
- Ergebnisse immer als Tabelle oder strukturierte Liste.
- Nach allen Tool-Calls: Fazit mit Anzahl, Status-Übersicht und Auffälligkeiten.
- Bei Fehler (403 etc.): kurz erklären, dann mit verfügbaren Daten weitermachen.
- Antworte auf Deutsch.
- Bei React Artifacts: KEIN `const RAW = {komplette_api_ausgabe}`. Extrahiere nur die nötigen Metriken als kleine JS-Konstanten.
```

---

## Predefined Prompts (Conversation Starters im Agent Builder)

Jeder Prompt kann 1:1 als Conversation Starter eingetragen werden.

---

### 🏢 Account & Landscape

**1. Global Account**
```
Zeige den Global Account: Name, GUID, Status, Lizenztyp, kommerzielle Modell und Contract Status.
```

**2. Alle Subaccounts**
```
Liste alle Subaccounts als Tabelle: Name, State, Region, Subdomain, Beta-aktiviert, Produktiv (ja/nein). Zeige die Gesamtanzahl am Anfang.
```

**3. Directories**
```
Liste alle Directories (Verzeichnisse) im Global Account: Name, State, GUID. Falls kein Zugriff, erkläre warum.
```

**4. Vollständige Landscape-Übersicht**
```
Zeige die vollständige BTP-Landscape: zuerst Global Account, dann alle Subaccounts, dann alle Directories. Fasse am Ende zusammen: Anzahl Subaccounts, Anzahl aktiver Subaccounts, Regionen.
```

**5. Subaccount-Details**
```
Zeige Details zu allen Subaccounts einzeln: Name, GUID, Region, State, Subdomain, betaEnabled, usedForProduction, createdBy, createdDate.
```

---

### ☁️ Cloud Foundry — Apps

**6. Alle laufenden CF-Apps**
```
Zeige alle CF-Apps mit State=STARTED als Tabelle: App-Name, State, Instances (laufend/gesamt), Memory, Org, Space. Zeige Gesamtanzahl am Anfang.
```

**7. Alle CF-Apps (alle States)**
```
Zeige alle CF-Apps unabhängig vom State als Tabelle: App-Name, State, Instances, Memory, Org, Space. Gruppiere nach State (STARTED, STOPPED, CRASHED).
```

**8. Gestoppte oder abgestürzte Apps**
```
Zeige alle CF-Apps die NICHT im State STARTED sind: App-Name, State, Org, Space. Das sind potenzielle Probleme.
```

**9. App-Details (nach Name suchen)**
```
Suche die CF-App "[APP-NAME]" und zeige alle Details: State, Instances, Memory-Limit, Disk-Limit, Stack, Buildpack, Routes, created_at, updated_at.
Ersetze [APP-NAME] mit dem echten App-Namen.
```

**10. App-Prozesse & Health**
```
Zeige die Prozesse der CF-App "[APP-NAME]": Prozesstyp, Instances (laufend/gesamt), Memory, Disk, Health-Check-Typ.
Ersetze [APP-NAME] mit dem echten App-Namen.
```

**11. App-Routes**
```
Zeige alle Routes der CF-App "[APP-NAME]": Host, Domain, Path, vollständige URL.
Ersetze [APP-NAME] mit dem echten App-Namen.
```

**12. App-Umgebungsvariablen**
```
Zeige die Umgebungsvariablen der CF-App "[APP-NAME]". Sensible Werte (Passwörter, Tokens) zensieren mit "***".
Ersetze [APP-NAME] mit dem echten App-Namen.
```

**13. App-Events (letzte Ereignisse)**
```
Zeige die letzten Events der CF-App "[APP-NAME]": Typ, Actor, Zeitstempel, Beschreibung. Sortiert nach Zeit absteigend.
Ersetze [APP-NAME] mit dem echten App-Namen.
```

**14. App-Absturzanalyse**
```
Analysiere warum die CF-App "[APP-NAME]" Probleme hat: Rufe cf_apps_list auf um den State zu prüfen, dann cf_app_processes für Health-Details, dann cf_app_events für die letzten Ereignisse. Fasse die Ursache zusammen.
Ersetze [APP-NAME] mit dem echten App-Namen.
```

---

### ☁️ Cloud Foundry — Infrastruktur

**15. CF-Orgs**
```
Liste alle CF-Organisationen: Name, GUID, Status, Quota-Plan.
```

**16. CF-Spaces (alle Orgs)**
```
Liste alle CF-Spaces über alle Orgs: Space-Name, Org-Name, Quota (falls gesetzt).
```

**17. CF-Org-Quotas (Memory-Limits)**
```
Zeige alle CF-Org-Quota-Pläne: Name, Memory-Limit (MB/GB), App-Instance-Limit, Routes-Limit, Services-Limit.
```

**18. CF-Domains**
```
Liste alle CF-Domains: Name, Typ (shared/private), Org (falls private).
```

**19. CF-Service-Instances (CF API)**
```
Liste alle CF-Service-Instances über alle Spaces: Name, Service, Plan, Space, Org, State.
```

**20. CF-Service-Bindings (CF API)**
```
Zeige alle CF-Service-Bindings: App-Name, Service-Instance, Space, Org.
```

---

### 🎫 Entitlements & Services

**21. Entitlements-Übersicht**
```
Zeige alle Entitlements des Global Accounts: Service-Name, Plan, zugewiesene Menge (assigned), verfügbare Menge. Zeige Gesamtanzahl der enthaltenen Services.
```

**22. Entitlements nur zugewiesene**
```
Zeige nur die Entitlements die aktiv in Subaccounts zugewiesen sind (assignedOnly=true): Service-Name, Plan, Subaccount, zugewiesene Menge.
```

**23. Service-Instances (Service Manager)**
```
Liste alle Service Manager Instanzen: Name, Service, Plan, Subaccount, State, created_at.
```

**24. Service-Bindings (Service Manager)**
```
Liste alle Service Manager Bindings: Name, zugehörige Service-Instance, State, created_at.
```

**25. Provisioning-Environments**
```
Zeige die Provisioning-Environments für alle Subaccounts: Subaccount, Environment-Typ (Cloud Foundry, Kyma, ...), State. Rufe zuerst subaccounts_list auf, dann für jeden Subaccount provisioning_environments_list.
```

---

### 📦 SaaS Subscriptions

**26. Alle SaaS-Subscriptions**
```
Zeige alle SaaS-Subscriptions über alle Subaccounts als Tabelle: App-Name, Plan, State, Subaccount, Tenant-URL. Rufe zuerst subaccounts_list auf, dann für jeden Subaccount saas_subscriptions_list. Zeige nur SUBSCRIBED-Einträge. Gesamtanzahl am Anfang.
```

**27. SaaS-Subscriptions nach App filtern**
```
In welchen Subaccounts ist "[SAAS-APP-NAME]" subscribed? Zeige Subaccount, Plan, State und URL.
Ersetze [SAAS-APP-NAME] z.B. mit "SAP Build Work Zone", "SAP Integration Suite" etc.
```

**28. Alle SaaS inkl. nicht-subscribed**
```
Zeige alle verfügbaren SaaS-Apps pro Subaccount, auch die nicht-subscribten: App-Name, State, Subaccount. Gruppiere nach State.
```

---

### 🔐 Security & User-Management

**29. User im Global Account**
```
Zeige alle User im Global Account: E-Mail / User-ID, Origin (IDP), Rolle. Gesamtanzahl am Anfang.
```

**30. User in einem Subaccount**
```
Zeige alle User im Subaccount "[SUBACCOUNT-NAME]": E-Mail, Origin, Rollen. Rufe zuerst subaccounts_list auf um die GUID zu holen.
Ersetze [SUBACCOUNT-NAME] mit dem echten Namen.
```

**31. Role Collections (Global Account)**
```
Zeige alle Role Collections im Global Account: Name, Beschreibung, enthaltene Rollen.
```

**32. Role Collections in einem Subaccount**
```
Zeige alle Role Collections im Subaccount "[SUBACCOUNT-NAME]": Name, Beschreibung, zugewiesene User. Rufe zuerst subaccounts_list auf.
Ersetze [SUBACCOUNT-NAME] mit dem echten Namen.
```

---

### 📋 Events & Monitoring

**33. Aktuelle BTP-Events**
```
Zeige die letzten BTP-Audit-Events: Typ, Actor, betroffenes Objekt, Zeitstempel. Sortiert nach Zeit (neueste zuerst). Maximum 50 Events.
```

**34. Events nach Typ filtern**
```
Zeige alle BTP-Events vom Typ "[EVENT-TYP]" (z.B. "Subaccount", "Entitlement", "RoleCollection"): Actor, Objekt, Zeitstempel.
Ersetze [EVENT-TYP] mit dem gesuchten Typ.
```

---

### 📊 Composite-Analysen

**35. Vollständiger Landscape-Report**
```
Erstelle einen vollständigen BTP-Landscape-Report:
1. Global Account (Name, Status, Lizenz)
2. Alle Subaccounts (Tabelle: Name, State, Region)
3. CF-Orgs und ihre Quotas
4. Alle laufenden CF-Apps (Tabelle: App, Org, Space, Instances)
5. Fazit: Gesamtübersicht mit Kennzahlen

Rufe die Tools nacheinander auf: globalAccount_get → subaccounts_list → cf_orgs_list → cf_org_quotas_list → cf_apps_list(state=STARTED)
```

**36. Health-Check aller CF-Apps**
```
Führe einen Health-Check aller CF-Apps durch:
- Wie viele Apps laufen (STARTED)?
- Wie viele sind gestoppt oder abgestürzt?
- Zeige alle nicht-STARTED Apps als Problemliste mit Org und Space.
Rufe cf_apps_list ohne Filter auf.
```

**37. SaaS-Übersicht über alle Subaccounts**
```
Erstelle eine Übersicht aller SaaS-Subscriptions über alle Subaccounts:
- Welche SaaS-Apps sind wo subscribed?
- Tabelle: SaaS-App | Plan | Subaccount | URL
- Fazit: Wie viele unique SaaS-Apps, in wie vielen Subaccounts.
Rufe subaccounts_list auf, dann saas_subscriptions_list für jeden Subaccount.
```

**38. Vollständiger Security-Report**
```
Erstelle einen Security-Report:
1. Alle User im Global Account (users_list)
2. Alle Role Collections im Global Account (role_collections_list)
3. Fazit: Anzahl User, Anzahl Role Collections, Auffälligkeiten.
```

**39. Service-Inventory**
```
Erstelle ein vollständiges Service-Inventory:
1. Entitlements (was ist lizenziert): entitlements_list
2. Service Manager Instanzen (was ist provisioniert): service_instances_list
3. CF Service Instances (was ist in CF): cf_service_instances_list
Fazit: Wie viele Services entitelt vs. provisioniert.
```

**40. Subaccount-Deep-Dive**
```
Erstelle einen Deep-Dive für den Subaccount "[SUBACCOUNT-NAME]":
1. Subaccount-Details (subaccounts_list → GUID holen)
2. Provisioning-Environments (provisioning_environments_list)
3. SaaS-Subscriptions (saas_subscriptions_list)
4. User (users_list mit subaccountGUID)
5. Role Collections (role_collections_list mit subaccountGUID)
Ersetze [SUBACCOUNT-NAME] mit dem echten Namen.
```

---

## Empfohlene Agent-Einstellungen

| Einstellung | Wert |
|---|---|
| Name | BTP Advisor |
| Modell | deepseek-v3.1:671b-cloud (Ollama Cloud) |
| MCP Server | btp-mcp ✅ |
| Artifacts | aus |
| Code Interpreter | aus |
| Conversation Starters | Prompts 1–40 (oder Auswahl der häufigsten) |

> **Tipp**: Für den täglichen Einsatz empfiehlt sich eine Auswahl der 8–10 häufigsten Prompts als Conversation Starters. Die vollständige Liste kann als Referenz verwendet werden.
