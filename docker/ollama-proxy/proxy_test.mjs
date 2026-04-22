/**
 * Proxy smoke test — runs the same consultant suite as smoke_test.mjs
 * but routes ALL LLM calls through ollama-proxy (localhost:4010)
 * instead of Ollama Cloud directly.
 *
 * Run: node proxy_test.mjs
 */
const OLLAMA_API_KEY = "260b710d64194672a9baf935fa6497cd.qAaR59yGhACwJ-EgCpJwqVp0";
const MODEL = "deepseek-v3.1:671b-cloud";
const MCP_URL = "http://localhost:4004/mcp";
const LLM_URL = "http://localhost:4010/v1/chat/completions"; // ← through proxy

let sessionId = null;
let msgId = 1;

async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: msgId++, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proxy-test", version: "1.0" } } })
  });
  sessionId = r.headers.get("mcp-session-id");
  await r.text();
}

async function mcpCall(toolName, args) {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: msgId++, method: "tools/call", params: { name: toolName, arguments: args } })
  });
  const text = await r.text();
  const parsed = JSON.parse(text.replace(/^event:.*\ndata: /, "").trim());
  return parsed.result?.content?.[0]?.text || JSON.stringify(parsed.error);
}

async function mcpListTools() {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: msgId++, method: "tools/list", params: {} })
  });
  const text = await r.text();
  return JSON.parse(text.replace(/^event:.*\ndata: /, "").trim()).result?.tools || [];
}

function mcpToOpenAI(t) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } };
}

const SYSTEM = "Du bist ein SAP BTP Berater mit direktem API-Zugriff.\n" +
  "REGEL: Rufe Tools SOFORT auf - keine Erklaerung, kein 'Ich werde jetzt...'.\n" +
  "Rufe EIN Tool pro Schritt. Nach dem Ergebnis: entweder weiteres Tool oder finale Antwort als Tabelle/Liste.\n" +
  "Antworte auf Deutsch. Zeige immer die echten Daten, niemals nur Zusammenfassungen ohne Daten.";

let openaiTools = [];

async function callLLM(messages) {
  const r = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OLLAMA_API_KEY },
    body: JSON.stringify({ model: MODEL, messages, tools: openaiTools, tool_choice: "auto", parallel_tool_calls: false, stream: false })
  });
  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d.choices?.[0]?.message;
}

const results = [];

async function runTest(id, prompt) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: prompt }
  ];
  const toolCallLog = [];
  let finalAnswer = null;
  let nudges = 0;

  for (let step = 0; step < 12; step++) {
    const msg = await callLLM(messages);
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      nudges = 0;
      const tc = msg.tool_calls[0];
      let args = {};
      try { args = JSON.parse(tc.function.arguments); } catch(e) {}
      const result = await mcpCall(tc.function.name, args);
      toolCallLog.push({ tool: tc.function.name, args: tc.function.arguments, resultLen: result.length });
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });

    } else if (msg.content && msg.content.trim()) {
      const hasData = msg.content.includes("|") || msg.content.includes("SUBSCRIBED") ||
                      msg.content.includes("STARTED") || msg.content.includes("kein") ||
                      msg.content.includes("OK") || msg.content.includes("ACTIVE") ||
                      msg.content.includes("nicht") || msg.content.includes("verfueg") ||
                      toolCallLog.length > 0;
      if (hasData || nudges >= 2) { finalAnswer = msg.content; break; }
      nudges++;
      messages.push({ role: "user", content: "Rufe jetzt direkt das Tool auf." });
    } else { break; }
  }

  const status = finalAnswer ? (toolCallLog.length > 0 ? "PASS" : "WARN") : "FAIL";
  results.push({ id, status, prompt, tools: toolCallLog.map(t => t.tool), answer: finalAnswer });

  const icon = status === "PASS" ? "OK " : status === "WARN" ? "?? " : "XX ";
  process.stdout.write(icon + "[" + id + "] " + prompt.substring(0, 65) + "\n");
  if (toolCallLog.length > 0)
    process.stdout.write("   Tools: " + toolCallLog.map(t => t.tool).join(" -> ") + "\n");
  if (finalAnswer)
    process.stdout.write("   >> " + finalAnswer.substring(0, 300).replace(/\n/g, " ") + "\n\n");
  else
    process.stdout.write("   >> Keine Antwort!\n\n");
}

await mcpInit();
openaiTools = (await mcpListTools()).map(mcpToOpenAI);

console.log("=== Proxy Smoke Test (via ollama-proxy:4010) ===");
console.log("Modell: " + MODEL + " | Tools: " + openaiTools.length + "\n");

console.log("--- Account & Entitlements ---");
await runTest("A1", "Zeig den Global Account: Name, Status, Lizenztyp.");
await runTest("A2", "Liste alle Subaccounts mit Name, State und Region.");
await runTest("E1", "Wie viele Services sind entitledt? Zeige die ersten 10 als Liste.");

console.log("--- SaaS & CF ---");
await runTest("S1", "Zeige alle aktiven SaaS-Subscriptions als Tabelle mit Subaccount und URL.");
await runTest("S2", "In welchen Subaccounts ist SAP Build Work Zone subscribed?");
await runTest("CF3", "Zeige alle laufenden (STARTED) CF-Apps als Tabelle mit Space und Org.");

console.log("--- Details ---");
await runTest("CF9", "Welche Org-Quotas (Memory-Limits) sind konfiguriert?");
await runTest("SEC1", "Welche User gibt es im Global Account?");
await runTest("M3", "Landscape: Global Account Name + Anzahl Subaccounts + Anzahl STARTED CF-Apps.");

console.log("=".repeat(55));
const passed = results.filter(r => r.status === "PASS").length;
const warned = results.filter(r => r.status === "WARN").length;
const failed = results.filter(r => r.status === "FAIL").length;
console.log("OK  (mit Tool-Call): " + passed + "/" + results.length);
console.log("??  (nur Text):      " + warned + "/" + results.length);
console.log("XX  (Fehlgeschlagen):" + failed + "/" + results.length);
if (warned + failed > 0) {
  console.log("\nNicht bestanden:");
  results.filter(r => r.status !== "PASS").forEach(r =>
    console.log("  " + r.status + " [" + r.id + "] " + r.prompt.substring(0, 70)));
}
