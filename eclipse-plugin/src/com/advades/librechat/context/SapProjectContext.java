package com.advades.librechat.context;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.Properties;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.eclipse.core.resources.IFile;
import org.eclipse.core.resources.IProject;
import org.eclipse.core.runtime.ILog;
import org.eclipse.core.runtime.Platform;
import org.eclipse.core.runtime.Status;

/**
 * Detects SAP system information from an Eclipse project.
 *
 * <p>Detection strategy (3 tiers):
 * <ol>
 *   <li>Check {@code .project} for ABAP nature ({@code com.sap.adt.project.abap.nature})</li>
 *   <li>Try ADT API via reflection (optional dependency)</li>
 *   <li>Fallback: parse {@code .settings/} preference files for destination name</li>
 * </ol>
 *
 * <p>This class has no dependency on {@link ContextManager}. The agent-ID resolver
 * is injected as a {@link Function} parameter to {@link #detect(IProject, Function)}.
 */
public class SapProjectContext {

    private static final ILog LOG = Platform.getLog(SapProjectContext.class);

    private static final String ABAP_NATURE = "com.sap.adt.project.abap.nature";
    private static final String ADT_PREFS_PATH = ".settings/com.sap.adt.projectexplorer.prefs";
    private static final String ADT_DESTINATIONS_PATH = ".settings/com.sap.adt.destinations.prefs";

    /** Extracts SID (3-4 uppercase alphanum) and client (3 digits) from e.g. "S4H_100_DEV". */
    private static final Pattern DESTINATION_PATTERN =
        Pattern.compile("^([A-Z][A-Z0-9]{2,3})_(\\d{3})(?:_.*)?$");

    /**
     * Detect SAP system info from the given Eclipse project.
     *
     * @param project       the Eclipse project to inspect
     * @param agentResolver maps a destination name to a LibreChat agent ID (may return null)
     * @return system info, or empty if the project is not an ADT/ABAP project
     */
    public Optional<SapSystemInfo> detect(IProject project, Function<String, String> agentResolver) {
        if (project == null || !project.isOpen()) {
            return Optional.empty();
        }

        if (!isAbapProject(project)) {
            return Optional.empty();
        }

        Optional<SapSystemInfo> adtResult = detectViaAdtApi(project, agentResolver);
        if (adtResult.isPresent()) {
            return adtResult;
        }

        return detectViaFiles(project, agentResolver);
    }

    /** Convenience overload without agent resolver. */
    public Optional<SapSystemInfo> detect(IProject project) {
        return detect(project, dest -> null);
    }

    // ──────────────────────────────────────────────────────────
    // Nature detection
    // ──────────────────────────────────────────────────────────

    private boolean isAbapProject(IProject project) {
        try {
            return project.hasNature(ABAP_NATURE);
        } catch (Exception e) {
            return checkProjectFileForNature(project);
        }
    }

    private boolean checkProjectFileForNature(IProject project) {
        IFile projectFile = project.getFile(".project");
        if (!projectFile.exists()) return false;

        try (InputStream is = projectFile.getContents();
             BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            return reader.lines().anyMatch(line -> line.contains(ABAP_NATURE));
        } catch (Exception e) {
            LOG.log(Status.warning("Failed to read .project for nature check", e));
            return false;
        }
    }

    // ──────────────────────────────────────────────────────────
    // Tier 2: ADT API via reflection
    // ──────────────────────────────────────────────────────────

    private Optional<SapSystemInfo> detectViaAdtApi(IProject project, Function<String, String> agentResolver) {
        try {
            if (Platform.getBundle("com.sap.adt.project") == null) {
                return Optional.empty();
            }

            Class<?> adtCoreClass = Class.forName("com.sap.adt.project.AdtCoreProjectServiceFactory");
            Object service = adtCoreClass.getMethod("createProjectService").invoke(null);
            Object adtProject = service.getClass()
                .getMethod("getProject", IProject.class)
                .invoke(service, project);

            if (adtProject == null) return Optional.empty();

            String destination = (String) adtProject.getClass()
                .getMethod("getDestination")
                .invoke(adtProject);
            if (destination == null || destination.isEmpty()) return Optional.empty();

            String host = null;
            String sid = null;
            String client = null;
            Object destData = null;

            try {
                Class<?> destServiceClass = Class.forName(
                    "com.sap.adt.destinations.model.AdtDestinationServiceFactory");
                Object destService = destServiceClass.getMethod("createDestinationService").invoke(null);
                destData = destService.getClass()
                    .getMethod("getDestinationData", String.class)
                    .invoke(destService, destination);

                if (destData != null) {
                    host = invokeStringGetter(destData, "getHost");
                    sid = invokeStringGetter(destData, "getSystemId");
                    client = invokeStringGetter(destData, "getClient");
                }
            } catch (Exception e) {
                LOG.log(Status.info("ADT destination service unavailable, falling back to pattern matching"));
            }

            if (sid == null) {
                DestinationParts parts = parseDestinationName(destination);
                if (parts != null) {
                    sid = parts.sid;
                    client = parts.client;
                }
            }

            String url = buildSystemUrl(destData, host);

            return Optional.of(new SapSystemInfo.Builder(destination)
                .sid(sid)
                .client(client)
                .host(host)
                .url(url)
                .projectName(project.getName())
                .agentId(agentResolver.apply(destination))
                .build());

        } catch (Exception e) {
            LOG.log(Status.warning("ADT API detection failed", e));
            return Optional.empty();
        }
    }

