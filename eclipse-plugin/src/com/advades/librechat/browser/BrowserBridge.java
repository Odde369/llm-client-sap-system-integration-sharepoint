package com.advades.librechat.browser;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import org.eclipse.swt.browser.Browser;
import org.eclipse.swt.browser.ProgressAdapter;
import org.eclipse.swt.browser.ProgressEvent;

import com.advades.librechat.Activator;
import com.advades.librechat.context.SapSystemInfo;

/**
 * Abstracts communication with the embedded SWT Browser.
 *
 * <p>Responsibilities:
 * <ul>
 *   <li>URL navigation with LibreChat query parameters</li>
 *   <li>JavaScript injection into the React-controlled textarea</li>
 *   <li>Fallback from URL params to JS injection when URL exceeds max length</li>
 * </ul>
 */
public final class BrowserBridge {

    private final Browser browser;

    private static final int MAX_URL_LENGTH = 2000;
    private static final int POST_LOAD_DELAY_MS = 1500;

    public BrowserBridge(Browser browser) {
        this.browser = browser;
    }

    // ──────────────────────────────────────────────────────────
    // Navigation
    // ──────────────────────────────────────────────────────────

    /**
     * Start a new LibreChat chat, pre-configured with SAP system context.
     * Uses URL query parameters (agent_id, promptPrefix). Falls back to
     * JS injection if the URL exceeds {@value #MAX_URL_LENGTH} characters.
     */
    public void startNewChat(SapSystemInfo system, String promptPrefix) {
        startNewChat(system, promptPrefix, null);
    }

    /**
     * Start a new chat, optionally auto-submitting an initial prompt.
     */
    public void startNewChat(SapSystemInfo system, String promptPrefix, String initialPrompt) {
        String baseUrl = Activator.getLibreChatUrl();

        StringBuilder params = new StringBuilder();
        if (system != null && system.getAgentId() != null) {
            appendParam(params, "agent_id", system.getAgentId());
        }
        if (promptPrefix != null && !promptPrefix.isEmpty()) {
            appendParam(params, "promptPrefix", promptPrefix);
        }
        if (initialPrompt != null && !initialPrompt.isEmpty()) {
            appendParam(params, "prompt", initialPrompt);
            appendParam(params, "submit", "true");
        }

        String url = baseUrl + "/c/new" + (params.length() > 0 ? "?" + params : "");

        if (url.length() > MAX_URL_LENGTH) {
            navigateAndInjectAfterLoad(baseUrl + "/c/new", initialPrompt);
        } else {
            browser.setUrl(url);
        }
    }

    /** Reload the current page. */
    public void refresh() {
        runIfNotDisposed(() -> browser.refresh());
    }

    /** Navigate to the new-chat URL. */
    public void navigateToNewChat() {
        runIfNotDisposed(() -> browser.setUrl(Activator.getLibreChatUrl() + "/c/new"));
    }

    // ──────────────────────────────────────────────────────────
    // Textarea injection
    // ──────────────────────────────────────────────────────────

    /**
     * Inject text into the LibreChat textarea.
     * Uses the native input value setter to trigger React's change detection.
     */
    public void injectIntoTextarea(String text) {
        if (browser.isDisposed() || text == null) return;

        String js = buildTextareaInjectionJs(escapeJsTemplateString(text));

        browser.getDisplay().asyncExec(() -> {
            if (!browser.isDisposed()) {
                browser.execute(js);
            }
        });
    }

    /**
     * Install a submit interceptor in the LibreChat page.
     * When the user sends a message, the interceptor silently appends the current
     * Eclipse file context (stored in window.__eclipseCtx) to the message.
     * Must be called after every page load.
     */
    public void installContextInterceptor() {
        String js = "(function() {"
            + "if (window.__eclipseInterceptorInstalled) return;"
            + "window.__eclipseInterceptorInstalled = true;"
            + "window.__eclipseCtx = null;"
            + ""
            + "function isCodeRelated(text) {"
            + "  if (!text || !text.trim()) return false;"
            + "  var t = text.toLowerCase();"
            + "  if (t.includes('?')) return true;"
            + "  var kw = ['erkl','was macht','was ist','was sind','was bedeutet','wie funktioniert',"
            + "    'zeig','fehler','bug','problem','fix','refactor','verbessere','ändere','optimiere',"
            + "    'diese','dieser','dieses','aktuell','geöffnet','aktiv',"
            + "    'code','abap','tabelle','table','field','feld','spalte','column',"
            + "    'methode','klasse','funktion','function','class','method',"
            + "    'select','define','cds','annotation','association','join',"
            + "    'kommentier','dokumentier','test','performance','laufzeit'];"
            + "  for (var i=0; i<kw.length; i++) { if (t.includes(kw[i])) return true; }"
            + "  return false;"
            + "}"
            + ""
            + "function appendCtx(textarea) {"
            + "  if (!window.__eclipseCtx || !textarea) return;"
            + "  var msg = textarea.value;"
            + "  if (!msg.trim() || !isCodeRelated(msg)) return;"
            + "  var ctx = window.__eclipseCtx;"
            + "  var block = '\\n\\n---';"
            + "  if (ctx.sap) block += '\\n**SAP:** ' + ctx.sap;"
            + "  block += '\\n**Datei:** ' + ctx.name;"
            + "  if (ctx.path) block += ' (`' + ctx.path + '`)';"
            + "  if (ctx.content) block += '\\n```' + (ctx.lang || '') + '\\n' + ctx.content + '\\n```';"
            + "  var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;"
            + "  setter.call(textarea, msg + block);"
            + "  textarea.dispatchEvent(new Event('input', { bubbles: true }));"
            + "}"
            + ""
            + "function getTextarea() {"
            + "  return document.querySelector('[data-testid=\"text-input\"]') || document.querySelector('textarea');"
            + "}"
            + ""
            + "document.addEventListener('keydown', function(e) {"
            + "  if (e.key === 'Enter' && !e.shiftKey && document.activeElement === getTextarea()) {"
            + "    appendCtx(getTextarea());"
            + "  }"
            + "}, true);"
            + ""
            + "document.addEventListener('pointerdown', function(e) {"
            + "  if (e.target.closest('[data-testid=\"send-button\"]') || e.target.closest('button[type=\"submit\"]')) {"
            + "    appendCtx(getTextarea());"
            + "  }"
            + "}, true);"
            + "})();";

        browser.getDisplay().asyncExec(() -> {
            if (!browser.isDisposed()) {
                browser.execute(js);
            }
        });
    }

