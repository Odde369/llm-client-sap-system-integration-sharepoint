import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Pool of vsp MCP client processes — one per SAP system.
 *
 * Processes are spawned on-demand and killed after an idle timeout.
 * The systems.json config is hot-reloaded on file change.
 *
 * @module vsp-pool
 */

/** How long an idle vsp process lives before being recycled. */
const IDLE_TIMEOUT_MS = parseInt(process.env.VSP_IDLE_TIMEOUT_MS || '600000', 10);

/** Path to the systems configuration file. */
const SYSTEMS_PATH = process.env.SYSTEMS_PATH || '/app/systems.json';

/**
 * @typedef {object} PoolEntry
 * @property {object} config    - The system config from systems.json
 * @property {Client} client    - Connected MCP client
 * @property {StdioClientTransport} transport
 * @property {Array}  tools     - Cached tool definitions
 * @property {ReturnType<typeof setTimeout>|null} timer - Idle kill timer
 */

/** @type {Map<string, PoolEntry>} */
const pool = new Map();

/** @type {Record<string, object>} */
let systemConfigs = {};

/** ID of the currently active system (set by Eclipse on project switch). */
let currentSystemId = null;

// ──────────────────────────────────────────────────────────
// Config loading
// ──────────────────────────────────────────────────────────

/**
 * Load systems.json, expanding `${ENV_VAR}` placeholders from process.env.
 * Kills pool entries whose system was removed from config.
 */
export function loadSystems() {
  try {
    const raw = readFileSync(SYSTEMS_PATH, 'utf-8');
    const expanded = raw.replace(
      /\$\{([A-Z_][A-Z0-9_]*)}/g,
      (_, key) => process.env[key] ?? '',
    );
    const parsed = JSON.parse(expanded);
    systemConfigs = parsed.systems ?? {};

    const ids = Object.keys(systemConfigs);
    console.log(`[vsp-pool] Loaded ${ids.length} system(s): ${ids.join(', ')}`);

    // Kill processes for removed systems
    for (const id of pool.keys()) {
      if (!(id in systemConfigs)) {
        console.log(`[vsp-pool] System ${id} removed — stopping process`);
        destroyEntry(id);
      }
    }
  } catch (err) {
    console.error('[vsp-pool] Failed to load systems.json:', err.message);
  }
}

/** Start polling systems.json for changes. */
export function startWatcher() {
  watchFile(SYSTEMS_PATH, { interval: 2000 }, () => {
    console.log('[vsp-pool] systems.json changed — reloading');
    loadSystems();
  });
}

/** Stop the file watcher. */
export function stopWatcher() {
  unwatchFile(SYSTEMS_PATH);
}

// ──────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────

/**
 * List all configured systems (without spawning anything).
 * @returns {Array<{id: string, label: string, url: string, client: string}>}
 */
export function listSystems() {
  return Object.entries(systemConfigs).map(([id, cfg]) => ({
    id,
    label: cfg.label || id,
    url: cfg.url,
    client: cfg.client || '001',
  }));
}

/**
 * Get or spawn an MCP client for the given system.
 * Resets the idle timer on every call.
 *
 * @param {string} systemId
 * @returns {Promise<PoolEntry>}
 * @throws {Error} if the system ID is unknown
 */
export async function getClient(systemId) {
  if (!(systemId in systemConfigs)) {
    const available = Object.keys(systemConfigs).join(', ') || '(none)';
    throw new Error(`Unknown SAP system: "${systemId}". Available: ${available}`);
  }

  const existing = pool.get(systemId);
  if (existing?.client) {
    resetIdleTimer(systemId);
    return existing;
  }

  return spawnVsp(systemId);
}

/** Shutdown all processes and stop the watcher. */
export function shutdownAll() {
  for (const id of [...pool.keys()]) {
    destroyEntry(id);
  }
  stopWatcher();
}

/**
 * Set the currently active SAP system (called by Eclipse on project switch).
 * @param {string|null} id - System ID, or null to clear.
 */
export function setCurrentSystem(id) {
  currentSystemId = id;
  const known = id !== null && id in systemConfigs;
  console.log(`[vsp-pool] Current system: ${id ?? '(none)'}${known ? '' : ' (not yet in systems.json)'}`);
}

