package com.advades.librechat.views;

import java.beans.PropertyChangeEvent;
import java.beans.PropertyChangeListener;

import org.eclipse.swt.SWT;
import org.eclipse.swt.browser.Browser;
import org.eclipse.swt.layout.GridData;
import org.eclipse.swt.layout.GridLayout;
import org.eclipse.swt.widgets.Composite;
import org.eclipse.swt.widgets.Label;
import org.eclipse.swt.widgets.ToolBar;
import org.eclipse.swt.widgets.ToolItem;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IPartService;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.part.ViewPart;

import com.advades.librechat.Activator;
import com.advades.librechat.browser.BrowserBridge;
import com.advades.librechat.browser.ContextInjector;
import com.advades.librechat.context.ContextManager;
import com.advades.librechat.context.SapSystemInfo;
import com.advades.librechat.context.WorkspaceScanner;
import com.advades.librechat.listeners.EditorPartListener;

/**
 * Main LibreChat view embedding the browser, toolbar, and SAP context status bar.
 *
 * <p>Observes {@link ContextManager} for system/file changes and updates the
 * status bar accordingly.
 */
public class LibreChatView extends ViewPart implements PropertyChangeListener {

    public static final String VIEW_ID = "com.advades.librechat.view";

    private static final String STATUS_NO_SYSTEM = "Kein SAP-System erkannt";

    private Browser browser;
    private BrowserBridge browserBridge;
    private ContextInjector contextInjector;
    private Label statusLabel;
    private EditorPartListener editorListener;

    private static LibreChatView instance;

    public LibreChatView() {
        instance = this;
    }

    public static LibreChatView getInstance() {
        return instance;
    }

    @Override
    public void createPartControl(Composite parent) {
        GridLayout layout = new GridLayout(1, false);
        layout.marginWidth = 0;
        layout.marginHeight = 0;
        layout.verticalSpacing = 0;
        parent.setLayout(layout);

        createToolbar(parent);
        createBrowser(parent);
        createStatusBar(parent);
        registerListeners();
    }

    // ──────────────────────────────────────────────────────────
    // UI creation
    // ──────────────────────────────────────────────────────────

    private void createBrowser(Composite parent) {
        browser = new Browser(parent, SWT.EDGE);
        browser.setLayoutData(new GridData(SWT.FILL, SWT.FILL, true, true));

        browserBridge = new BrowserBridge(browser);
        contextInjector = new ContextInjector();

        // Re-install the submit interceptor and restore current file context after every page load.
        browser.addProgressListener(new org.eclipse.swt.browser.ProgressAdapter() {
            @Override
            public void completed(org.eclipse.swt.browser.ProgressEvent event) {
                browserBridge.installContextInterceptor();
                pushCurrentFileContext();
            }
        });

        browser.setUrl(Activator.getLibreChatUrl());
    }

    private void createToolbar(Composite parent) {
        ToolBar toolBar = new ToolBar(parent, SWT.FLAT | SWT.HORIZONTAL);
        toolBar.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        addToolItem(toolBar, "\u21BB Reload", "LibreChat neu laden",
            () -> browserBridge.refresh());

        new ToolItem(toolBar, SWT.SEPARATOR);

        addToolItem(toolBar, "\uFF0B SAP Chat", "Neuen Chat mit SAP-Kontext starten (Ctrl+Shift+N)",
            () -> {
                SapSystemInfo system = ContextManager.getInstance().getCurrentSystem();
                browserBridge.startNewChat(system, null);
            });

        new ToolItem(toolBar, SWT.SEPARATOR);

        addToolItem(toolBar, "\u21D2 Selection", "Markierten Code mit Kontext senden (Ctrl+Shift+L)",
            () -> injectFromEditor(contextInjector::formatSelection));

        addToolItem(toolBar, "\u21D2 File", "Aktuelle Datei mit Kontext senden (Ctrl+Shift+F)",
            () -> injectFromEditor(contextInjector::formatFullFile));

        new ToolItem(toolBar, SWT.SEPARATOR);

        addToolItem(toolBar, "\u27F3 Refresh", "SAP-Kontext manuell aktualisieren (Ctrl+Shift+R)",
            () -> {
                ContextManager.getInstance().refreshContext();
                IEditorPart editor = getActiveEditor();
                if (editor != null) {
                    ContextManager.getInstance().updateFromEditor(editor);
                }
            });
    }

