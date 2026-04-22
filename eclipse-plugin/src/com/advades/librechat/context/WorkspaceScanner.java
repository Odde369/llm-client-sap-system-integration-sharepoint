package com.advades.librechat.context;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.eclipse.core.resources.IContainer;
import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.runtime.CoreException;
import org.eclipse.core.runtime.ILog;
import org.eclipse.core.runtime.Platform;
import org.eclipse.core.runtime.Status;
import org.eclipse.jface.text.ITextSelection;
import org.eclipse.ui.IEditorInput;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IFileEditorInput;
import org.eclipse.ui.texteditor.IDocumentProvider;
import org.eclipse.ui.texteditor.ITextEditor;

/**
 * Scans the Eclipse workspace to build context information
 * about the project structure and current file content.
 */
public final class WorkspaceScanner {

    private static final ILog LOG = Platform.getLog(WorkspaceScanner.class);
    private static final int DEFAULT_MAX_DEPTH = 3;
    private static final int MAX_TREE_ENTRIES = 100;

    /** ABAP file extension → human-readable object type. Ordered most-specific first. */
    private static final Map<String, String> ABAP_TYPES = createAbapTypeMap();

    /** File extension → language identifier for syntax highlighting. */
    private static final Map<String, String> LANGUAGE_MAP = createLanguageMap();

    // ──────────────────────────────────────────────────────────
    // Project tree scanning
    // ──────────────────────────────────────────────────────────

    /**
     * Build a compact tree representation of the project's structure.
     */
    public String scanProjectTree(IProject project, int maxDepth) {
        if (project == null || !project.isOpen()) return "";

        int effectiveDepth = maxDepth > 0 ? maxDepth : DEFAULT_MAX_DEPTH;
        StringBuilder sb = new StringBuilder();
        sb.append("Projekt: ").append(project.getName()).append("\n");

        try {
            appendTree(sb, project, 0, effectiveDepth, new int[]{0});
        } catch (CoreException e) {
            LOG.log(Status.warning("Failed to scan project tree for " + project.getName(), e));
            sb.append("  (Fehler beim Lesen der Projektstruktur)");
        }

        return sb.toString();
    }

    public String scanProjectTree(IProject project) {
        return scanProjectTree(project, DEFAULT_MAX_DEPTH);
    }

    // ──────────────────────────────────────────────────────────
    // File content
    // ──────────────────────────────────────────────────────────

    /**
     * Get the full content and metadata of the currently active file.
     */
    public FileInfo getCurrentFile(IEditorPart editor) {
        if (editor == null) return null;

        IEditorInput input = editor.getEditorInput();
        String fileName = input.getName();
        String filePath = extractFilePath(input);
        String content = readFromEditor(editor, input);

        if (content == null) {
            content = readFromFileSystem(input);
        }

        return new FileInfo(fileName, filePath, content, detectLanguage(fileName));
    }

    /**
     * Get the selected text from the active editor.
     */
    public String getSelectedText(IEditorPart editor) {
        if (!(editor instanceof ITextEditor textEditor)) return null;

        var provider = textEditor.getSelectionProvider();
        if (provider == null) return null;

        var selection = provider.getSelection();
        if (selection instanceof ITextSelection textSel) {
            String text = textSel.getText();
            return (text != null && !text.isBlank()) ? text : null;
        }
        return null;
    }

    // ──────────────────────────────────────────────────────────
    // Tree building (recursive)
    // ──────────────────────────────────────────────────────────

    private void appendTree(StringBuilder sb, IContainer container, int depth,
                            int maxDepth, int[] count) throws CoreException {
        if (depth >= maxDepth || count[0] >= MAX_TREE_ENTRIES) return;

        List<IResource> visible = filterVisible(container.members());

        for (int i = 0; i < visible.size(); i++) {
            if (count[0] >= MAX_TREE_ENTRIES) {
                sb.append(indent(depth)).append("... (weitere Eintraege)\n");
                break;
            }

            IResource member = visible.get(i);
            boolean isLast = (i == visible.size() - 1);
            String connector = isLast ? "\u2514\u2500\u2500 " : "\u251C\u2500\u2500 ";

            if (member instanceof IContainer subContainer) {
                sb.append(indent(depth)).append(connector).append(member.getName()).append("/\n");
                count[0]++;
                appendTree(sb, subContainer, depth + 1, maxDepth, count);
            } else if (member instanceof IFile) {
                sb.append(indent(depth)).append(connector).append(member.getName());
                String type = getAbapObjectType(member.getName());
                if (type != null) sb.append(" (").append(type).append(")");
                sb.append("\n");
                count[0]++;
            }
        }
    }

