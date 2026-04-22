package com.advades.librechat.preferences;

import org.eclipse.core.runtime.preferences.AbstractPreferenceInitializer;
import org.eclipse.jface.preference.IPreferenceStore;

import com.advades.librechat.Activator;

/**
 * Initializes default preference values.
 */
public class PreferenceInitializer extends AbstractPreferenceInitializer {

    @Override
    public void initializeDefaultPreferences() {
        IPreferenceStore store = Activator.getDefault().getPreferenceStore();
        store.setDefault(PreferenceConstants.LIBRECHAT_URL, PreferenceConstants.DEFAULT_LIBRECHAT_URL);
        store.setDefault(PreferenceConstants.AGENT_MAPPINGS, "");
        store.setDefault(PreferenceConstants.CONTEXT_DEPTH, PreferenceConstants.DEFAULT_CONTEXT_DEPTH);
        store.setDefault(PreferenceConstants.AUTO_CONTEXT, PreferenceConstants.DEFAULT_AUTO_CONTEXT);
    }
}
