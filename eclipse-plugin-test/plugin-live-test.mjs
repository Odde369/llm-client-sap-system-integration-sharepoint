/**
 * Live integration test — simulates exactly what the Eclipse plugin does:
 *
 *  1. WorkspaceScanner logic  (ABAP type detection, language detection)
 *  2. BrowserBridge logic     (URL building, JS template escaping)
 *  3. filesystem-mcp          (read_file, list_directory via MCP protocol)
 *  4. Playwright UI test      (textarea injection in LibreChat)
 */

import { chromium } from 'playwright';
import http from 'node:http';

const LIBRECHAT_URL = 'http://localhost:3080';
const FILESYSTEM_MCP_URL = 'http://localhost:3213/mcp';

let passed = 0;
let failed = 0;

function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────
// MCP helper (matches SapMcpProxyRegistrar pattern)
// ─────────────────────────────────────────────────
async function mcpRequest(sessionId, method, params, id) {
  const body = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {}, id: id ?? null });
  const res = await fetch(FILESYSTEM_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    body,
  });
  const text = await res.text();
  const m = text.match(/data: (\{.*\})/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

async function mcpInit() {
  const res = await fetch(FILESYSTEM_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1.0' } },
      id: 1,
    }),
  });
  const sid = res.headers.get('mcp-session-id');
  // send initialized notification
  await mcpRequest(sid, 'notifications/initialized', {}, null);
  return sid;
}

// ─────────────────────────────────────────────────
// 1. WorkspaceScanner logic (Java → JS port)
// ─────────────────────────────────────────────────
console.log('\n── 1. WorkspaceScanner Logic ──');

const ABAP_TYPES = [
  ['.clas.testclasses.abap', 'Test Class'],
  ['.clas.abap', 'Class'],
  ['.intf.abap', 'Interface'],
  ['.fugr.abap', 'Function Group'],
  ['.prog.abap', 'Program'],
  ['.ddls.asddls', 'CDS View'],
  ['.bdef.asbdef', 'Behavior Definition'],
];

function getAbapObjectType(filename) {
  const lower = filename.toLowerCase();
  for (const [ext, type] of ABAP_TYPES) {
    if (lower.endsWith(ext)) return type;
  }
  return null;
}

ok('ZCL_HANDLER.clas.abap → Class',         getAbapObjectType('ZCL_HANDLER.clas.abap') === 'Class');
ok('ZIF_API.intf.abap → Interface',          getAbapObjectType('ZIF_API.intf.abap') === 'Interface');
ok('ZCL_HANDLER.clas.testclasses → TestCls', getAbapObjectType('ZCL_TEST.clas.testclasses.abap') === 'Test Class');
ok('ZV_ORDER.ddls.asddls → CDS View',        getAbapObjectType('ZV_ORDER.ddls.asddls') === 'CDS View');
ok('ZI_BEHAV.bdef.asbdef → Behavior Def',   getAbapObjectType('ZI_BEHAV.bdef.asbdef') === 'Behavior Definition');
ok('package.json → null (no ABAP type)',     getAbapObjectType('package.json') === null);

// ─────────────────────────────────────────────────
// 1b. ContextInjector — promptPrefix + code block (Java logic ported)
// ─────────────────────────────────────────────────
console.log('\n── 1b. ContextInjector Logic ──');

function buildPromptPrefix(system, projectTree = '') {
  if (!system) return null;
  let sb = 'Du bist ein SAP ABAP Entwicklungsassistent.\n';
  sb += `SAP System: ${system.sid || system.dest} (Client ${system.client})\n`;
  if (system.host) sb += `Host: ${system.host}\n`;
  if (system.project) sb += `Projekt: ${system.project}\n`;
  sb += '\n';
  sb += "MCP-Server:\n";
  sb += "- 'sap': SAP-System-Zugriff (sap_list_tools, sap_execute)\n";
  sb += "- 'filesystem-mcp' (\"Workspace Files\"): liest/schreibt Dateien unter /workspace\n\n";
  sb += "Dateizugriff: Alle Projektdateien liegen unter /workspace/{Projektname}/.\n";
  sb += "Nutze read_file, list_directory oder search_files um Dateien selbst zu lesen,\n";
  sb += "statt auf den Nutzer zu warten.\n\n";
  if (projectTree) sb += `Projektstruktur:\n${projectTree}`;
  return sb;
}

