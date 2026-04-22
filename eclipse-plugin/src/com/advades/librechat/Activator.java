package com.advades.librechat;

import org.eclipse.jface.preference.IPreferenceStore;
import org.eclipse.ui.plugin.AbstractUIPlugin;
import org.osgi.framework.BundleContext;

import com.advades.librechat.preferences.PreferenceConstants;

/**
 * Plugin activator for LibreChat SAP Integration.
 * Manages the plugin lifecycle and provides access to shared resources.
 */
public class Activator extends AbstractUIPlugin {

    public static final String PLUGIN_ID = "com.advades.librechat";

    private static Activator plugin;

    @Override
    public void start(BundleContext context) throws Exception {
        super.start(context);
        plugin = this;
    }

    @Override
    public void stop(BundleContext context) throws Exception {
        plugin = null;
        super.stop(context);
    }

    public static Activator getDefault() {
        return plugin;
    }

    /**
     * Get the configured LibreChat URL from preferences.
     */
    public static String getLibreChatUrl() {
        if (plugin == null) return PreferenceConstants.DEFAULT_LIBRECHAT_URL;

        IPreferenceStore store = plugin.getPreferenceStore();
        String url = store.getString(PreferenceConstants.LIBRECHAT_URL);
        if (url == null || url.isEmpty()) {
            return PreferenceConstants.DEFAULT_LIBRECHAT_URL;
        }
        // Remove trailing slash
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
