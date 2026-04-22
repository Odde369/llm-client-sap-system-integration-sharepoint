'use strict';
/**
 * ollama-proxy — MIT License
 *
 * Transparent OpenAI-compatible API proxy.
 *
 * Core mechanism: inject a synthetic `__respond__` tool into every tool-enabled
 * request and set tool_choice="required". This forces DeepSeek (and similar models)
 * to always emit a tool call — either a real BTP tool call OR __respond__ for the
 * final answer — instead of outputting planning text with finish_reason=stop.
 *
 * __respond__ interception: when the model calls __respond__, the proxy converts
 * the tool call back to a plain text response before returning to LibreChat.
 *
 * Also detects when a model writes tool calls as plain text (finish_reason: "stop")
 * and converts them to proper tool_calls before returning to LibreChat.
 *
 * Handles both streaming (SSE) and non-streaming responses correctly.
 */

const http           = require('http');
const https          = require('https');
const { URL }        = require('url');

const UPSTREAM_BASE = process.env.UPSTREAM_BASE || 'https://ollama.com';
const PORT          = parseInt(process.env.PORT || '4010', 10);

// ─── __respond__ Tool Definition ─────────────────────────────────────────────

const RESPOND_TOOL_NAME = '__respond__';

const RESPOND_TOOL = {
  type: 'function',
  function: {
    name: RESPOND_TOOL_NAME,
    description:
      'Rufe dieses Tool auf wenn du ALLE benötigten Daten gesammelt hast und ' +
      'die finale Antwort formatiert zeigen willst. ' +
      'Für Datenabruf echte Tools nutzen. Dieses Tool NUR für die fertige Antwort mit Tabellen und Fazit. ' +
      'NIEMALS für :::artifact Blöcke verwenden — Artifacts immer als direkten Text ausgeben.',
    parameters: {
      type: 'object',
      properties: {
        answer: {
          type: 'string',
          description: 'Die vollständige formatierte Antwort auf Deutsch mit Tabellen und Fazit. KEIN :::artifact Inhalt.',
        },
      },
      required: ['answer'],
    },
  },
};

// ─── Request Injection ────────────────────────────────────────────────────────

/**
 * Inject __respond__ tool and set tool_choice="required" into the request body.
 * Returns the modified Buffer, or the original if injection is not applicable.
 */
function injectRespondTool(reqBodyStr) {
  try {
    const data = JSON.parse(reqBodyStr);
    if (!Array.isArray(data.tools) || data.tools.length === 0) return null;

    // Don't double-inject
    if (data.tools.some(t => t.function?.name === RESPOND_TOOL_NAME)) return null;

    data.tools = [...data.tools, RESPOND_TOOL];
    // Note: tool_choice="required" causes empty responses from DeepSeek — leave as-is (auto)

    return Buffer.from(JSON.stringify(data), 'utf8');
  } catch (_) { return null; }
}

// ─── Text-format Tool Call Parsers ───────────────────────────────────────────

function extractKnownToolNames(reqBodyStr) {
  try {
    const data = JSON.parse(reqBodyStr);
    return new Set((data.tools || []).map(t => t.function?.name).filter(Boolean));
  } catch (_) { return new Set(); }
}