function buildWorkspacePath(system, fileInfo) {
  if (!fileInfo?.path || !system?.project) return null;
  return `/workspace/${system.project}/${fileInfo.path}`;
}

function buildCodeBlock(system, fileInfo, code) {
  let sb = '';
  if (system) sb += `**SAP System: ${system.sid} (system='${system.dest}')**\n`;
  if (fileInfo) {
    const wpath = buildWorkspacePath(system, fileInfo);
    sb += `**Datei: ${fileInfo.name}**`;
    if (wpath) sb += ` (\`${wpath}\`)`;
    else if (fileInfo.path) sb += ` (${fileInfo.path})`;
    sb += '\n';
  }
  sb += `\n\`\`\`${fileInfo?.lang || ''}\n${code}\n\`\`\`\n`;
  return sb;
}

const testSystem = { sid: 'AE1', dest: 'AE1_200', client: '200', host: 'ae1.corp', project: 'ACME_ERP' };
const testFile   = { name: 'ZCL_HANDLER.clas.abap', path: 'src/ZCL_HANDLER.clas.abap', lang: 'abap' };

const prefix = buildPromptPrefix(testSystem);
ok("promptPrefix references 'sap' MCP server",    prefix.includes("'sap'"));
ok("promptPrefix references 'filesystem-mcp'",    prefix.includes("filesystem-mcp"));
ok("promptPrefix has /workspace path hint",        prefix.includes("/workspace/{Projektname}"));
ok("promptPrefix has NO 'sap-multi' reference",   !prefix.includes("sap-multi"));
ok("promptPrefix has NO system-parameter hint",   !prefix.includes("system-Parameter"));

const codeBlock = buildCodeBlock(testSystem, testFile, 'METHOD do_it.\nENDMETHOD.');
ok("code block has workspace path",               codeBlock.includes('/workspace/ACME_ERP/src/ZCL_HANDLER'));
ok("code block has abap syntax highlight",        codeBlock.includes('```abap'));

// ─────────────────────────────────────────────────
// 2. BrowserBridge logic — URL building + JS escape
// ─────────────────────────────────────────────────
console.log('\n── 2. BrowserBridge Logic ──');

