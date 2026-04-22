package com.advades.librechat.context;

import java.util.Objects;

/**
 * Immutable value object holding SAP system connection metadata
 * detected from an Eclipse ADT project.
 *
 * <p>Use {@link Builder} to construct instances:
 * <pre>{@code
 * SapSystemInfo info = new SapSystemInfo.Builder("S4H_100_DEV")
 *     .sid("S4H")
 *     .client("100")
 *     .host("s4h.example.com")
 *     .projectName("MY_PROJECT")
 *     .build();
 * }</pre>
 */
public final class SapSystemInfo {

    private final String destinationName;
    private final String sid;
    private final String client;
    private final String host;
    private final String url;
    private final String projectName;
    private final String agentId;

    private SapSystemInfo(Builder builder) {
        this.destinationName = Objects.requireNonNull(builder.destinationName, "destinationName must not be null");
        this.sid = builder.sid;
        this.client = builder.client;
        this.host = builder.host;
        this.url = builder.url;
        this.projectName = builder.projectName;
        this.agentId = builder.agentId;
    }

    public String getDestinationName() { return destinationName; }
    public String getSid() { return sid; }
    public String getClient() { return client; }
    public String getHost() { return host; }
    public String getUrl() { return url; }
    public String getProjectName() { return projectName; }
    public String getAgentId() { return agentId; }

    /**
     * Display label for the status bar, e.g. "S4H / Client 100".
     */
    public String getDisplayLabel() {
        StringBuilder sb = new StringBuilder();
        sb.append(sid != null && !sid.isEmpty() ? sid : destinationName);
        if (client != null && !client.isEmpty()) {
            sb.append(" / Client ").append(client);
        }
        return sb.toString();
    }

    /**
     * Multi-line context block for LLM prompt prefix.
     */
    public String toContextBlock() {
        StringBuilder sb = new StringBuilder();
        sb.append("SAP System: ").append(sid != null ? sid : destinationName);
        if (client != null) sb.append(" (Client ").append(client).append(")");
        if (host != null) sb.append("\nHost: ").append(host);
        if (projectName != null) sb.append("\nProjekt: ").append(projectName);
        return sb.toString();
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof SapSystemInfo that)) return false;
        return Objects.equals(destinationName, that.destinationName)
            && Objects.equals(sid, that.sid)
            && Objects.equals(client, that.client)
            && Objects.equals(host, that.host)
            && Objects.equals(projectName, that.projectName);
    }

    @Override
    public int hashCode() {
        return Objects.hash(destinationName, sid, client, host, projectName);
    }

    @Override
    public String toString() {
        return "SapSystemInfo[" + getDisplayLabel() + ", project=" + projectName + "]";
    }

    /**
     * Builder for {@link SapSystemInfo}.
     */
    public static final class Builder {

        private final String destinationName;
        private String sid;
        private String client;
        private String host;
        private String url;
        private String projectName;
        private String agentId;

        /**
         * @param destinationName the SAP destination name (required), e.g. "S4H_100_DEV"
         */
        public Builder(String destinationName) {
            this.destinationName = destinationName;
        }

        public Builder sid(String sid) { this.sid = sid; return this; }
        public Builder client(String client) { this.client = client; return this; }
        public Builder host(String host) { this.host = host; return this; }
        public Builder url(String url) { this.url = url; return this; }
        public Builder projectName(String projectName) { this.projectName = projectName; return this; }
        public Builder agentId(String agentId) { this.agentId = agentId; return this; }

        public SapSystemInfo build() {
            return new SapSystemInfo(this);
        }
    }
}