function parseTextToolCalls(content, knownTools) {
  // Pattern 1: Hermes XML — <tool_call>{...}</tool_call>
  // Supports both {"name":...} and {"tool_call_name":...} field conventions
  const hermesRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const hermesResults = [];
  let m;
  while ((m = hermesRe.exec(content)) !== null) {
    try {
      const data = JSON.parse(m[1].trim());
      const name = data.name || data.function?.name || data.tool_call_name || data.tool_name;
      const args = data.arguments ?? data.function?.arguments ?? data.parameters
                ?? data.tool_call_arguments ?? data.tool_arguments ?? {};
      if (name && name !== RESPOND_TOOL_NAME && (knownTools.size === 0 || knownTools.has(name))) {
        hermesResults.push({ name, arguments: args });
      }
    } catch (_) {}
  }
  if (hermesResults.length > 0) return hermesResults;

  // Pattern 2: JSON block adjacent to a known tool name
  if (knownTools.size > 0) {
    const jsonBlockRe = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
    while ((m = jsonBlockRe.exec(content)) !== null) {
      const jsonStr = m[1].trim();
      const before  = content.slice(Math.max(0, m.index - 120), m.index);
      const after   = content.slice(m.index + m[0].length,
                                    Math.min(content.length, m.index + m[0].length + 120));
      for (const toolName of knownTools) {
        if (toolName === RESPOND_TOOL_NAME) continue;
        if (before.includes(toolName) || after.includes(toolName)) {
          try { return [{ name: toolName, arguments: JSON.parse(jsonStr) }]; } catch (_) {}
        }
      }
    }
  }

  // Pattern 3: DeepSeek line-based format
  //   tool_call_name: globalAccount_get_mcp_btp-mcp
  //   tool_call_arguments: {}
  // (also handles variants without colon, or with = separator)
  const lineNameRe  = /tool_call_name[:\s=]*([a-zA-Z]\S*)/;
  const lineArgsRe  = /tool_call_arguments[:\s=]*(\{[\s\S]*?\})/;
  const nameMatch = lineNameRe.exec(content);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    let args = {};
    const argsMatch = lineArgsRe.exec(content);
    if (argsMatch) { try { args = JSON.parse(argsMatch[1]); } catch (_) {} }
    if (name !== RESPOND_TOOL_NAME && (knownTools.size === 0 || knownTools.has(name))) {
      return [{ name, arguments: args }];
    }
  }

  // Pattern 4: Bare JSON object {"name":...} or {"tool_call_name":...} as entire content
  try {
    const bare = JSON.parse(content.trim());
    const name = bare.name || bare.tool_call_name || bare.tool_name;
    const args = bare.arguments ?? bare.tool_call_arguments ?? bare.parameters ?? {};
    if (name && name !== RESPOND_TOOL_NAME && (knownTools.size === 0 || knownTools.has(name))) {
      return [{ name, arguments: args }];
    }
  } catch (_) {}

  // Pattern 5: Planning-text keyword match
  // When model writes pure planning text ("Schritt 1: ... abrufen") without any tool-call format,
  // extract the first mentioned BTP tool via keyword matching and force-call it with empty args.
  // This is a last-resort fallback — even a wrong tool call keeps the conversation alive.
  if (knownTools.size > 0) {
    const contentLower = content.toLowerCase();

    // Only activate if content looks like planning/transition text (not a final answer)
    const planningWords = [
      'schritt ', 'zuerst', 'zunächst', 'abrufen', 'rufe ich', 'werde ich',
      'ich beginne', 'ich sammle', 'ich hole', 'ich erstelle', 'jetzt rufe', 'beginnen wir',
    ];
    const hasPlanning = planningWords.some(w => contentLower.includes(w));

    // Don't activate if content already looks like a final formatted answer
    const hasFinalAnswer = content.includes('|---|') || contentLower.includes('fazit') ||
                           contentLower.includes('gesamtanzahl') || contentLower.includes('**name**');

    if (hasPlanning && !hasFinalAnswer) {
      const GENERIC = new Set(['list', 'get', 'call', 'type', 'name', 'base', 'mcp']);
      const toolMatches = [];

      for (const toolName of knownTools) {
        if (toolName === RESPOND_TOOL_NAME) continue;
        // Strip _mcp_... suffix and split into keyword parts
        const base  = toolName.replace(/_mcp_.*$/i, '').toLowerCase();
        const parts = base.split('_').filter(p => p.length >= 4 && !GENERIC.has(p));

        let firstPos = Infinity;
        for (const part of parts) {
          const pos = contentLower.indexOf(part);
          if (pos !== -1 && pos < firstPos) firstPos = pos;
        }
        if (firstPos !== Infinity) toolMatches.push({ toolName, pos: firstPos });
      }

      toolMatches.sort((a, b) => a.pos - b.pos);
      if (toolMatches.length > 0) {
        const best = toolMatches[0].toolName;
        console.log(`[proxy] Pattern5 planning→tool: ${best} (pos ${toolMatches[0].pos})`);
        return [{ name: best, arguments: {} }];
      }
    }
  }

  return [];
}

