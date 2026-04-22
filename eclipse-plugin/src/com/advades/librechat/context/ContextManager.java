package com.advades.librechat.context;

import java.beans.PropertyChangeListener;
import java.beans.PropertyChangeSupport;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.runtime.ILog;
import org.eclipse.core.runtime.Platform;
import org.eclipse.core.runtime.Status;
import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.ui.IEditorInput;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IFileEditorInput;

import com.advades.librechat.Activator;
import com.advades.librechat.preferences.PreferenceConstants;

/**
 * Singleton that tracks the current SAP system context.
 *
 * <p>Listens for editor activations (via {@link com.advades.librechat.listeners.EditorPartListener}),
 * detects the SAP system from the editor's project, and fires {@link java.beans.PropertyChangeEvent}s
 * so that the UI (status bar, toolbar) can react.
 *
 * <p>Thread-safety: {@link #getInstance()} is synchronized. All mutable state
 * ({@code currentSystem}, {@code currentFileName}, {@code currentProject}) is only
 * written from the UI thread (called by EditorPartListener / toolbar handlers).
 */
public final class ContextManager {

    public static final String PROP_SYSTEM_CHANGED = "sapSystem";
    public static final String PROP_FILE_CHANGED = "currentFile";

    private static final ILog LOG = Platform.getLog(ContextManager.class);

    private static ContextManager instance;

    private final PropertyChangeSupport changeSupport = new PropertyChangeSupport(this);
    private final SapProjectContext detector = new SapProjectContext();

    private Map<String, String> destinationAgentMap = Collections.emptyMap();
    private SapSystemInfo currentSystem;
    private String currentFileName;
    private IProject currentProject;

    private ContextManager() {
        loadAgentMappings();
    }

    public static synchronized ContextManager getInstance() {
        if (instance == null) {
            instance = new ContextManager();
        }
        return instance;
    }

    // ──────────────────────────────────────────────────────────
    // Editor tracking
    // ──────────────────────────────────────────────────────────

    /**
     * Called when the active editor changes.
     * Detects the SAP system from the editor's project and fires events if changed.
     */
    public void updateFromEditor(IEditorPart editor) {
        if (editor == null) return;

        IEditorInput input = editor.getEditorInput();
        updateCurrentFileName(input.getName());
        updateCurrentProject(extractProject(input));
    }

    /** Force re-detection of the current project's SAP context. */
    public void refreshContext() {
        currentProject = null;
        loadAgentMappings();
        LOG.log(Status.info("SAP context refreshed, agent mappings reloaded"));
    }

    // ──────────────────────────────────────────────────────────
    // Agent mapping
    // ──────────────────────────────────────────────────────────

    /** Resolve agent ID for a given destination name from the preference mapping. */
    public String resolveAgentId(String destinationName) {
        if (destinationName == null) return null;
        return destinationAgentMap.get(destinationName);
    }

    // ──────────────────────────────────────────────────────────
    // Accessors
    // ──────────────────────────────────────────────────────────

    public SapSystemInfo getCurrentSystem() { return currentSystem; }
    public String getCurrentFileName() { return currentFileName; }
    public IProject getCurrentProject() { return currentProject; }

    public void addPropertyChangeListener(PropertyChangeListener listener) {
        changeSupport.addPropertyChangeListener(listener);
    }

    public void removePropertyChangeListener(PropertyChangeListener listener) {
        changeSupport.removePropertyChangeListener(listener);
    }

    // ──────────────────────────────────────────────────────────
    // Internal
    // ──────────────────────────────────────────────────────────

    private void updateCurrentFileName(String newFileName) {
        if (newFileName == null || newFileName.equals(currentFileName)) return;

        String oldFileName = currentFileName;
        currentFileName = newFileName;
        changeSupport.firePropertyChange(PROP_FILE_CHANGED, oldFileName, newFileName);
    }

    private void updateCurrentProject(IProject project) {
        if (project == null || project.equals(currentProject)) return;

        currentProject = project;

        Optional<SapSystemInfo> detected = detector.detect(project, this::resolveAgentId);
        SapSystemInfo newSystem = detected.orElse(null);

        if (java.util.Objects.equals(currentSystem, newSystem)) return;

        SapSystemInfo oldSystem = currentSystem;
        currentSystem = newSystem;
        changeSupport.firePropertyChange(PROP_SYSTEM_CHANGED, oldSystem, newSystem);

        if (newSystem != null) {
            LOG.log(Status.info("SAP system detected: " + newSystem));
            SapMcpProxyRegistrar.registerAsync(newSystem);
            SapMcpProxyRegistrar.setCurrentAsync(newSystem);
        }
    }

    private static IProject extractProject(IEditorInput input) {
        if (input instanceof IFileEditorInput fileInput) {
            IFile file = fileInput.getFile();
            return file.getProject();
        }
        return null;
    }

    private void loadAgentMappings() {
        try {
            Activator activator = Activator.getDefault();
            if (activator == null) return;

            IPreferenceStore store = activator.getPreferenceStore();
            String mappings = store.getString(PreferenceConstants.AGENT_MAPPINGS);
            if (mappings == null || mappings.isEmpty()) {
                destinationAgentMap = Collections.emptyMap();
                return;
            }

            // Format: "DEST1=agent_id1;DEST2=agent_id2;..."
            Map<String, String> parsed = new HashMap<>();
            for (String entry : mappings.split(";")) {
                String[] parts = entry.split("=", 2);
                if (parts.length == 2 && !parts[0].isBlank() && !parts[1].isBlank()) {
                    parsed.put(parts[0].trim(), parts[1].trim());
                }
            }
            destinationAgentMap = Collections.unmodifiableMap(parsed);
        } catch (Exception e) {
            LOG.log(Status.warning("Failed to load agent mappings from preferences", e));
        }
    }
}
