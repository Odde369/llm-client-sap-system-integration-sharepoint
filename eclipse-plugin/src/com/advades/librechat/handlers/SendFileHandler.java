package com.advades.librechat.handlers;

import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IWorkbenchPage;

import com.advades.librechat.views.LibreChatView;

/**
 * Sends the entire current file with SAP context to LibreChat.
 * Keybinding: Ctrl+Shift+F
 */
public class SendFileHandler extends AbstractLibreChatHandler {

    @Override
    protected void doExecute(LibreChatView view, IWorkbenchPage page) {
        IEditorPart editor = getActiveEditor(page);
        if (editor == null) return;

        String formatted = view.getContextInjector().formatFullFile(editor);
        if (formatted != null) {
            view.getBrowserBridge().injectIntoTextarea(formatted);
        }
    }
}
