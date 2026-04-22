package com.advades.librechat.handlers;

import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IWorkbenchPage;

import com.advades.librechat.context.ContextManager;
import com.advades.librechat.views.LibreChatView;

/**
 * Forces re-detection of the current SAP system context.
 * Reloads agent mappings from preferences and re-scans the active project.
 * Keybinding: Ctrl+Shift+R
 */
public class RefreshContextHandler extends AbstractLibreChatHandler {

    @Override
    protected void doExecute(LibreChatView view, IWorkbenchPage page) {
        ContextManager manager = ContextManager.getInstance();
        manager.refreshContext();

        IEditorPart editor = getActiveEditor(page);
        if (editor != null) {
            manager.updateFromEditor(editor);
        }
    }
}
