import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadSystems, startWatcher, shutdownAll, listSystems, getClient, registerSystem, setCurrentSystem, getCurrentSystemId } from './vsp-pool.js';

/**
 * Dynamic SAP MCP Proxy
 *
 * Exposes a single MCP server that routes tool calls to the correct
 * vsp child process based on a `system` parameter.
 *
 * Works with:
 * - Eclipse Plugin (system auto-detected from ADT project)
 * - Browser (user calls sap_list_systems, then sap_execute with system ID)
 * - Any MCP client
 *
 * @module sap-mcp-proxy
 */

const PORT = parseInt(process.env.MCP_PROXY_PORT || '3000', 10);

// ──────────────────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────────────────

loadSystems();
startWatcher();

// ──────────────────────────────────────────────────────────
// MCP server factory (one instance per session)
// ──────────────────────────────────────────────────────────

function createMcpServer() {
  const server = new McpServer({
    name: 'sap-mcp-proxy',
    version: '1.0.0',
  });

  server.resource(
    'systems',
    'sap://systems',
    async () => ({
      contents: [{
        uri: 'sap://systems',
        mimeType: 'application/json',
        text: JSON.stringify(listSystems(), null, 2),
      }],
    }),
  );

  server.tool(
    'sap_list_systems',
    'List all configured SAP systems with their IDs, labels, and connection details.',
    {},
    async () => {
      const systems = listSystems();
      if (systems.length === 0) {
        return textResult('No SAP systems configured. Open an ABAP project in Eclipse to auto-register a system.');
      }
      const current = getCurrentSystemId();
      const lines = systems.map(s =>
        `- **${s.id}**: ${s.label} (${s.url}, Client ${s.client})${s.id === current ? ' ← active' : ''}`
      );
      return textResult(`Available SAP systems:\n${lines.join('\n')}`);
    },
  );

  server.tool(
    'sap_execute',
    'Execute a SAP tool. Omit "system" to use the currently active system (set automatically by Eclipse). Pass "system" explicitly to target a specific system.',
    {
      system: z.string().optional().describe('SAP system ID. If omitted, uses the active system from Eclipse.'),
      tool: z.string().describe('The vsp tool name to execute (e.g. "read_abap_source"). Use sap_list_tools to see available tools.'),
      arguments: z.record(z.unknown()).optional().describe('Arguments to pass to the vsp tool as a JSON object.'),
    },
    async ({ system, tool, arguments: toolArgs }) => {
      const systemId = system ?? getCurrentSystemId();
      if (!systemId) {
        return textResult('No active SAP system. Open an ABAP project in Eclipse or specify a system ID explicitly.');
      }
      try {
        const entry = await getClient(systemId);
        return await entry.client.callTool({ name: tool, arguments: toolArgs ?? {} });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    'sap_list_tools',
    'List all available tools for a SAP system. Omit "system" to use the active system from Eclipse.',
    {
      system: z.string().optional().describe('SAP system ID. If omitted, uses the active system from Eclipse.'),
    },
    async ({ system }) => {
      const systemId = system ?? getCurrentSystemId();
      if (!systemId) {
        return textResult('No active SAP system. Open an ABAP project in Eclipse or specify a system ID explicitly.');
      }
      try {
        const entry = await getClient(systemId);
        const tools = entry.tools ?? [];
        if (tools.length === 0) {
          return textResult(`System ${systemId}: No tools available.`);
        }
        const lines = tools.map(t => `- **${t.name}**: ${t.description ?? '(no description)'}`);
        return textResult(`Tools available on ${systemId} (${tools.length}):\n${lines.join('\n')}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

// ──────────────────────────────────────────────────────────
// HTTP server
// ──────────────────────────────────────────────────────────

/** @type {Map<string, { transport: StreamableHTTPServerTransport, server: McpServer }>} */
const sessions = new Map();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', systems: listSystems().length });
    return;
  }

  if (url.pathname === '/mcp') {
    await handleMcpRequest(req, res);
    return;
  }

  if (url.pathname === '/register-system' && req.method === 'POST') {
    await handleRegisterSystem(req, res);
    return;
  }

  if (url.pathname === '/set-current-system' && req.method === 'POST') {
    await handleSetCurrentSystem(req, res);
    return;
  }

  sendJson(res, 404, { error: 'Not found. Use /mcp for MCP endpoint or /health for status.' });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[sap-mcp-proxy] Listening on port ${PORT}`);
  console.log(`[sap-mcp-proxy] MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`[sap-mcp-proxy] Health check: http://0.0.0.0:${PORT}/health`);
});

// ──────────────────────────────────────────────────────────
// MCP request handling
// ──────────────────────────────────────────────────────────

/**
 * Handle an incoming MCP HTTP request.
 * Reuses existing session transport when mcp-session-id header is present,
 * otherwise creates a new McpServer + transport pair for the new session.
 */
async function handleMcpRequest(req, res) {
  try {
    const sessionId = req.headers['mcp-session-id'];

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — reuse transport directly
      const { transport } = sessions.get(sessionId);
      await transport.handleRequest(req, res);
      return;
    }

    // New session — create a fresh server + transport pair
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, server });
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[mcp] Request error:', err.message);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message });
    }
  }
}

/**
 * Handle POST /register-system from the Eclipse plugin.
 * URL is optional — falls back to SAP_URL env var so Eclipse only needs the destination name.
 */
async function handleRegisterSystem(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { id, label, url: systemUrl, client, insecure } = JSON.parse(body);
      if (!id) {
        sendJson(res, 400, { error: '"id" is required' });
        return;
      }
      const resolvedUrl = systemUrl || process.env.SAP_URL;
      if (!resolvedUrl) {
        sendJson(res, 400, { error: 'No URL provided and SAP_URL env var not set' });
        return;
      }
      registerSystem(id, {
        label: label || id,
        url: resolvedUrl,
        client: client || process.env.SAP_CLIENT || '001',
        user: process.env.SAP_TECH_USER || process.env.SAP_USER,
        password: process.env.SAP_TECH_PASSWORD || process.env.SAP_PASSWORD,
        insecure: insecure ?? (process.env.SAP_INSECURE === 'true'),
        readOnly: true,
        mode: 'focused',
      });
      sendJson(res, 200, { status: 'registered', id, url: resolvedUrl });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
}

/**
 * Handle POST /set-current-system from the Eclipse plugin.
 * Switches the active system whenever the user opens a different ABAP project.
 * Auto-registers the system using SAP_URL env var if not yet known.
 */
async function handleSetCurrentSystem(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { id } = JSON.parse(body);
      if (!id) {
        sendJson(res, 400, { error: '"id" is required' });
        return;
      }
      // Auto-register with env-var URL if system isn't known yet
      if (!listSystems().find(s => s.id === id)) {
        const fallbackUrl = process.env.SAP_URL;
        if (fallbackUrl) {
          registerSystem(id, {
            label: id,
            url: fallbackUrl,
            client: process.env.SAP_CLIENT || '001',
            user: process.env.SAP_TECH_USER || process.env.SAP_USER,
            password: process.env.SAP_TECH_PASSWORD || process.env.SAP_PASSWORD,
            insecure: process.env.SAP_INSECURE === 'true',
            readOnly: true,
            mode: 'focused',
          });
        }
      }
      setCurrentSystem(id);
      sendJson(res, 200, { status: 'ok', current: id });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

/** Build a standard MCP text content result. */
function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

/** Build an MCP error result from an Error object. */
function errorResult(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}

/** Send a JSON HTTP response. */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ──────────────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[sap-mcp-proxy] ${signal} received — shutting down`);
  shutdownAll();
  httpServer.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
