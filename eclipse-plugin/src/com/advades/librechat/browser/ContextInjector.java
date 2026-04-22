package com.advades.librechat.browser;

import org.eclipse.ui.IEditorPart;

import com.advades.librechat.context.ContextManager;
import com.advades.librechat.context.SapSystemInfo;
import com.advades.librechat.context.WorkspaceScanner;
import com.advades.librechat.context.WorkspaceScanner.FileInfo;

/**
 * Formats code and context into structured messages for LibreChat.
 *
 * <p>Two output modes:
 * <ul>
 *   <li><b>Message injection</b> ({@link #formatSelection}, {@link #formatFullFile}):
 *       inline Markdown block prepended to the textarea text</li>
 *   <li><b>Prompt prefix</b> ({@link #buildPromptPrefix}):
 *       system-level instructions set once per conversation via URL param</li>
 * </ul>
 */
public final class ContextInjector {

    private final WorkspaceScanner scanner = new WorkspaceScanner();

    // ──────────────────────────────────────────────────────────
    // Message injection (per-message context)
    // ──────────────────────────────────────────────────────────

    /**
     * Format selected code with SAP context for message injection.
     *
     * @return formatted Markdown text, or {@code null} if no selection
     */
    public String formatSelection(IEditorPart editor) {
        String selection = scanner.getSelectedText(editor);
        if (selection == null) return null;

        FileInfo fileInfo = scanner.getCurrentFile(editor);
        SapSystemInfo system = ContextManager.getInstance().getCurrentSystem();

        return buildCodeBlock(system, fileInfo, selection);
    }

    /**
     * Format the full file content with SAP context for message injection.
     *
     * @return formatted Markdown text, or {@code null} if no active file
     */
    public String formatFullFile(IEditorPart editor) {
        FileInfo fileInfo = scanner.getCurrentFile(editor);
        if (fileInfo == null || fileInfo.content() == null) return null;

        SapSystemInfo system = ContextManager.getInstance().getCurrentSystem();

        return buildCodeBlock(system, fileInfo, fileInfo.content());
    }

    // ──────────────────────────────────────────────────────────
    // Prompt prefix (per-conversation context)
    // ──────────────────────────────────────────────────────────

    /**
     * Build the promptPrefix for a new SAP-aware conversation.
     * Instructs the LLM which system to use with sap-mcp-proxy tools.
     *
     * @return prompt prefix string, or {@code null} if no system detected
     */
    public String buildPromptPrefix(SapSystemInfo system) {
        if (system == null) return null;

        StringBuilder sb = new StringBuilder();
        sb.append("Du bist ein SAP ABAP Entwicklungsassistent.\n");
        sb.append(system.toContextBlock()).append("\n\n");

        sb.append("MCP-Server:\n");
        sb.append("- 'sap': SAP-System-Zugriff (sap_list_tools, sap_execute)\n");
        sb.append("- 'filesystem-mcp' (\"Workspace Files\"): liest/schreibt Dateien unter /workspace\n\n");

        sb.append("Dateizugriff: Alle Projektdateien liegen unter /workspace/{Projektname}/.\n");
        sb.append("Nutze read_file, list_directory oder search_files um Dateien selbst zu lesen,\n");
        sb.append("statt auf den Nutzer zu warten.\n\n");

        var project = ContextManager.getInstance().getCurrentProject();

        if (project != null) {
            String tree = scanner.scanProjectTree(project);
            if (!tree.isEmpty()) {
                sb.append("Projektstruktur:\n").append(tree);
            }
        }

        return sb.toString();
    }

    // ──────────────────────────────────────────────────────────
    // Internal formatting
    // ──────────────────────────────────────────────────────────

    /**
     * Build the /workspace path for a file so agents can use read_file via filesystem-mcp.
     * Returns null if project name or file path is unavailable.
     */
    private static String buildWorkspacePath(SapSystemInfo system, FileInfo fileInfo) {
        if (fileInfo == null || fileInfo.path() == null) return null;
        String projectName = (system != null) ? system.getProjectName() : null;
        if (projectName == null || projectName.isBlank()) return null;
        return "/workspace/" + projectName + "/" + fileInfo.path();
    }

    private static String buildCodeBlock(SapSystemInfo system, FileInfo fileInfo, String code) {
        StringBuilder sb = new StringBuilder();

        if (system != null) {
            sb.append("**SAP System: ").append(system.getDisplayLabel())
              .append(" (system='").append(system.getDestinationName()).append("')")
              .append("**\n");
        }

        if (fileInfo != null) {
            sb.append("**Datei: ").append(fileInfo.name()).append("**");
            String workspacePath = buildWorkspacePath(system, fileInfo);
            if (workspacePath != null) {
                sb.append(" (`").append(workspacePath).append("`)");
            } else if (fileInfo.path() != null) {
                sb.append(" (").append(fileInfo.path()).append(")");
            }
            sb.append("\n");
        }

        sb.append("\n");
        String lang = (fileInfo != null) ? fileInfo.language() : "";
        sb.append("```").append(lang).append("\n");
        sb.append(code).append("\n");
        sb.append("```\n");

        return sb.toString();
    }
}