// ─── Response Builders ───────────────────────────────────────────────────────

/** Patch a non-streaming OpenAI JSON response with proper tool_calls. */
function patchJsonResponse(responseData, parsedCalls) {
  const data   = JSON.parse(JSON.stringify(responseData));
  const choice = data.choices?.[0];
  if (!choice) return data;
  choice.finish_reason      = 'tool_calls';
  choice.message.tool_calls = parsedCalls.map((tc, i) => ({
    id: `call_proxy_${Date.now()}_${i}`,
    type: 'function',
    function: {
      name:      tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments),
    },
  }));
  choice.message.content = null;
  return data;
}

/** Build a synthetic SSE stream carrying proper tool_calls. */
function buildToolCallSSE(parsedCalls, refChunk) {
  const id      = refChunk?.id      || `chatcmpl-proxy-${Date.now()}`;
  const model   = refChunk?.model   || '';
  const created = refChunk?.created || Math.floor(Date.now() / 1000);
  const lines   = [];

  // Initial chunk: role: assistant (required by OpenAI SDK parser)
  lines.push('data: ' + JSON.stringify({
    id, model, created, object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }],
  }) + '\n\n');

  for (let i = 0; i < parsedCalls.length; i++) {
    const tc = parsedCalls[i];
    const callId = `call_proxy_${Date.now()}_${i}`;
    const argsStr = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);

    // Chunk: tool call header (name + id)
    lines.push('data: ' + JSON.stringify({
      id, model, created, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {
        tool_calls: [{ index: i, id: callId, type: 'function',
          function: { name: tc.name, arguments: '' } }]
      }, finish_reason: null }],
    }) + '\n\n');

    // Chunk: arguments
    lines.push('data: ' + JSON.stringify({
      id, model, created, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {
        tool_calls: [{ index: i, function: { arguments: argsStr } }]
      }, finish_reason: null }],
    }) + '\n\n');
  }

  // Final chunk: finish_reason: tool_calls
  lines.push('data: ' + JSON.stringify({
    id, model, created, object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  }) + '\n\n');

  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

/**
 * Inject the btp_health_dashboard tool result into an artifact that contains
 * the literal placeholder string "TOOL_JSON_HERE".
 * The tool JSON is safely encoded as JSON.parse("...") so the LLM never has
 * to copy potentially 50 KB of JSON verbatim (which causes bracket errors).
 */
function injectToolJson(content, reqBodyStr) {
  try {
    const reqBody  = JSON.parse(reqBodyStr);
    const messages = reqBody.messages || [];

    // Find the most recent btp_health_dashboard tool result
    let toolData = null;
    const toolMsgs = messages.filter(m => m.role === 'tool');
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.content) {
        try {
          // msg.content can arrive in several formats:
          // 1. Direct JSON string:   '{"timestamp":"...","overall":"HEALTHY",...}'
          // 2. MCP content array:    '[{"type":"text","text":"{...}"}]'
          // 3. Already parsed object (rare)
          const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          let data = null;
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              // MCP format: [{type: "text", text: "..."}]
              const textItem = parsed.find(item => item.type === 'text' && item.text);
              if (textItem) data = JSON.parse(textItem.text);
            } else {
              data = parsed;
            }
          } catch (_) {}

          // Identify btp_health_dashboard result by its shape
          if (data && data.timestamp && data.overall !== undefined && data.subaccounts) {
            toolData = data;           // keep going — take the last occurrence
          }
        } catch (_) {}
      }
    }
    if (!toolData) {
      console.log(`[proxy] injectToolJson: no btp_health_dashboard result found in ${toolMsgs.length} tool message(s)`);
      return null;
    }

    // JSON.stringify(toolData) → valid JSON string
    // JSON.stringify(jsonStr)  → JS string literal with all special chars escaped
    const jsonStr = JSON.stringify(toolData);
    const jsExpr  = `JSON.parse(${JSON.stringify(jsonStr)})`;

    // Strategy 1: replace TOOL_JSON_HERE placeholder (expected case)
    if (content.includes('TOOL_JSON_HERE')) {
      console.log(`[proxy] injectToolJson: replacing TOOL_JSON_HERE (${jsonStr.length} chars)`);
      return content.replace('TOOL_JSON_HERE', jsExpr);
    }

    // Strategy 2: LLM wrote raw JSON inline on the "const RAW = {...};" line.
    // Replace the entire line so truncated / malformed JSON doesn't break Babel.
    const rawLineRe = /^(const RAW\s*=\s*)[\s\S]*?(?:;|$)/m;
    if (rawLineRe.test(content)) {
      console.log(`[proxy] injectToolJson: replacing inline const RAW (LLM wrote JSON directly, ${jsonStr.length} chars)`);
      return content.replace(rawLineRe, `$1${jsExpr};`);
    }

    console.log(`[proxy] injectToolJson: no injection point found`);
    return null;
  } catch (e) {
    console.error('[proxy] injectToolJson error:', e.message);
    return null;
  }
}