function escapeJsTemplateString(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function buildNewChatUrl(baseUrl, agentId, promptPrefix) {
  const params = new URLSearchParams();
  if (agentId) params.set('agent_id', agentId);
  if (promptPrefix) params.set('promptPrefix', promptPrefix);
  const qs = params.toString();
  return `${baseUrl}/c/new${qs ? '?' + qs : ''}`;
}

const escaped = escapeJsTemplateString('Code: `hello`\nLine2\n${expr}');
ok('Backtick escaped',   escaped.includes('\\`'));
ok('Newline escaped',    escaped.includes('\\n'));
ok('Template ${} esc',  escaped.includes('\\${'));

const url = buildNewChatUrl(LIBRECHAT_URL, 'agent_abc123', 'SAP System: AE1\nClient: 200');
ok('URL contains agent_id',     url.includes('agent_id=agent_abc123'));
ok('URL contains promptPrefix', url.includes('promptPrefix='));
ok('URL stays under 2000 chars', url.length < 2000, `length=${url.length}`);
console.log(`     → ${url.substring(0, 120)}...`);

// ─────────────────────────────────────────────────
// 3. filesystem-mcp — exactly what agent does after plugin sends file path
// ─────────────────────────────────────────────────
console.log('\n── 3. filesystem-mcp (MCP Protocol) ──');

const sid = await mcpInit();
ok('Session initialized', !!sid, `sid=${sid}`);

// list_directory — workspace root
const listResp = await mcpRequest(sid, 'tools/call', { name: 'list_directory', arguments: { path: '/workspace' } }, 10);
const listText = listResp?.result?.content?.[0]?.text ?? '';
ok('list_directory returns content', listText.length > 0);
ok('Eclipse .metadata visible',     listText.includes('.metadata'));

// read_file — an actual file
const readResp = await mcpRequest(sid, 'tools/call', { name: 'read_file', arguments: { path: '/workspace/.metadata/version.ini' } }, 11);
const fileContent = readResp?.result?.content?.[0]?.text ?? '';
ok('read_file returns content',        fileContent.length > 0);
ok('File content is Eclipse metadata', fileContent.includes('org.eclipse.platform'));

// path traversal protection
const traversalResp = await mcpRequest(sid, 'tools/call', { name: 'read_file', arguments: { path: '/../etc/passwd' } }, 12);
const isError = traversalResp?.result?.isError === true;
ok('Path traversal blocked', isError);

// search_files — simulate plugin sending "find all CDS views"
const searchResp = await mcpRequest(sid, 'tools/call', { name: 'search_files', arguments: { path: '/workspace', pattern: '*.asddls' } }, 13);
ok('search_files responds', searchResp?.result !== undefined);

// ─────────────────────────────────────────────────
// 4. Playwright — textarea injection in LibreChat
// ─────────────────────────────────────────────────
console.log('\n── 4. Playwright — LibreChat Textarea Injection ──');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await page.goto(LIBRECHAT_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const title = await page.title();
  ok('LibreChat reachable', title.length > 0, `title="${title}"`);

  // Check if we land on login page or the app
  const currentUrl = page.url();
  const onLoginPage = currentUrl.includes('/login') || currentUrl.includes('microsoft') || currentUrl.includes('openid');
  console.log(`     → Landed on: ${currentUrl.substring(0, 80)}`);

  if (onLoginPage) {
    console.log('     ℹ  OpenID login wall — cannot inject into textarea without auth.');
    console.log('     ℹ  Testing JS injection on a mock textarea instead.');

    // Test the injection JS itself on a synthetic page (same DOM structure as LibreChat)
    await page.setContent(`
      <html><body>
        <textarea data-testid="text-input"></textarea>
        <script>
          // Expose result for Playwright to read
          window._injected = null;
        </script>
      </body></html>
    `);

    const testText = 'SAP System: AE1 (Client 200)\nAktive Datei: /workspace/ACME/ZCL_HANDLER.clas.abap';
    const escaped2 = escapeJsTemplateString(testText);

    // Exactly the JS that BrowserBridge.buildTextareaInjectionJs() generates
    const injectionJs = `(function() {
      var el = document.querySelector('[data-testid="text-input"]')
             || document.querySelector('textarea');
      if (!el) return;
      var setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, \`${escaped2}\`);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.focus();
    })();`;

    await page.evaluate(injectionJs);
    const value = await page.inputValue('textarea');
    ok('JS injection sets textarea value',  value.includes('SAP System: AE1'));
    ok('Multiline text preserved',          value.includes('ZCL_HANDLER.clas.abap'));
    console.log(`     → Textarea value: "${value.substring(0, 60)}..."`);

  } else {
    // Logged in — test against real LibreChat textarea
    try {
      await page.waitForSelector('[data-testid="text-input"], textarea', { timeout: 8000 });
      const testText = 'SAP System: AE1 (Client 200)\nAktive Datei: /workspace/ACME/ZCL_HANDLER.clas.abap';
      const escaped2 = escapeJsTemplateString(testText);
      const injectionJs = `(function() {
        var el = document.querySelector('[data-testid="text-input"]') || document.querySelector('textarea');
        if (!el) return;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, \`${escaped2}\`);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.focus();
      })();`;
      await page.evaluate(injectionJs);
      const value = await page.inputValue('[data-testid="text-input"], textarea');
      ok('JS injection into LibreChat textarea', value.includes('SAP System: AE1'));
      console.log(`     → Injected into real LibreChat textarea: "${value.substring(0, 60)}..."`);
    } catch (e) {
      ok('Find textarea in LibreChat', false, e.message);
    }
  }
} catch (e) {
  ok('LibreChat reachable', false, e.message);
} finally {
  await browser.close();
}

// ─────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Ergebnis: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