    /** Filter out hidden and build-output resources. */
    private static List<IResource> filterVisible(IResource[] members) {
        List<IResource> result = new ArrayList<>();
        for (IResource r : members) {
            String name = r.getName();
            if (!name.startsWith(".") && !name.equals("bin") && !name.equals("target")) {
                result.add(r);
            }
        }
        return result;
    }

    private static String indent(int depth) {
        return "  ".repeat(depth);
    }

    // ──────────────────────────────────────────────────────────
    // File reading helpers
    // ──────────────────────────────────────────────────────────

    private static String extractFilePath(IEditorInput input) {
        if (input instanceof IFileEditorInput fileInput) {
            return fileInput.getFile().getProjectRelativePath().toString();
        }
        return null;
    }

    private static String readFromEditor(IEditorPart editor, IEditorInput input) {
        if (!(editor instanceof ITextEditor textEditor)) return null;

        IDocumentProvider provider = textEditor.getDocumentProvider();
        if (provider == null) return null;

        var document = provider.getDocument(input);
        return document != null ? document.get() : null;
    }

    private static String readFromFileSystem(IEditorInput input) {
        if (!(input instanceof IFileEditorInput fileInput)) return null;

        try (InputStream is = fileInput.getFile().getContents();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            return reader.lines().collect(Collectors.joining("\n"));
        } catch (Exception e) {
            LOG.log(Status.warning("Failed to read file content", e));
            return null;
        }
    }

    // ──────────────────────────────────────────────────────────
    // Type / language detection (Map-based)
    // ──────────────────────────────────────────────────────────

    static String getAbapObjectType(String filename) {
        if (filename == null) return null;
        String lower = filename.toLowerCase();
        for (var entry : ABAP_TYPES.entrySet()) {
            if (lower.endsWith(entry.getKey())) return entry.getValue();
        }
        return null;
    }

    static String detectLanguage(String filename) {
        if (filename == null) return "";
        String lower = filename.toLowerCase();
        for (var entry : LANGUAGE_MAP.entrySet()) {
            if (lower.endsWith(entry.getKey())) return entry.getValue();
        }
        return "";
    }

    /** Ordered most-specific first so ".clas.testclasses.abap" matches before ".clas.abap". */
    private static Map<String, String> createAbapTypeMap() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put(".clas.testclasses.abap", "Test Class");
        m.put(".clas.abap", "Class");
        m.put(".intf.abap", "Interface");
        m.put(".fugr.abap", "Function Group");
        m.put(".prog.abap", "Program");
        m.put(".tabl.abap", "Table");
        m.put(".dtel.abap", "Data Element");
        m.put(".doma.abap", "Domain");
        m.put(".msag.abap", "Message Class");
        m.put(".ttyp.abap", "Table Type");
        m.put(".ddls.asddls", "CDS View");
        m.put(".ddls.abap", "CDS View");
        m.put(".dcls.asdcls", "Access Control");
        m.put(".dcls.abap", "Access Control");
        m.put(".srvb.abap", "Service Binding");
        m.put(".srvd.abap", "Service Definition");
        m.put(".bdef.asbdef", "Behavior Definition");
        m.put(".bdef.abap", "Behavior Definition");
        m.put(".ddlx.abap", "Metadata Extension");
        m.put(".enho.abap", "Enhancement");
        return Collections.unmodifiableMap(m);
    }

    private static Map<String, String> createLanguageMap() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put(".abap", "abap");
        m.put(".asddls", "abap");
        m.put(".asdcls", "abap");
        m.put(".asbdef", "abap");
        m.put(".xml", "xml");
        m.put(".json", "json");
        m.put(".js", "javascript");
        m.put(".ts", "typescript");
        m.put(".java", "java");
        m.put(".py", "python");
        m.put(".html", "html");
        m.put(".css", "css");
        m.put(".yaml", "yaml");
        m.put(".yml", "yaml");
        return Collections.unmodifiableMap(m);
    }

    // ──────────────────────────────────────────────────────────
    // FileInfo value object
    // ──────────────────────────────────────────────────────────

    /** Immutable file metadata and content. */
    public record FileInfo(String name, String path, String content, String language) {}
}