/** Build a synthetic SSE stream for a plain text response. */
function buildTextSSE(text, refChunk) {
  const id      = refChunk?.id      || `chatcmpl-proxy-${Date.now()}`;
  const model   = refChunk?.model   || '';
  const created = refChunk?.created || Math.floor(Date.now() / 1000);
  const lines   = [];

  lines.push('data: ' + JSON.stringify({
    id, model, created, object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  }) + '\n\n');

  lines.push('data: ' + JSON.stringify({
    id, model, created, object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  }) + '\n\n');

  lines.push('data: [DONE]\n\n');
  return lines.join('');
}

// ─── SSE Helpers ─────────────────────────────────────────────────────────────

/**
 * Reconstruct full content + finishReason from buffered SSE bytes.
 * Also detects __respond__ tool calls and extracts their answer text.
 */
function parseSSEBuffer(sseBody) {
  let fullContent        = '';
  let finishReason       = null;
  let hasToolCalls       = false;
  let firstChunk         = null;
  const tcNames          = {};  // index → tool name
  const tcArgs           = {};  // index → accumulated arguments string

  for (const raw of sseBody.split('\n\n')) {
    const line = raw.split('\n').find(l => l.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    try {
      const chunk  = JSON.parse(payload);
      if (!firstChunk) firstChunk = chunk;
      const delta  = chunk.choices?.[0]?.delta;
      if (delta?.content)              fullContent  += delta.content;
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
      if (delta?.tool_calls?.length) {
        hasToolCalls = true;
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.function?.name !== undefined)      tcNames[idx] = tc.function.name;
          if (tc.function?.arguments !== undefined) tcArgs[idx]  = (tcArgs[idx] || '') + tc.function.arguments;
        }
      }
    } catch (_) {}
  }

  // Check if __respond__ was called
  let respondText = null;
  for (const [idx, name] of Object.entries(tcNames)) {
    if (name === RESPOND_TOOL_NAME) {
      const argsStr = tcArgs[idx] || '{}';
      try {
        const args = JSON.parse(argsStr);
        respondText = args.answer || args.message || argsStr;
      } catch { respondText = argsStr; }
      break;
    }
  }

  return { fullContent, finishReason, hasToolCalls, firstChunk, respondText };
}

