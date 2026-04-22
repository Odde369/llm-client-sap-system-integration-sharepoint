package com.advades.librechat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

import org.eclipse.core.runtime.ILog;
import org.eclipse.core.runtime.Platform;
import org.eclipse.core.runtime.Status;
import org.eclipse.ui.IPageListener;
import org.eclipse.ui.IStartup;
import org.eclipse.ui.IWindowListener;
import org.eclipse.ui.IWorkbench;
import org.eclipse.ui.IWorkbenchPage;
import org.eclipse.ui.IWorkbenchWindow;
import org.eclipse.ui.PlatformUI;

import com.advades.librechat.listeners.EditorPartListener;

/**
 * Registered via org.eclipse.ui.startup extension.
 * Called after the workbench is fully initialized.
 */
public class EarlyStartup implements IStartup {

    private static final ILog LOG = Platform.getLog(EarlyStartup.class);
    private static final String PROXY_URL = "http://localhost:3140";

    @Override
    public void earlyStartup() {
        LOG.log(Status.info("LibreChat EarlyStartup fired"));

        // Immediate ping so we can verify the plugin loaded — completely independent of projects
        pingProxy();

        IWorkbench workbench = PlatformUI.getWorkbench();
        workbench.getDisplay().asyncExec(() -> {
            for (IWorkbenchWindow window : workbench.getWorkbenchWindows()) {
                registerOnWindow(window);
            }
            workbench.addWindowListener(new IWindowListener() {
                @Override
                public void windowOpened(IWorkbenchWindow window) { registerOnWindow(window); }
                @Override public void windowActivated(IWorkbenchWindow w) { }
                @Override public void windowDeactivated(IWorkbenchWindow w) { }
                @Override public void windowClosed(IWorkbenchWindow w) { }
            });
        });
    }

    private void registerOnWindow(IWorkbenchWindow window) {
        EditorPartListener listener = new EditorPartListener();
        IWorkbenchPage page = window.getActivePage();
        if (page != null) {
            page.addPartListener(listener);
            LOG.log(Status.info("LibreChat: EditorPartListener registered on page"));
        }
        window.addPageListener(new IPageListener() {
            @Override
            public void pageOpened(IWorkbenchPage newPage) {
                newPage.addPartListener(new EditorPartListener());
            }
            @Override public void pageActivated(IWorkbenchPage p) { }
            @Override public void pageClosed(IWorkbenchPage p) { }
        });
    }

    /** Fire-and-forget ping so docker logs immediately show the plugin started. */
    private void pingProxy() {
        new Thread(() -> {
            try {
                HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(2))
                    .build()
                    .send(
                        HttpRequest.newBuilder()
                            .uri(URI.create(PROXY_URL + "/set-current-system"))
                            .header("Content-Type", "application/json")
                            .timeout(Duration.ofSeconds(3))
                            .POST(HttpRequest.BodyPublishers.ofString(
                                "{\"id\":\"__eclipse_startup__\"}", StandardCharsets.UTF_8))
                            .build(),
                        HttpResponse.BodyHandlers.ofString());
                LOG.log(Status.info("LibreChat: startup ping sent to proxy"));
            } catch (Exception e) {
                LOG.log(Status.info("LibreChat: proxy not reachable at startup — " + e.getMessage()));
            }
        }, "librechat-startup-ping").start();
    }
}
