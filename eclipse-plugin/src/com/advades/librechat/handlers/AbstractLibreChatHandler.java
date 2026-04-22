package com.advades.librechat.handlers;

import org.eclipse.core.commands.AbstractHandler;
import org.eclipse.core.commands.ExecutionEvent;
import org.eclipse.core.commands.ExecutionException;
import org.eclipse.ui.IEditorPart;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.IWorkbenchWindow;
import org.eclipse.ui.PartInitException;
import org.eclipse.ui.PlatformUI;

import com.advades.librechat.views.LibreChatView;

/**
 * Base class for all LibreChat command handlers.
 *
 * <p>Handles the common pattern of:
 * <ol>
 *   <li>Getting the active workbench page (with null safety)</li>
 *   <li>Ensuring the LibreChat view is open</li>
 *   <li>Delegating to the subclass via {@link #doExecute(LibreChatView, IWorkbenchPage)}</li>
 * </ol>
 */
public abstract class AbstractLibreChatHandler extends AbstractHandler {

    @Override
    public final Object execute(ExecutionEvent event) throws ExecutionException {
        IWorkbenchWindow window = PlatformUI.getWorkbench().getActiveWorkbenchWindow();
        if (window == null) return null;

        IWorkbenchPage page = window.getActivePage();
        if (page == null) return null;

        try {
            page.showView(LibreChatView.VIEW_ID);
        } catch (PartInitException e) {
            throw new ExecutionException("LibreChat View konnte nicht geoeffnet werden", e);
        }

        LibreChatView view = LibreChatView.getInstance();
        if (view == null) return null;

        doExecute(view, page);
        return null;
    }

    /**
     * Implement the handler-specific logic. The LibreChat view is guaranteed to be open.
     *
     * @param view the active LibreChat view instance
     * @param page the active workbench page
     */
    protected abstract void doExecute(LibreChatView view, IWorkbenchPage page);

    /** Convenience: get the active editor from the page, or null. */
    protected static IEditorPart getActiveEditor(IWorkbenchPage page) {
        return page.getActiveEditor();
    }
}
