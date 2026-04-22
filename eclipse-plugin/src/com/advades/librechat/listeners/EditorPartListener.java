package com.advades.librechat.listeners;

import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IPartListener2;
import org.eclipse.ui.IWorkbenchPartReference;

import com.advades.librechat.context.ContextManager;

/**
 * Listens for editor activations and notifies ContextManager
 * to detect the SAP system for the new active editor's project.
 */
public class EditorPartListener implements IPartListener2 {

    @Override
    public void partActivated(IWorkbenchPartReference partRef) {
        if (partRef.getPart(false) instanceof IEditorPart editor) {
            ContextManager.getInstance().updateFromEditor(editor);
        }
    }

    @Override
    public void partOpened(IWorkbenchPartReference partRef) {
        // Also detect on open in case this is the first editor
        if (partRef.getPart(false) instanceof IEditorPart editor) {
            ContextManager.getInstance().updateFromEditor(editor);
        }
    }

    @Override
    public void partBroughtToTop(IWorkbenchPartReference partRef) { }

    @Override
    public void partClosed(IWorkbenchPartReference partRef) { }

    @Override
    public void partDeactivated(IWorkbenchPartReference partRef) { }

    @Override
    public void partHidden(IWorkbenchPartReference partRef) { }

    @Override
    public void partVisible(IWorkbenchPartReference partRef) { }

    @Override
    public void partInputChanged(IWorkbenchPartReference partRef) {
        if (partRef.getPart(false) instanceof IEditorPart editor) {
            ContextManager.getInstance().updateFromEditor(editor);
        }
    }
}
