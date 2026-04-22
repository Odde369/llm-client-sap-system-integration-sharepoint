package com.advades.librechat.preferences;

/**
 * Constants for plugin preference keys.
 */
public final class PreferenceConstants {

    /** LibreChat server URL */
    public static final String LIBRECHAT_URL = "libreChatUrl";

    /** Default LibreChat URL */
    public static final String DEFAULT_LIBRECHAT_URL = "http://localhost:3080";

    /**
     * Agent mapping string.
     * Format: "DEST1=agent_id1;DEST2=agent_id2;..."
     * Maps SAP destination names to LibreChat agent IDs.
     */
    public static final String AGENT_MAPPINGS = "agentMappings";

    /** Max depth for project tree scanning */
    public static final String CONTEXT_DEPTH = "contextDepth";

    /** Default context depth */
    public static final int DEFAULT_CONTEXT_DEPTH = 3;

    /** Enable/disable automatic context detection */
    public static final String AUTO_CONTEXT = "autoContext";

    /** Default auto context setting */
    public static final boolean DEFAULT_AUTO_CONTEXT = true;

    private PreferenceConstants() {}
}
