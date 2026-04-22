package com.advades.librechat.context;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

import org.eclipse.core.runtime.ILog;
import org.eclipse.core.runtime.Platform;
import org.eclipse.core.runtime.Status;

/**
 * Registers a detected SAP system with the sap-mcp-proxy at runtime.
 *
 * <p>Called automatically by {@link ContextManager} when an ADT project is opened.
 * Posts to {@code POST /register-system} on the proxy, so the LLM can immediately
 * use {@code sap_execute(system='DEST_NAME', ...)} without any manual config.
 */
public final class SapMcpProxyRegistrar {

    private static final ILog LOG = Platform.getLog(SapMcpProxyRegistrar.class);

    /** Default proxy URL — sap-mcp-proxy exposed on host port 3140. */
    private static final String DEFAULT_PROXY_URL = "http://localhost:3140";

    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(3))
        .build();

    private SapMcpProxyRegistrar() {}

    /**
     * Register the given SAP system with the proxy asynchronously (fire-and-forget).
     * URL is optional — the proxy falls back to its SAP_URL environment variable.
     */
    public static void registerAsync(SapSystemInfo system) {
        if (system == null) return;
        Thread t = new Thread(() -> doRegister(system));
        t.setDaemon(true);
        t.start();
    }

    /**
     * Set this system as the currently active system in the proxy (fire-and-forget).
     * Called whenever the user switches to a different ABAP project in Eclipse.
     */
    public static void setCurrentAsync(SapSystemInfo system) {
        if (system == null) return;
        Thread t = new Thread(() -> doSetCurrent(system.getDestinationName()));
        t.setDaemon(true);
        t.start();
    }

    private static void doSetCurrent(String id) {
        try {
            String json = "{\"id\":" + jsonString(id) + "}";

            HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(DEFAULT_PROXY_URL + "/set-current-system"))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(5))
                .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                .build();

            HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());

            if (resp.statusCode() == 200) {
                LOG.log(Status.info("SapMcpProxyRegistrar: current system set to " + id));
            } else {
                LOG.log(Status.warning("SapMcpProxyRegistrar: set-current returned " +
                    resp.statusCode() + ": " + resp.body()));
            }
        } catch (Exception e) {
            LOG.log(Status.info("SapMcpProxyRegistrar: could not set current system — " + e.getMessage()));
        }
    }

    private static void doRegister(SapSystemInfo system) {
        try {
            String proxyUrl = DEFAULT_PROXY_URL;
            String json = buildJson(system);

            HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(proxyUrl + "/register-system"))
                .header("Content-Type", "application/json")
                .timeout(Duration.ofSeconds(5))
                .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                .build();

            HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());

            if (resp.statusCode() == 200) {
                LOG.log(Status.info("SapMcpProxyRegistrar: registered " +
                    system.getDestinationName() + " -> " + system.getUrl()));
            } else {
                LOG.log(Status.warning("SapMcpProxyRegistrar: proxy returned " +
                    resp.statusCode() + " for " + system.getDestinationName() +
                    ": " + resp.body()));
            }
        } catch (Exception e) {
            // Non-fatal: proxy may not be running (e.g. local dev without Docker)
            LOG.log(Status.info("SapMcpProxyRegistrar: could not reach proxy — " + e.getMessage()));
        }
    }

    private static String buildJson(SapSystemInfo s) {
        return "{"
            + "\"id\":" + jsonString(s.getDestinationName()) + ","
            + "\"label\":" + jsonString(s.getDisplayLabel()) + ","
            + "\"url\":" + jsonString(s.getUrl()) + ","
            + "\"client\":" + jsonString(s.getClient() != null ? s.getClient() : "001")
            + "}";
    }

    private static String jsonString(String value) {
        if (value == null) return "null";
        return "\"" + value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            + "\"";
    }
}
