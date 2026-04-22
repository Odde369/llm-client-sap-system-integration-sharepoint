package com.advades.librechat.handlers;

import org.eclipse.ui.IWorkbenchPage;

import com.advades.librechat.context.ContextManager;
import com.advades.librechat.context.SapSystemInfo;
import com.advades.librechat.views.LibreChatView;

/**
 * Starts a new LibreChat conversation with full SAP system context.
 * Uses URL query parameters (agent_id, promptPrefix) to pre-configure the chat.
 * Keybinding: Ctrl+Shift+N
 */
public class NewSapChatHandler extends AbstractLibreChatHandler {

    @Override
    protected void doExecute(LibreChatView view, IWorkbenchPage page) {
        SapSystemInfo system = ContextManager.getInstance().getCurrentSystem();
        view.getBrowserBridge().startNewChat(system, null);
    }
}