// ─── Proxy Server ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {

  const reqChunks = [];
  req.on('data', chunk => reqChunks.push(chunk));
  req.on('end', () => {
    const reqBodyBuf = Buffer.concat(reqChunks);
    const reqBodyStr = reqBodyBuf.toString('utf8');

    let hasTools         = false;
    let knownTools       = new Set();

    try {
      const reqData = JSON.parse(reqBodyStr);
      hasTools = Array.isArray(reqData.tools) && reqData.tools.length > 0;
      if (hasTools) knownTools = extractKnownToolNames(reqBodyStr);
    } catch (_) {}

    // ── Inject __respond__ tool when request has tools ─────────────────────
    let forwardBodyBuf = reqBodyBuf;
    if (hasTools) {
      const injected = injectRespondTool(reqBodyStr);
      if (injected) {
        forwardBodyBuf = injected;
        console.log(`[proxy] injected __respond__ tool (body ${reqBodyBuf.length}→${injected.length} bytes)`);
      }
    }

    // ── Forward to upstream ───────────────────────────────────────────────
    const upstreamUrl = new URL(req.url, UPSTREAM_BASE);
    const isHttps     = upstreamUrl.protocol === 'https:';
    const protocol    = isHttps ? https : http;

    const upstreamHeaders = { ...req.headers };
    upstreamHeaders['host']           = upstreamUrl.hostname;
    upstreamHeaders['content-length'] = forwardBodyBuf.length;
    delete upstreamHeaders['transfer-encoding'];

    const options = {
      hostname: upstreamUrl.hostname,
      port:     upstreamUrl.port ? parseInt(upstreamUrl.port, 10) : (isHttps ? 443 : 80),
      path:     upstreamUrl.pathname + (upstreamUrl.search || ''),
      method:   req.method,
      headers:  upstreamHeaders,
      timeout:  600000, // 10 min max — prevents infinite hang on slow LLM inference
    };

    const proxyReq = protocol.request(options, proxyRes => {
      if (!hasTools) {
        // ── No tools: pure passthrough (streaming OK) ────────────────────
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      // ── Has tools: inspect response ──────────────────────────────────
      const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
      const isSSE       = contentType.includes('text/event-stream');

      if (isSSE) {
        // ════════════════════════════════════════════════════════════════════
        // SSE STREAMING HANDLER
        //
        // Strategy: detect response type from first meaningful delta:
        //   • tool_calls  → buffer mode  (real tools or __respond__ interception)
        //   • content     → stream mode  (text / artifact — forward in real-time)
        //
        // Benefit: artifact generation (potentially 60–120 s) is streamed
        // token-by-token so the user sees progress immediately.
        //
        // TOOL_DATA_B64 is replaced on-the-fly via a sliding-window replacer.
        // ════════════════════════════════════════════════════════════════════

        const respChunks = [];           // always buffer (needed for buffer-mode fallback)
        let mode = 'pending';            // 'pending' | 'streaming' | 'buffering'
        let sseLineBuf = '';             // partial SSE line accumulator
        let firstChunkMeta = null;       // first parsed chunk (for synthetic SSE later)
        let streamedContent = '';        // accumulated streamed content

        // ── TOOL_DATA_B64 injection (buffer-then-replace) ──────────────────
        // We buffer ALL streaming content and do a single string replacement
        // at the end. This is reliable regardless of how chunks are split.
        const PLACEHOLDER    = 'TOOL_DATA_B64';
        let   rDone          = false;
        let   rValue         = null;
        let   streamBuf      = '';   // buffer for streaming mode

        function getReplacementValue() {
          if (rValue !== null) return rValue;
          try {
            const messages = JSON.parse(reqBodyStr).messages || [];
            let toolData = null;
            for (const msg of messages) {
              if (msg.role !== 'tool' || !msg.content) continue;
              try {
                const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                let data = null;
                try {
                  const parsed = JSON.parse(raw);
                  if (Array.isArray(parsed)) {
                    const item = parsed.find(i => i.type === 'text' && i.text);
                    if (item) data = JSON.parse(item.text);
                  } else { data = parsed; }
                } catch (_) {}
                if (data && data.timestamp && data.overall !== undefined && data.subaccounts) {
                  toolData = data;
                }
              } catch (_) {}
            }
            if (!toolData) { rValue = ''; return ''; }
            const jsonStr = JSON.stringify(toolData);
            rValue = Buffer.from(jsonStr).toString('base64');
            console.log(`[proxy] b64 replacer: encoded ${jsonStr.length} chars → ${rValue.length} b64 chars`);
            return rValue;
          } catch (_) { rValue = ''; return ''; }
        }

        function flushStreamBuf(fr) {
          // Replace placeholder in the fully-buffered content, then send
          let content = streamBuf;
          streamBuf = '';
          console.log(`[proxy] flushStreamBuf: len=${content.length} hasPlaceholder=${content.includes(PLACEHOLDER)} snippet="${content.slice(0,80).replace(/\n/g,'↵')}"`);
          if (content.includes(PLACEHOLDER)) {
            const rep = getReplacementValue();
            if (rep) {
              content = content.replace(PLACEHOLDER, rep);
              rDone = true;
              console.log('[proxy] TOOL_DATA_B64 replaced in buffered content');
            } else {
              console.warn('[proxy] TOOL_DATA_B64: no tool data found');
            }
          }
          if (content) {
            writeContentChunk(content, null);
            streamedContent += content;
          }
          if (fr) writeContentChunk(null, fr);
        }

        // ── Helper: write a content delta to client ─────────────────────────
        function writeContentChunk(content, fr) {
          if (!firstChunkMeta) return;
          const c = {
            id:      firstChunkMeta.id      || `chatcmpl-proxy-${Date.now()}`,
            model:   firstChunkMeta.model   || '',
            created: firstChunkMeta.created || Math.floor(Date.now() / 1000),
            object:  'chat.completion.chunk',
            choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: fr || null }],
          };
          res.write('data: ' + JSON.stringify(c) + '\n\n');
        }

        // ── Per-chunk SSE event processor ──────────────────────────────────
        function handleSSEEvent(eventStr) {
          const dataLine = eventStr.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) return;
          const payload = dataLine.slice(6).trim();
          if (payload === '[DONE]') return; // handled in 'end'

          let chunkData;
          try { chunkData = JSON.parse(payload); } catch (_) { return; }
          if (!firstChunkMeta) firstChunkMeta = chunkData;

          const delta = chunkData.choices?.[0]?.delta;
          const fr    = chunkData.choices?.[0]?.finish_reason;

          if (mode === 'buffering') return; // just collecting in respChunks

          // ── Decide mode from first meaningful delta ──────────────────────
          if (mode === 'pending') {
            if (delta?.tool_calls?.length) {
              // Tool call (real tool or __respond__) → buffer mode
              mode = 'buffering';
              console.log('[proxy] SSE mode=buffering (tool_calls detected)');
              return;
            }
            if (delta?.content) {
              // Text/artifact response → stream mode
              mode = 'streaming';
              if (!res.headersSent) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
              }
              console.log('[proxy] SSE mode=streaming (content detected)');
            } else {
              return; // still pending (e.g. role-only chunk)
            }
          }

          // ── Streaming mode: buffer content, replace+send on finish ─────
          if (mode === 'streaming') {
            if (delta?.content) {
              streamBuf += delta.content;  // accumulate, don't send yet
            }
            if (fr) {
              flushStreamBuf(fr);          // replace placeholder & send all
            }
          }
        }

        // ── Accumulate raw bytes and parse SSE events ───────────────────────
        proxyRes.on('data', rawChunk => {
          respChunks.push(rawChunk);
          sseLineBuf += rawChunk.toString('utf8');
          const events = sseLineBuf.split('\n\n');
          sseLineBuf = events.pop(); // keep incomplete last event
          for (const evt of events) {
            if (evt.trim()) handleSSEEvent(evt);
          }
        });

        proxyRes.on('end', () => {
          // Process any remaining bytes
          if (sseLineBuf.trim()) handleSSEEvent(sseLineBuf);

          if (mode === 'streaming') {
            // Flush any remaining buffered content (e.g. if finish_reason came
            // in a separate [DONE] event without explicit finish_reason chunk)
            if (streamBuf) flushStreamBuf('stop');

            // Inject placeholder if model returned nothing
            if (!streamedContent) {
              writeContentChunk('...', null);
              writeContentChunk(null, 'stop');
            }

            // Log artifact detection post-hoc
            if (streamedContent.includes(':::artifact{')) {
              const m = streamedContent.match(/:::artifact\{[^}]*type="([^"]+)"/);
              console.log(`[proxy] SSE streamed artifact type=${m ? m[1] : 'unknown'} replaced=${rDone} totalLen=${streamedContent.length}`);
            } else {
              console.log(`[proxy] SSE streamed text totalLen=${streamedContent.length}`);
            }

            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          // ── Buffer mode (tool calls) or still pending ─────────────────────
          const respBodyStr = Buffer.concat(respChunks).toString('utf8');
          const { fullContent, finishReason, hasToolCalls, firstChunk, respondText } =
            parseSSEBuffer(respBodyStr);
          if (!firstChunkMeta && firstChunk) firstChunkMeta = firstChunk;

          console.log(`[proxy] SSE buffered hasToolCalls=${hasToolCalls} finishReason=${finishReason} respondText=${respondText !== null} contentLen=${fullContent.length}`);

          // ── __respond__ → convert to text SSE ──────────────────────────
          if (hasToolCalls && respondText !== null) {
            let finalText = respondText;
            if (finalText.includes(PLACEHOLDER)) {
              const rep = getReplacementValue();
              if (rep) { finalText = finalText.replace(PLACEHOLDER, rep); rDone = true; console.log('[proxy] SSE __respond__ TOOL_DATA_B64 replaced'); }
              else { console.warn('[proxy] SSE __respond__ TOOL_DATA_B64: no tool data'); }
            }
            const sse    = buildTextSSE(finalText, firstChunkMeta || firstChunk);
            const sseBuf = Buffer.from(sse, 'utf8');
            console.log(`[proxy] SSE __respond__ → text (${respondText.length} chars)`);
            if (!res.headersSent) {
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'content-length': sseBuf.length });
            }
            res.end(sseBuf);
            return;
          }

          // ── Real tool call → passthrough ──────────────────────────────
          if (hasToolCalls) {
            const origBuf     = Buffer.from(respBodyStr, 'utf8');
            const origHeaders = { ...proxyRes.headers };
            delete origHeaders['transfer-encoding'];
            origHeaders['content-length'] = origBuf.length;
            console.log(`[proxy] SSE tool_calls passthrough bytes=${origBuf.length}`);
            if (!res.headersSent) res.writeHead(proxyRes.statusCode, origHeaders);
            res.end(origBuf);
            return;
          }

          // ── Empty stop → inject placeholder ───────────────────────────
          if (finishReason === 'stop' && !fullContent) {
            console.log('[proxy] SSE empty stop → placeholder');
            const sse    = buildTextSSE('...', firstChunkMeta || firstChunk);
            const sseBuf = Buffer.from(sse, 'utf8');
            if (!res.headersSent) {
              res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'content-length': sseBuf.length });
            }
            res.end(sseBuf);
            return;
          }

          // ── Text with finish_reason=stop: check for text-format tool calls ──
          if (finishReason === 'stop' && fullContent) {
            console.log(`[proxy] SSE buffered content (first 300): ${fullContent.slice(0, 300).replace(/\n/g, '↵')}`);
            const parsed = parseTextToolCalls(fullContent, knownTools);
            if (parsed.length > 0) {
              const sse    = buildToolCallSSE(parsed, firstChunkMeta || firstChunk);
              const sseBuf = Buffer.from(sse, 'utf8');
              console.log(`[proxy] SSE fix → tool_calls: ${parsed.map(t => t.name).join(', ')}`);
              if (!res.headersSent) {
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'content-length': sseBuf.length });
              }
              res.end(sseBuf);
              return;
            }
          }

          // ── Passthrough ────────────────────────────────────────────────
          const origBuf     = Buffer.from(respBodyStr, 'utf8');
          const origHeaders = { ...proxyRes.headers };
          delete origHeaders['transfer-encoding'];
          origHeaders['content-length'] = origBuf.length;
          console.log(`[proxy] SSE passthrough bytes=${origBuf.length}`);
          if (!res.headersSent) res.writeHead(proxyRes.statusCode, origHeaders);
          res.end(origBuf);
        });

        proxyRes.on('error', e => {
          console.error('[proxy] upstream response error:', e.message);
          if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); }
        });

        return; // SSE handler installed — don't fall through to buffer path
      }

      // ── Non-SSE: buffer full response for inspection ──────────────────
      const respChunks = [];
      proxyRes.on('data', c => respChunks.push(c));
      proxyRes.on('end', () => {
        const respBodyStr = Buffer.concat(respChunks).toString('utf8');

        try {
          {  // block to match original structure (was: if (isSSE) { ... } else {
            // ── Non-streaming (JSON) response ───────────────────────────
            const respData = JSON.parse(respBodyStr);
            const choice   = respData.choices?.[0];
            const alreadyHasToolCalls = (choice?.message?.tool_calls?.length ?? 0) > 0;
            const isStop  = choice?.finish_reason === 'stop' || choice?.finish_reason === 'tool_calls';
            const content = choice?.message?.content;

            // Check for __respond__ tool call
            if (alreadyHasToolCalls) {
              const respondCall = choice.message.tool_calls.find(
                tc => tc.function?.name === RESPOND_TOOL_NAME
              );
              if (respondCall) {
                let answer = '';
                try { answer = JSON.parse(respondCall.function.arguments).answer || ''; } catch (_) {
                  answer = respondCall.function.arguments || '';
                }
                const fixed = JSON.parse(JSON.stringify(respData));
                fixed.choices[0].message.content    = answer;
                fixed.choices[0].message.tool_calls = null;
                fixed.choices[0].finish_reason       = 'stop';
                const fixedBuf = Buffer.from(JSON.stringify(fixed), 'utf8');
                console.log(`[proxy] JSON __respond__ → text (${answer.length} chars)`);
                res.writeHead(proxyRes.statusCode, {
                  ...proxyRes.headers,
                  'content-length': fixedBuf.length,
                  'transfer-encoding': undefined,
                });
                res.end(fixedBuf);
                return;
              }
            }

            // Try text-format tool call detection (for models that don't use tool_calls)
            if (!alreadyHasToolCalls && isStop && content) {
              const parsed = parseTextToolCalls(content, knownTools);
              if (parsed.length > 0) {
                const fixed   = patchJsonResponse(respData, parsed);
                const fixedBuf = Buffer.from(JSON.stringify(fixed), 'utf8');
                console.log(`[proxy] JSON fix → tool_calls: ${parsed.map(t => t.name).join(', ')}`);
                res.writeHead(proxyRes.statusCode, {
                  ...proxyRes.headers,
                  'content-length': fixedBuf.length,
                  'transfer-encoding': undefined,
                });
                res.end(fixedBuf);
                return;
              }
            }

            // No fix needed
            const outBuf = Buffer.from(respBodyStr, 'utf8');
            const outHeaders = { ...proxyRes.headers, 'content-length': outBuf.length };
            delete outHeaders['transfer-encoding'];
            res.writeHead(proxyRes.statusCode, outHeaders);
            res.end(outBuf);
          }
        } catch (err) {
          // Parsing error → pass through raw
          console.error('[proxy] parse error:', err.message);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(Buffer.concat(respChunks));
        }
      });

      proxyRes.on('error', e => {
        console.error('[proxy] upstream response error:', e.message);
        if (!res.headersSent) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: { message: e.message } }));
        }
      }); 
    });

    proxyReq.on('timeout', () => {
      console.error('[proxy] upstream request timeout — aborting');
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504);
        res.end(JSON.stringify({ error: { message: 'upstream timeout' } }));
      }
    });

    proxyReq.on('error', e => {
      console.error('[proxy] upstream request error:', e.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });

    proxyReq.write(forwardBodyBuf);
    proxyReq.end();
  });
});

server.listen(PORT, () => {
  console.log(`ollama-proxy listening on :${PORT} → ${UPSTREAM_BASE}`);
});