    /**
     * Attempt to build the full SAP system URL from ADT destination data.
     * Tries direct URL getters first; falls back to composing from host + port + SSL flag.
     */
    private static String buildSystemUrl(Object destData, String host) {
        if (destData != null) {
            // Try direct URL getters (method names vary across ADT versions)
            for (String getter : new String[]{"getUrl", "getUri", "getAddress", "getConnectionUrl", "getBaseUrl"}) {
                String url = invokeStringGetter(destData, getter);
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    return url;
                }
            }

            // Try to compose from host + port + SSL
            if (host != null && !host.isEmpty()) {
                String port = null;
                try {
                    Object portObj = destData.getClass().getMethod("getPort").invoke(destData);
                    if (portObj != null && !portObj.toString().equals("0")) {
                        port = portObj.toString();
                    }
                } catch (Exception ignored) {}

                boolean ssl = true; // ADT default is HTTPS
                try {
                    Object sslObj = destData.getClass().getMethod("isSsl").invoke(destData);
                    if (sslObj instanceof Boolean b) ssl = b;
                } catch (Exception ignored) {
                    try {
                        Object sslObj = destData.getClass().getMethod("isSecure").invoke(destData);
                        if (sslObj instanceof Boolean b) ssl = b;
                    } catch (Exception ignored2) {}
                }

                String scheme = ssl ? "https" : "http";
                if (port == null) port = ssl ? "8043" : "8000";
                return scheme + "://" + host + ":" + port;
            }
        }
        return null;
    }

    // ──────────────────────────────────────────────────────────
    // Tier 3: File-based detection
    // ──────────────────────────────────────────────────────────

    private Optional<SapSystemInfo> detectViaFiles(IProject project, Function<String, String> agentResolver) {
        String destination = readDestinationFromPrefs(project);
        if (destination == null || destination.isEmpty()) {
            return Optional.empty();
        }

        String sid = null;
        String client = null;
        DestinationParts parts = parseDestinationName(destination);
        if (parts != null) {
            sid = parts.sid;
            client = parts.client;
        }

        return Optional.of(new SapSystemInfo.Builder(destination)
            .sid(sid)
            .client(client)
            .projectName(project.getName())
            .agentId(agentResolver.apply(destination))
            .build());
    }

    private String readDestinationFromPrefs(IProject project) {
        String[] prefPaths = { ADT_PREFS_PATH, ADT_DESTINATIONS_PATH };

        for (String prefPath : prefPaths) {
            IFile prefFile = project.getFile(prefPath);
            if (!prefFile.exists()) continue;

            try (InputStream is = prefFile.getContents()) {
                Properties props = new Properties();
                props.load(is);

                // Search for keys containing "destination" or "system"
                for (String key : props.stringPropertyNames()) {
                    String lowerKey = key.toLowerCase();
                    if (lowerKey.contains("destination") || lowerKey.contains("system")) {
                        String value = props.getProperty(key);
                        if (value != null && !value.isEmpty()
                                && DESTINATION_PATTERN.matcher(value).matches()) {
                            return value;
                        }
                    }
                }

                // Well-known property keys
                String system = props.getProperty("abap.system");
                if (system != null && !system.isEmpty()) return system;

                String dest = props.getProperty("destination");
                if (dest != null && !dest.isEmpty()) return dest;

            } catch (Exception e) {
                LOG.log(Status.warning("Failed to read preferences from " + prefPath, e));
            }
        }

        // Last resort: derive from project name
        DestinationParts parts = parseDestinationName(project.getName().toUpperCase());
        return parts != null ? project.getName().toUpperCase() : null;
    }

    // ──────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────

    private static String invokeStringGetter(Object target, String methodName) {
        try {
            return (String) target.getClass().getMethod(methodName).invoke(target);
        } catch (Exception e) {
            return null;
        }
    }

    /** Parses "S4H_100_DEV" into sid="S4H", client="100". Returns null if no match. */
    static DestinationParts parseDestinationName(String name) {
        if (name == null) return null;
        Matcher m = DESTINATION_PATTERN.matcher(name);
        return m.matches() ? new DestinationParts(m.group(1), m.group(2)) : null;
    }

    /** Simple holder for parsed destination name components. */
    record DestinationParts(String sid, String client) {}
}
