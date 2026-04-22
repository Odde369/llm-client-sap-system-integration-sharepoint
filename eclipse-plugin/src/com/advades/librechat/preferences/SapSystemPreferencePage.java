package com.advades.librechat.preferences;

import org.eclipse.jface.preference.BooleanFieldEditor;
import org.eclipse.jface.preference.FieldEditorPreferencePage;
import org.eclipse.jface.preference.IntegerFieldEditor;
import org.eclipse.jface.preference.StringFieldEditor;
import org.eclipse.ui.IWorkbench;
import org.eclipse.ui.IWorkbenchPreferencePage;

import com.advades.librechat.Activator;

/**
 * Preference page for LibreChat SAP Integration settings.
 * Available at Window > Preferences > LibreChat.
 */
public class SapSystemPreferencePage extends FieldEditorPreferencePage
        implements IWorkbenchPreferencePage {

    public SapSystemPreferencePage() {
        super(GRID);
        setPreferenceStore(Activator.getDefault().getPreferenceStore());
        setDescription("LibreChat SAP Integration - Einstellungen");
    }

    @Override
    public void init(IWorkbench workbench) {
        // nothing to initialize
    }

    @Override
    protected void createFieldEditors() {
        // LibreChat URL
        addField(new StringFieldEditor(
            PreferenceConstants.LIBRECHAT_URL,
            "LibreChat URL:",
            getFieldEditorParent()
        ));

        // Agent Mappings
        StringFieldEditor mappingsEditor = new StringFieldEditor(
            PreferenceConstants.AGENT_MAPPINGS,
            "Agent-Mappings (DEST=agent_id;...):",
            getFieldEditorParent()
        );
        mappingsEditor.setEmptyStringAllowed(true);
        addField(mappingsEditor);

        // Context Depth
        IntegerFieldEditor depthEditor = new IntegerFieldEditor(
            PreferenceConstants.CONTEXT_DEPTH,
            "Projektbaum-Tiefe:",
            getFieldEditorParent()
        );
        depthEditor.setValidRange(1, 10);
        addField(depthEditor);

        // Auto Context
        addField(new BooleanFieldEditor(
            PreferenceConstants.AUTO_CONTEXT,
            "Automatische SAP-Kontext-Erkennung",
            getFieldEditorParent()
        ));
    }
}
