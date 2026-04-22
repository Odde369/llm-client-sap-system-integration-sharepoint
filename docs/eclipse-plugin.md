# Eclipse IDE Plugin

**Plugin ID:** `com.advades.librechat`
**Version:** `2.0.0-SNAPSHOT`
**Source:** `eclipse-plugin/`
**Target Platform:** Eclipse 2024-12 (4.34), Java 17, ABAP Development Tools (ADT)

Embeds LibreChat directly into the Eclipse IDE as a browser panel. Automatically detects the current SAP project context and injects it into conversations, allowing ABAP developers to query the AI about code they are actively editing.

---

## Features

- Embedded LibreChat browser panel inside Eclipse
- Automatic SAP system context detection (from ADT project settings)
- Send selected code or entire file to LibreChat with SAP context pre-loaded
- Start a new conversation scoped to the current SAP system
- Keyboard shortcuts for quick interaction
- Workspace-wide scanning for SAP project connections

---

## Commands & Keyboard Shortcuts

| Command | Shortcut | Description |
|---------|----------|-------------|
| `sendSelection` | `Ctrl+Alt+L` | Send selected code + SAP context to LibreChat |
| `sendFile` | `Ctrl+Alt+Shift+L` | Send the entire active file + SAP context |
| `newSapChat` | — | Start a new conversation with full SAP system context |
| `refreshContext` | — | Force re-detection of the current SAP system |

---

## Architecture

```
Eclipse IDE
  ├── LibreChatView           (browser panel, embedded SWT Browser)
  ├── BrowserBridge           (Java ↔ JavaScript communication)
  ├── ContextManager          (detects active SAP system from workspace)
  │     ├── WorkspaceScanner  (scans open projects for SAP connections)
  │     ├── SapProjectContext (url, client, user, password per project)
  │     └── SapSystemInfo     (system metadata extraction)
  └── EditorPartListener      (monitors active editor → triggers context update)
```

### Handlers

| Handler | Triggered By |
|---------|-------------|
| `AbstractLibreChatHandler` | Base class |
| `SendSelectionHandler` | `Ctrl+Alt+L` |
| `SendFileHandler` | `Ctrl+Alt+Shift+L` |
| `NewSapChatHandler` | `newSapChat` command |
| `RefreshContextHandler` | `refreshContext` command |

---

## WorkspaceScanner

**File:** `eclipse-plugin/src/com/advades/librechat/context/WorkspaceScanner.java`

| Method | Description |
|--------|-------------|
| `scanProjectTree(IProject, maxDepth)` | Builds a compact ASCII tree of the project structure (max 100 entries, max 3 levels deep). Filters hidden files and build artifacts. |
| `getCurrentFile(IEditorPart)` | Returns the full content + path + language of the active editor. Falls back to filesystem read if document provider is unavailable. |
| `getSelectedText(IEditorPart)` | Returns currently selected text, or `null` if nothing is selected. |

### Recognized ABAP File Types

The scanner maps ADT file extensions to human-readable type names (ordered longest-match-first):

| Extension | Type |
|-----------|------|
| `.clas.testclasses.abap` | Test Class |
| `.clas.abap` | Class |
| `.intf.abap` | Interface |
| `.prog.abap` | Program |
| `.tabl.abap` | Table |
| `.ddls.asddls` / `.ddls.abap` | CDS View |
| `.srvd.abap` | Service Definition |
| `.bdef.abap` | Behavior Definition |
| `.fugr.abap` | Function Group |
| `.msag.abap` | Message Class |
| `.tran.abap` | Transaction |

### Language Detection (for syntax highlighting)

Maps extensions to highlight IDs: `abap`, `xml`, `json`, `javascript`, `typescript`, `java`, `python`, `html`, `css`, `yaml`.

---

## Building the Plugin

Requirements: Maven 3.x, Java 17, internet access (downloads Eclipse p2 dependencies).

```bash
cd eclipse-plugin
mvn clean package -P!default-tools.jar
```

Output: `eclipse-plugin/target/com.advades.librechat_2.0.0-SNAPSHOT.jar`

Install the JAR in Eclipse via **Help → Install New Software** or place it in the Eclipse `dropins/` directory.

---

## Plugin Preferences

Configurable via **Eclipse → Preferences → LibreChat**:

| Setting | Description |
|---------|-------------|
| LibreChat URL | URL of the LibreChat instance (default: `http://localhost:3080`) |
| SAP User | Default technical user for ABAP access |
| SAP Password | Password (stored in Eclipse secure storage) |
| Request Timeout | HTTP timeout in milliseconds |

---

## Integration with sap-mcp-proxy

When the plugin sends context to LibreChat, the system uses `sap-mcp-proxy` to resolve tool calls against the correct SAP system. The plugin injects the SAP system URL and client into the conversation context, which the ABAP Advisor agent uses to target the right VSP process in the pool.
