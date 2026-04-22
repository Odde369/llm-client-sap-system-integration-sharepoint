const OLLAMA_API_KEY = "260b710d64194672a9baf935fa6497cd.qAaR59yGhACwJ-EgCpJwqVp0";
const MODEL = "deepseek-v3.1:671b-cloud";
const MCP_URL = "http://localhost:4004/mcp";

let sessionId = null;
let msgId = 1;

async function mcpInit() {
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: msgId++, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "full-test", version: "1.0" } } })
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
  const r = await fetch("https://ollama.com/v1/chat/completions", {
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
      if (hasData || nudges >= 2) {
        finalAnswer = msg.content;
        break;
      }
      nudges++;
      messages.push({ role: "user", content: "Rufe jetzt direkt das Tool auf." });
    } else {
      break;
    }
  }

  const status = finalAnswer ? (toolCallLog.length > 0 ? "PASS" : "WARN") : "FAIL";
  results.push({ id, status, prompt, tools: toolCallLog.map(t => t.tool), answer: finalAnswer });

  const icon = status === "PASS" ? "OK " : status === "WARN" ? "?? " : "XX ";
  process.stdout.write(icon + "[" + id + "] " + prompt.substring(0, 65) + "\n");
  if (toolCallLog.length > 0) {
    process.stdout.write("     Tools: " + toolCallLog.map(t => t.tool).join(" -> ") + "\n");
  }
  if (finalAnswer) {
    const lines = finalAnswer.split("\n").slice(0, 6).join(" | ");
    process.stdout.write("     >> " + lines.substring(0, 400) + "\n\n");
  } else {
    process.stdout.write("     >> Keine Antwort!\n\n");
  }
}

await mcpInit();
openaiTools = (await mcpListTools()).map(mcpToOpenAI);

console.log("=== BTP Full Consultant Smoke Test ===");
console.log("Modell: " + MODEL);
console.log("Tools:  " + openaiTools.length);
console.log("");

console.log("--- 1. Account-Struktur ---");
await runTest("A1", "Zeig den Global Account: Name, Status, Lizenztyp.");
await runTest("A2", "Liste alle Subaccounts mit Name, State und Region.");
await runTest("A3", "Gibt es Directories im Global Account?");

console.log("--- 2. Entitlements ---");
await runTest("E1", "Wie viele Services sind entitledt? Zeige die ersten 10 als Liste.");
await runTest("E2", "Ist SAP Integration Suite entitledt?");
await runTest("E3", "Welche HANA-Cloud-Services sind entitledt?");

console.log("--- 3. SaaS-Subscriptions ---");
await runTest("S1", "Zeige alle aktiven SaaS-Subscriptions als Tabelle mit Subaccount und URL.");
await runTest("S2", "In welchen Subaccounts ist SAP Build Work Zone subscribed?");

console.log("--- 4. Cloud Foundry Uebersicht ---");
await runTest("CF1", "Welche CF-Organisationen gibt es?");
await runTest("CF2", "Liste alle CF-Spaces mit Org-Zuordnung.");
await runTest("CF3", "Zeige alle laufenden (STARTED) CF-Apps als Tabelle mit Space und Org.");

console.log("--- 5. CF App Details ---");
await runTest("CF4", "Wie viel Memory nutzt keymanagement-srv? Zeige Prozess-Details.");
await runTest("CF5", "Welche Routes/URLs hat die App businessbike-srv?");
await runTest("CF6", "Welche Events gibt es fuer vacationmanagement-srv? Gab es Abstuerze?");

console.log("--- 6. CF Services ---");
await runTest("CF7", "Zeige alle CF Service Instances. Wie viele XSUAA-Instanzen gibt es?");
await runTest("CF8", "Welche Service Bindings hat die App keymanagement-srv in dev?");

console.log("--- 7. CF Infrastruktur ---");
await runTest("CF9", "Welche Org-Quotas (Memory-Limits) sind konfiguriert?");
await runTest("CF10", "Welche CF-Routing-Domains sind verfuegbar?");

console.log("--- 8. Security ---");
await runTest("SEC1", "Welche User gibt es im Global Account?");
await runTest("SEC2", "Welche Role Collections gibt es im Global Account?");

console.log("--- 9. Provisioning & Events ---");
await runTest("P1", "Zeige die letzten BTP Audit-Events.");

console.log("--- 10. Multi-Step Analysen ---");
await runTest("M1", "Laeuft onboarding-srv? Wenn ja, zeige ihre Routes und letzten Events.");
await runTest("M2", "Welche Services sind an checklist-srv gebunden?");
await runTest("M3", "Landscape-Ueberblick: Global Account + Anzahl Subaccounts + Anzahl laufende CF-Apps.");

console.log("=".repeat(60));
console.log("ZUSAMMENFASSUNG");
console.log("=".repeat(60));
const passed = results.filter(r => r.status === "PASS").length;
const warned = results.filter(r => r.status === "WARN").length;
const failed = results.filter(r => r.status === "FAIL").length;
console.log("OK  (Tool-Call + Antwort): " + passed + "/" + results.length);
console.log("??  (nur Text, kein Tool): " + warned + "/" + results.length);
console.log("XX  (Fehlgeschlagen):      " + failed + "/" + results.length);
console.log("");
if (warned + failed > 0) {
  console.log("Nicht bestandene Tests:");
  results.filter(r => r.status !== "PASS").forEach(r => {
    console.log("  " + r.status + " [" + r.id + "] " + r.prompt.substring(0, 70));
    if (r.tools.length) console.log("       Tools: " + r.tools.join(", "));
  });
}