    /**
     * Update the current Eclipse file context used by the submit interceptor.
     * Call this whenever the active editor changes.
     *
     * @param name     file name (e.g. "a_bksuppl_d.astabldt")
     * @param path     workspace-relative path for read_file, or null for ADT objects
     * @param content  file content (included directly for ADT objects without a workspace path)
     * @param lang     language identifier for syntax highlighting
     */
    public void setCurrentFileContext(String name, String path, String content, String lang, String sapLabel) {
        if (browser.isDisposed()) return;

        String safeName    = escapeJsString(name     != null ? name     : "");
        String safePath    = escapeJsString(path     != null ? path     : "");
        String safeContent = escapeJsString(trimContent(content));
        String safeLang    = escapeJsString(lang     != null ? lang     : "");
        String safeSap     = escapeJsString(sapLabel != null ? sapLabel : "");

        String js = "window.__eclipseCtx = {"
            + "name: '" + safeName + "',"
            + "path: '" + safePath + "',"
            + "content: '" + safeContent + "',"
            + "lang: '" + safeLang + "',"
            + "sap: '" + safeSap + "'"
            + "};";

        browser.getDisplay().asyncExec(() -> {
            if (!browser.isDisposed()) {
                browser.execute(js);
            }
        });
    }

    /** Trim content to a reasonable size to avoid overly large messages. */
    private static String trimContent(String content) {
        if (content == null) return "";
        final int MAX_CHARS = 8000;
        if (content.length() <= MAX_CHARS) return content;
        return content.substring(0, MAX_CHARS) + "\n... (gekürzt)";
    }

    /** Escape for single-quoted JS string (not template literal). */
    private static String escapeJsString(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }

    public Browser getBrowser() {
        return browser;
    }

    // ──────────────────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────────────────

    /**
     * Fallback for long URLs: navigate first, then inject prompt after page load.
     */
    private void navigateAndInjectAfterLoad(String url, String initialPrompt) {
        browser.setUrl(url);

        if (initialPrompt == null || initialPrompt.isEmpty()) return;

        browser.addProgressListener(new ProgressAdapter() {
            @Override
            public void completed(ProgressEvent event) {
                browser.removeProgressListener(this);
                String js = buildTextareaInjectionJs(escapeJsTemplateString(initialPrompt));
                browser.getDisplay().timerExec(POST_LOAD_DELAY_MS, () -> {
                    if (!browser.isDisposed()) {
                        browser.execute(js);
                    }
                });
            }
        });
    }

    /**
     * Build the JavaScript snippet that sets the textarea value and fires an input event.
     * This is the single source of truth for textarea injection — used by both
     * {@link #injectIntoTextarea} and the post-load fallback.
     *
     * @param escapedText text already escaped via {@link #escapeJsTemplateString}
     */
    private static String buildTextareaInjectionJs(String escapedText) {
        return "(function() {"
            + "var el = document.querySelector('[data-testid=\"text-input\"]')"
            + "       || document.querySelector('textarea');"
            + "if (!el) return;"
            + "var setter = Object.getOwnPropertyDescriptor("
            + "  window.HTMLTextAreaElement.prototype, 'value').set;"
            + "setter.call(el, `" + escapedText + "`);"
            + "el.dispatchEvent(new Event('input', { bubbles: true }));"
            + "el.focus();"
            + "})();";
    }

    private static void appendParam(StringBuilder sb, String key, String value) {
        if (sb.length() > 0) sb.append("&");
        sb.append(key).append("=").append(URLEncoder.encode(value, StandardCharsets.UTF_8));
    }

    /**
     * Escape a string for safe embedding inside a JavaScript template literal ({@code `...`}).
     */
    static String escapeJsTemplateString(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("`", "\\`")
                .replace("${", "\\${")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }

    private void runIfNotDisposed(Runnable action) {
        if (!browser.isDisposed()) action.run();
    }
}