/** Return the ID of the currently active system, or null. */
export function getCurrentSystemId() {
  return currentSystemId;
}

/**
 * Dynamically register a SAP system at runtime (no systems.json edit required).
 * Called by the Eclipse plugin via POST /register-system.
 * Existing pool entries for this system are kept; a new one is spawned on next use.
 *
 * @param {string} id     - System ID (e.g. the ADT destination name)
 * @param {object} config - { url, client, label?, user?, password?, insecure?, readOnly?, mode? }
 */
export function registerSystem(id, config) {
  const existing = JSON.stringify(systemConfigs[id]);
  const incoming = JSON.stringify(config);
  if (existing === incoming) return; // no change

  // If URL changed, kill the old process so next call spawns fresh
  if (pool.has(id) && systemConfigs[id]?.url !== config.url) {
    console.log(`[vsp-pool] ${id} URL changed — restarting process`);
    destroyEntry(id);
  }

  systemConfigs[id] = config;
  console.log(`[vsp-pool] Registered system: ${id} -> ${config.url}`);
  // Auto-set as current if nothing is active yet
  if (currentSystemId === null) {
    currentSystemId = id;
    console.log(`[vsp-pool] Current system auto-set to: ${id}`);
  }
}

// ──────────────────────────────────────────────────────────
// Process lifecycle
// ──────────────────────────────────────────────────────────

/**
 * Spawn a vsp child process and connect an MCP client to it.
 * @param {string} systemId
 * @returns {Promise<PoolEntry>}
 */
async function spawnVsp(systemId) {
  const cfg = systemConfigs[systemId];
  if (!cfg?.url) {
    throw new Error(`System "${systemId}" has no URL configured`);
  }

  console.log(`[vsp-pool] Spawning vsp for ${systemId} -> ${cfg.url}`);

  const args = buildVspArgs(cfg);

  const transport = new StdioClientTransport({ command: 'vsp', args });
  const client = new Client({
    name: `sap-mcp-proxy-${systemId}`,
    version: '1.0.0',
  });

  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(`Failed to connect to vsp for system "${systemId}": ${err.message}`);
  }

  // Discover available tools
  let tools = [];
  try {
    const result = await client.listTools();
    tools = result.tools ?? [];
  } catch (err) {
    console.warn(`[vsp-pool] ${systemId}: Failed to list tools: ${err.message}`);
  }
  console.log(`[vsp-pool] ${systemId}: ${tools.length} tools available`);

  /** @type {PoolEntry} */
  const entry = { config: cfg, client, transport, tools, timer: null };
  pool.set(systemId, entry);
  resetIdleTimer(systemId);

  // Clean up pool on unexpected process exit
  transport.onclose = () => {
    console.log(`[vsp-pool] ${systemId} transport closed`);
    pool.delete(systemId);
  };

  return entry;
}

/**
 * Build the vsp CLI argument array from a system config object.
 * @param {object} cfg
 * @returns {string[]}
 */
function buildVspArgs(cfg) {
  const args = [
    '--url', cfg.url,
    '--client', cfg.client || '001',
    '--mode', cfg.mode || 'focused',
  ];

  if (cfg.user) args.push('--user', cfg.user);
  if (cfg.password) args.push('--password', cfg.password);
  if (cfg.insecure) args.push('--insecure');
  if (cfg.readOnly !== false) args.push('--read-only');
  if (cfg.extraArgs) {
    args.push(...cfg.extraArgs.split(/\s+/).filter(Boolean));
  }

  return args;
}

/** Reset (or start) the idle timeout for a pool entry. */
function resetIdleTimer(systemId) {
  const entry = pool.get(systemId);
  if (!entry) return;

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    console.log(`[vsp-pool] ${systemId} idle timeout — stopping process`);
    destroyEntry(systemId);
  }, IDLE_TIMEOUT_MS);
}

/** Gracefully close a pool entry and remove it from the pool. */
function destroyEntry(systemId) {
  const entry = pool.get(systemId);
  if (!entry) return;

  if (entry.timer) clearTimeout(entry.timer);

  try {
    entry.client.close();
  } catch {
    // already closed or errored — nothing to do
  }

  pool.delete(systemId);
}