    private void createStatusBar(Composite parent) {
        Composite statusComposite = new Composite(parent, SWT.NONE);
        GridLayout statusLayout = new GridLayout(1, false);
        statusLayout.marginWidth = 5;
        statusLayout.marginHeight = 2;
        statusComposite.setLayout(statusLayout);
        statusComposite.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));

        statusLabel = new Label(statusComposite, SWT.NONE);
        statusLabel.setLayoutData(new GridData(SWT.FILL, SWT.CENTER, true, false));
        statusLabel.setText(STATUS_NO_SYSTEM);
    }

    private void registerListeners() {
        ContextManager.getInstance().addPropertyChangeListener(this);

        editorListener = new EditorPartListener();
        IPartService partService = getSite().getService(IPartService.class);
        if (partService != null) {
            partService.addPartListener(editorListener);
        }

        IEditorPart activeEditor = getActiveEditor();
        if (activeEditor != null) {
            ContextManager.getInstance().updateFromEditor(activeEditor);
        }
    }

    // ──────────────────────────────────────────────────────────
    // Property change (system / file updates)
    // ──────────────────────────────────────────────────────────

    @Override
    public void propertyChange(PropertyChangeEvent evt) {
        if (statusLabel == null || statusLabel.isDisposed()) return;

        statusLabel.getDisplay().asyncExec(() -> {
            if (statusLabel.isDisposed()) return;
            updateStatusText();
        });

        // On file change: update the JS context variable used by the submit interceptor.
        // The textarea stays clean — context is appended silently when the user sends.
        if (ContextManager.PROP_FILE_CHANGED.equals(evt.getPropertyName())) {
            statusLabel.getDisplay().asyncExec(this::pushCurrentFileContext);
        }
    }

    /** Single source of truth for status bar text. */
    private void updateStatusText() {
        ContextManager ctx = ContextManager.getInstance();
        SapSystemInfo system = ctx.getCurrentSystem();
        String fileName = ctx.getCurrentFileName();

        if (system != null) {
            String text = "[" + system.getDisplayLabel() + "]";
            if (fileName != null) text += " " + fileName;
            statusLabel.setText(text);
        } else if (fileName != null) {
            statusLabel.setText(fileName);
        } else {
            statusLabel.setText(STATUS_NO_SYSTEM);
        }

        statusLabel.getParent().layout();
    }

    // ──────────────────────────────────────────────────────────
    // Lifecycle
    // ──────────────────────────────────────────────────────────

    @Override
    public void setFocus() {
        if (browser != null && !browser.isDisposed()) {
            browser.setFocus();
        }
    }

    @Override
    public void dispose() {
        ContextManager.getInstance().removePropertyChangeListener(this);

        IPartService partService = getSite().getService(IPartService.class);
        if (partService != null && editorListener != null) {
            partService.removePartListener(editorListener);
        }

        if (instance == this) {
            instance = null;
        }
        super.dispose();
    }

    // ──────────────────────────────────────────────────────────
    // Public accessors for handlers
    // ──────────────────────────────────────────────────────────

    public BrowserBridge getBrowserBridge() { return browserBridge; }
    public ContextInjector getContextInjector() { return contextInjector; }

    // ──────────────────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────────────────

    private static ToolItem addToolItem(ToolBar bar, String text, String tooltip, Runnable action) {
        ToolItem item = new ToolItem(bar, SWT.PUSH);
        item.setText(text);
        item.setToolTipText(tooltip);
        item.addListener(SWT.Selection, e -> action.run());
        return item;
    }

    /** Get the active editor for toolbar actions. */
    private IEditorPart getActiveEditor() {
        IWorkbenchPage page = getSite().getPage();
        return page != null ? page.getActiveEditor() : null;
    }

    /**
     * Push the current active file into window.__eclipseCtx so the submit
     * interceptor can append it silently to the next outgoing message.
     */
    private void pushCurrentFileContext() {
        IEditorPart editor = getActiveEditor();
        if (editor == null) return;
        WorkspaceScanner.FileInfo fi = new WorkspaceScanner().getCurrentFile(editor);
        if (fi == null) return;
        var project = ContextManager.getInstance().getCurrentProject();
        String workspacePath = (project != null && fi.path() != null)
            ? "/workspace/" + project.getName() + "/" + fi.path()
            : null;
        SapSystemInfo system = ContextManager.getInstance().getCurrentSystem();
        String sapLabel = system != null ? system.getDisplayLabel() : null;
        browserBridge.setCurrentFileContext(fi.name(), workspacePath, fi.content(), fi.language(), sapLabel);
    }

    /** Common pattern: format content from editor → inject into browser. */
    private void injectFromEditor(java.util.function.Function<IEditorPart, String> formatter) {
        IEditorPart editor = getActiveEditor();
        if (editor == null) return;

        String formatted = formatter.apply(editor);
        if (formatted != null) {
            browserBridge.injectIntoTextarea(formatted);
        }
    }
}
