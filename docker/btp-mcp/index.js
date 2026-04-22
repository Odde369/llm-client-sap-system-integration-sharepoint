const { randomUUID } = require("crypto");
const { execSync, exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);
const fs = require("fs");

// ─── History Storage ──────────────────────────────────────────────────────────
const HISTORY_FILE = "/data/btp-health-history.json";
const MAX_HISTORY  = 60; // keep up to 60 snapshots

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch (_) { return []; }
}

function saveSnapshot(report) {
  try { fs.mkdirSync("/data", { recursive: true }); } catch (_) {}
  const snap = {
    t:              report.timestamp,
    overall:        report.overall,
    cfTotal:        report.cfApps.total,
    cfStarted:      report.cfApps.started,
    cfStopped:      report.cfApps.stopped,
    cfCrashed:      report.cfApps.crashed,
    quotaCritical:  report.quota.critical.length,
    quotaWarning:   report.quota.warning.length,
    staleBindings:  report.staleBindings.stale,
    globalAdmins:   report.security.globalAdmins.length,
    wastedMemoryMB: report.resources?.wastedMemoryMB ?? 0,
    runningMemoryMB:report.resources?.runningMemoryMB ?? 0,
    udmEntries:     report.finops?.consumption?.totalEntries ?? null,
    zombieSvcCount: report.finops?.zombieServiceInstances?.length ?? 0,
  };
  const history = loadHistory();
  history.push(snap);
  const trimmed = history.slice(-MAX_HISTORY);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed)); } catch (_) {}
  return trimmed;
}

// ─── App Classifier ───────────────────────────────────────────────────────────
const isDeployerApp = n => /deployer|migration|init|setup/i.test(n || "");
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const PORT = parseInt(process.env.PORT || "4004");

// --- BTP CLI (same auth as Terraform BTP provider) ---
// Subdomain derived from token URL: advadesgmbh.authentication.eu10... → advadesgmbh
const BTP_SUBDOMAIN =
  process.env.BTP_GLOBAL_ACCOUNT_SUBDOMAIN ||
  (process.env.BTP_ACCOUNTS_SERVICE_TOKEN_URL
    ? process.env.BTP_ACCOUNTS_SERVICE_TOKEN_URL.replace("https://", "").split(".")[0]
    : null);
const BTP_CLI_URL = process.env.BTP_CLI_URL || "https://cli.btp.cloud.sap";
let btpCliLoggedIn = false;

function btpCliLogin() {
  if (btpCliLoggedIn) return;
  const user = process.env.BTP_USER;
  const pass = process.env.BTP_PASSWORD;
  if (!BTP_SUBDOMAIN || !user || !pass) throw new Error("BTP CLI login requires BTP_USER, BTP_PASSWORD, and BTP_ACCOUNTS_SERVICE_TOKEN_URL (or BTP_GLOBAL_ACCOUNT_SUBDOMAIN)");
  execSync(
    `btp login --url "${BTP_CLI_URL}" --user "${user}" --password "${pass}" --subdomain "${BTP_SUBDOMAIN}"`,
    { timeout: 30000, env: { ...process.env, HOME: "/root" }, stdio: "pipe" }
  );
  btpCliLoggedIn = true;
}

function btpCli(args) {
  try {
    btpCliLogin();
  } catch (e) {
    btpCliLoggedIn = false;
    throw new Error(`BTP CLI login failed: ${e.message}`);
  }
  try {
    const out = execSync(`btp --format json ${args}`, {
      timeout: 60000,
      env: { ...process.env, HOME: "/root" },
      stdio: "pipe",
    });
    return JSON.parse(out.toString());
  } catch (e) {
    // Token may have expired — retry once after re-login
    btpCliLoggedIn = false;
    btpCliLogin();
    const out = execSync(`btp --format json ${args}`, {
      timeout: 60000,
      env: { ...process.env, HOME: "/root" },
      stdio: "pipe",
    });
    return JSON.parse(out.toString());
  }
}

// --- CIS Central (Accounts + Entitlements) ---
const ACCOUNTS_BASE_URL = process.env.BTP_ACCOUNTS_SERVICE_BASE_URL;
const TOKEN_URL = process.env.BTP_ACCOUNTS_SERVICE_TOKEN_URL;
const CLIENT_ID = process.env.BTP_ACCOUNTS_SERVICE_CLIENT_ID;
const CLIENT_SECRET = process.env.BTP_ACCOUNTS_SERVICE_CLIENT_SECRET;
const BTP_USER = process.env.BTP_USER;
const BTP_PASSWORD = process.env.BTP_PASSWORD;

// Entitlements URL: auto-derive from accounts URL if not explicitly set
const ENTITLEMENTS_BASE_URL =
  process.env.BTP_ENTITLEMENTS_SERVICE_BASE_URL ||
  (ACCOUNTS_BASE_URL
    ? ACCOUNTS_BASE_URL.replace("accounts-service", "entitlements-service")
    : undefined);

// --- Service Manager ---
const SM_BASE_URL = process.env.BTP_SM_BASE_URL;
const SM_TOKEN_URL = process.env.BTP_SM_TOKEN_URL;
const SM_CLIENT_ID = process.env.BTP_SM_CLIENT_ID;
const SM_CLIENT_SECRET = process.env.BTP_SM_CLIENT_SECRET;

// --- Usage Data Management (UDM) Service — optional, enables actual consumption data ---
// Create a service instance of "uas" (Usage Data Management) in your global account,
// then set these env vars from the service key credentials.
const UDM_BASE_URL    = process.env.BTP_UDM_BASE_URL;    // e.g. https://uas.cfapps.eu10.hana.ondemand.com
const UDM_TOKEN_URL   = process.env.BTP_UDM_TOKEN_URL;   // uaa.url + /oauth/token
const UDM_CLIENT_ID   = process.env.BTP_UDM_CLIENT_ID;
const UDM_CLIENT_SECRET = process.env.BTP_UDM_CLIENT_SECRET;

// --- Additional CIS Services ---
const EVENTS_BASE_URL =
  process.env.BTP_EVENTS_SERVICE_BASE_URL ||
  (ACCOUNTS_BASE_URL ? ACCOUNTS_BASE_URL.replace("accounts-service", "events-service") : undefined);

const PROVISIONING_BASE_URL =
  process.env.BTP_PROVISIONING_SERVICE_BASE_URL ||
  (ACCOUNTS_BASE_URL ? ACCOUNTS_BASE_URL.replace("accounts-service", "provisioning-service") : undefined);

const SAAS_BASE_URL =
  process.env.BTP_SAAS_REGISTRY_BASE_URL ||
  (ACCOUNTS_BASE_URL ? ACCOUNTS_BASE_URL.replace("accounts-service.cfapps", "saas-manager.cfapps") : undefined);

// --- Cloud Foundry ---
// CF API URL auto-derived from region if not explicitly set (eu10 default)
const CF_API_URL =
  process.env.BTP_CF_API_URL ||
  (ACCOUNTS_BASE_URL
    ? ACCOUNTS_BASE_URL.replace("https://accounts-service.cfapps.", "https://api.cf.").replace(".hana.ondemand.com", ".hana.ondemand.com")
    : "https://api.cf.eu10.hana.ondemand.com");

const CF_UAA_URL =
  process.env.BTP_CF_UAA_URL ||
  CF_API_URL.replace("https://api.cf.", "https://uaa.cf.");

// --- OAuth2 Token Caches ---
const cisTokenCache = { token: null, expiresAt: 0 };
const smTokenCache  = { token: null, expiresAt: 0 };
const cfTokenCache  = { token: null, expiresAt: 0 };
const udmTokenCache = { token: null, expiresAt: 0 };

async function fetchToken(tokenUrl, clientId, clientSecret, cache) {
  if (cache.token && Date.now() < cache.expiresAt) return cache.token;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "password",
    username: BTP_USER,
    password: BTP_PASSWORD,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token fetch failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  cache.token = data.access_token;
  cache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cache.token;
}

async function getCisToken() {
  return fetchToken(TOKEN_URL, CLIENT_ID, CLIENT_SECRET, cisTokenCache);
}

async function getSmToken() {
  if (!SM_TOKEN_URL || !SM_CLIENT_ID || !SM_CLIENT_SECRET) {
    throw new Error(
      "Service Manager credentials not configured. Set BTP_SM_TOKEN_URL, BTP_SM_CLIENT_ID, BTP_SM_CLIENT_SECRET in .env"
    );
  }
  // SM uses client_credentials grant
  if (smTokenCache.token && Date.now() < smTokenCache.expiresAt) return smTokenCache.token;
  const auth = Buffer.from(`${SM_CLIENT_ID}:${SM_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch(SM_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SM token fetch failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  smTokenCache.token = data.access_token;
  smTokenCache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return smTokenCache.token;
}

async function getUdmToken() {
  if (!UDM_TOKEN_URL || !UDM_CLIENT_ID || !UDM_CLIENT_SECRET) {
    throw new Error("UDM credentials not configured. Set BTP_UDM_TOKEN_URL, BTP_UDM_CLIENT_ID, BTP_UDM_CLIENT_SECRET in .env");
  }
  if (udmTokenCache.token && Date.now() < udmTokenCache.expiresAt) return udmTokenCache.token;
  const auth = Buffer.from(`${UDM_CLIENT_ID}:${UDM_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch(UDM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${auth}` },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`UDM token fetch failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  udmTokenCache.token = data.access_token;
  udmTokenCache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return udmTokenCache.token;
}

// --- User Enrichment: merge data across all IdP origins ---
// Users exist per-origin (sap.default, custom IAS, etc.) with different data:
//   - sap.default: typically has firstName/lastName
//   - custom IdP: typically has role collections assigned via that IdP
// We merge across all origins to get a complete picture.

// Cache trust configs per scope (subaccount/global) with TTL
const trustCache = new Map(); // scope → { origins, fullData, ts }
const TRUST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getOriginKeys(scope) {
  const cached = trustCache.get(scope);
  if (cached && Date.now() - cached.ts < TRUST_CACHE_TTL) return cached.origins;
  try {
    const data = btpCli(`list security/trust ${scope}`);
    const trusts = Array.isArray(data) ? data : (data.value || []);
    const origins = trusts.map(t => t.originKey).filter(Boolean);
    trustCache.set(scope, { origins, fullData: trusts, ts: Date.now() });
    return origins;
  } catch (_) {
    trustCache.set(scope, { origins: ["sap.default"], fullData: [], ts: Date.now() });
    return ["sap.default"];
  }
}

function getTrustConfigurations(scope) {
  const cached = trustCache.get(scope);
  if (cached && Date.now() - cached.ts < TRUST_CACHE_TTL) return cached.fullData;
  getOriginKeys(scope); // populates cache
  return trustCache.get(scope)?.fullData || [];
}

/**
 * Call btpCli with automatic session-expiry retry.
 * If the first attempt fails with a login/auth error, re-login and retry once.
 */
function btpCliSafe(args) {
  try {
    return btpCli(args);
  } catch (e) {
    // btpCli already retries once on token expiry, so if we still fail here
    // it's likely a genuine error (user not found, etc.)
    throw e;
  }
}

/** Async version of btpCli — runs btp CLI without blocking the event loop. */
async function btpCliAsync(args) {
  try { btpCliLogin(); } catch (e) { btpCliLoggedIn = false; throw new Error(`BTP CLI login failed: ${e.message}`); }
  const cmd = `btp --format json ${args}`;
  const opts = { timeout: 60000, env: { ...process.env, HOME: "/root" } };
  try {
    const { stdout } = await execAsync(cmd, opts);
    return JSON.parse(stdout);
  } catch (e) {
    // Token may have expired — retry once after re-login
    btpCliLoggedIn = false;
    btpCliLogin();
    const { stdout } = await execAsync(cmd, opts);
    return JSON.parse(stdout);
  }
}

/** Async version of getOriginKeys — uses btpCliAsync, shares the same trust cache. */
async function getOriginKeysAsync(scope) {
  const cached = trustCache.get(scope);
  if (cached && Date.now() - cached.ts < TRUST_CACHE_TTL) return cached.origins;
  try {
    const data = await btpCliAsync(`list security/trust ${scope}`);
    const trusts = Array.isArray(data) ? data : (data.value || []);
    const origins = trusts.map(t => t.originKey).filter(Boolean);
    trustCache.set(scope, { origins, fullData: trusts, ts: Date.now() });
    return origins;
  } catch (_) {
    trustCache.set(scope, { origins: ["sap.default"], fullData: [], ts: Date.now() });
    return ["sap.default"];
  }
}

/** Async version of getEnrichedUser — fetches all origins in parallel. */
async function getEnrichedUserAsync(email, scope) {
  const origins = await getOriginKeysAsync(scope);
  let firstName = null, lastName = null, active = null, verified = null;
  let namesSource = null;
  let lastLogonTime = null, previousLogonTime = null, created = null, modified = null;
  const roleMap = new Map();
  const foundInOrigins = [];

  await Promise.allSettled(origins.map(async origin => {
    try {
      const detail = await btpCliAsync(`get security/user "${email}" --of-idp "${origin}" ${scope}`);
      foundInOrigins.push(origin);
      if (!firstName && (detail.givenName || detail.firstName)) {
        firstName = detail.givenName || detail.firstName;
        lastName = detail.familyName || detail.lastName || null;
        namesSource = origin;
      }
      if (active == null && detail.active != null) active = detail.active;
      if (verified == null && detail.verified != null) verified = detail.verified;
      if (detail.lastLogonTime && (!lastLogonTime || detail.lastLogonTime > lastLogonTime)) lastLogonTime = detail.lastLogonTime;
      if (detail.previousLogonTime && (!previousLogonTime || detail.previousLogonTime > previousLogonTime)) previousLogonTime = detail.previousLogonTime;
      if (detail.created && (!created || detail.created < created)) created = detail.created;
      if (detail.modified && (!modified || detail.modified > modified)) modified = detail.modified;
      const roles = (detail.roleCollections || []).map(rc => typeof rc === "string" ? rc : rc.name || rc);
      for (const r of roles) {
        if (!roleMap.has(r)) roleMap.set(r, new Set());
        roleMap.get(r).add(origin);
      }
    } catch (_) {}
  }));

  const roleCollections = [...roleMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, origs]) => ({ name, assignedVia: [...origs] }));

  return { username: email, email, firstName, lastName, namesSource, active, verified,
    lastLogonTime: lastLogonTime ? new Date(lastLogonTime).toISOString() : null,
    previousLogonTime: previousLogonTime ? new Date(previousLogonTime).toISOString() : null,
    created: created || null, modified: modified || null,
    origins: foundInOrigins, roleCollections };
}

/** Async version of checkAdmins — fetches users and enriches them in parallel. */
async function checkAdminsAsync(cliScope) {
  const admins = [];
  try {
    const origins = await getOriginKeysAsync(cliScope);
    const allEmails = new Set();
    await Promise.allSettled(origins.map(async origin => {
      try {
        const list = await btpCliAsync(`list security/user --of-idp "${origin}" ${cliScope}`);
        (Array.isArray(list) ? list : list.value || []).forEach(u => allEmails.add(typeof u === "string" ? u : (u.username || u.mail)));
      } catch (_) {}
    }));
    await Promise.allSettled([...allEmails].map(async email => {
      try {
        const user = await getEnrichedUserAsync(email, cliScope);
        const adminRoles = user.roleCollections.filter(rc => {
          const l = rc.name.toLowerCase();
          return l.includes("administrator") || l.includes("admin");
        });
        if (adminRoles.length > 0) {
          admins.push({ email, firstName: user.firstName, lastName: user.lastName,
            active: user.active, lastLogonTime: user.lastLogonTime,
            adminRoleCount: adminRoles.length, adminRoles: adminRoles.map(r => r.name),
            totalRoleCount: user.roleCollections.length, allRoles: user.roleCollections.map(r => r.name) });
        }
      } catch (_) {}
    }));
  } catch (_) {}
  return admins;
}

/**
 * Fetch user details across all IdP origins and merge:
 * - firstName/lastName from whichever origin has them
 * - roleCollections merged (deduplicated) from all origins
 * - login times, activity metadata
 */
function getEnrichedUser(email, scope) {
  const origins = getOriginKeys(scope);
  let firstName = null, lastName = null, active = null, verified = null;
  let namesSource = null;
  let lastLogonTime = null, previousLogonTime = null, created = null, modified = null;
  const roleMap = new Map(); // roleName → Set of origins
  const foundInOrigins = [];

  for (const origin of origins) {
    try {
      const detail = btpCliSafe(`get security/user "${email}" --of-idp "${origin}" ${scope}`);
      foundInOrigins.push(origin);
      if (!firstName && (detail.givenName || detail.firstName)) {
        firstName = detail.givenName || detail.firstName;
        lastName = detail.familyName || detail.lastName || null;
        namesSource = origin;
      }
      if (active == null && detail.active != null) active = detail.active;
      if (verified == null && detail.verified != null) verified = detail.verified;
      if (detail.lastLogonTime && (!lastLogonTime || detail.lastLogonTime > lastLogonTime)) {
        lastLogonTime = detail.lastLogonTime;
      }
      if (detail.previousLogonTime && (!previousLogonTime || detail.previousLogonTime > previousLogonTime)) {
        previousLogonTime = detail.previousLogonTime;
      }
      if (detail.created && (!created || detail.created < created)) {
        created = detail.created;
      }
      if (detail.modified && (!modified || detail.modified > modified)) {
        modified = detail.modified;
      }
      const roles = (detail.roleCollections || []).map(rc =>
        typeof rc === "string" ? rc : rc.name || rc
      );
      for (const r of roles) {
        if (!roleMap.has(r)) roleMap.set(r, new Set());
        roleMap.get(r).add(origin);
      }
    } catch (_) {
      // User may not exist under this origin — skip
    }
  }

  const roleCollections = [...roleMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, origins]) => ({
      name,
      assignedVia: [...origins],
    }));

  return {
    username: email,
    email,
    firstName,
    lastName,
    namesSource,
    active,
    verified,
    lastLogonTime: lastLogonTime ? new Date(lastLogonTime).toISOString() : null,
    previousLogonTime: previousLogonTime ? new Date(previousLogonTime).toISOString() : null,
    created: created || null,
    modified: modified || null,
    origins: foundInOrigins,
    roleCollections,
  };
}

// --- API Helpers ---
async function btpGet(baseUrl, path, tokenFn) {
  const token = await tokenFn();
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BTP API error (${res.status}) at ${url}: ${body}`);
  }
  return res.json();
}

async function cisGet(path) {
  return btpGet(ACCOUNTS_BASE_URL, path, getCisToken);
}

async function entGet(path) {
  if (!ENTITLEMENTS_BASE_URL) throw new Error("BTP_ENTITLEMENTS_SERVICE_BASE_URL not configured");
  return btpGet(ENTITLEMENTS_BASE_URL, path, getCisToken);
}

async function smGet(path) {
  if (!SM_BASE_URL) throw new Error("BTP_SM_BASE_URL not configured. Set it in .env");
  return btpGet(SM_BASE_URL, path, getSmToken);
}


async function eventsGet(path) {
  if (!EVENTS_BASE_URL) throw new Error("BTP_EVENTS_SERVICE_BASE_URL not configured");
  return btpGet(EVENTS_BASE_URL, path, getCisToken);
}

async function provisioningGet(path) {
  if (!PROVISIONING_BASE_URL) throw new Error("BTP_PROVISIONING_SERVICE_BASE_URL not configured");
  return btpGet(PROVISIONING_BASE_URL, path, getCisToken);
}

async function saasGet(path) {
  if (!SAAS_BASE_URL) throw new Error("BTP_SAAS_REGISTRY_BASE_URL not configured");
  return btpGet(SAAS_BASE_URL, path, getCisToken);
}

async function getCfToken() {
  if (cfTokenCache.token && Date.now() < cfTokenCache.expiresAt) return cfTokenCache.token;
  // CF uses public OAuth2 client "cf" (no client secret)
  const body = new URLSearchParams({
    grant_type: "password",
    username: BTP_USER,
    password: BTP_PASSWORD,
    client_id: "cf",
    scope: "",
  });
  const res = await fetch(`${CF_UAA_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic Y2Y6", // base64("cf:")
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CF token fetch failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  cfTokenCache.token = data.access_token;
  cfTokenCache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cfTokenCache.token;
}

async function cfGet(path) {
  return btpGet(CF_API_URL, path, getCfToken);
}

/** Fetch all pages of a CF v3 paginated collection. Returns merged resources + included. */
async function cfGetAll(basePath) {
  const allResources = [];
  const included = { spaces: [], organizations: [] };
  let nextUrl = `${CF_API_URL}${basePath}${basePath.includes("?") ? "&" : "?"}per_page=100`;

  while (nextUrl) {
    const token = await getCfToken();
    const res = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CF API error (${res.status}) at ${nextUrl}: ${body}`);
    }
    const data = await res.json();
    allResources.push(...(data.resources || []));
    if (data.included) {
      for (const [key, items] of Object.entries(data.included)) {
        if (!included[key]) included[key] = [];
        const existing = new Set(included[key].map((i) => i.guid));
        included[key].push(...items.filter((i) => !existing.has(i.guid)));
      }
    }
    nextUrl = data.pagination?.next?.href || null;
  }
  return { resources: allResources, included };
}

// --- MCP Server Setup ---
function createServer() {
  const server = new McpServer({
    name: "btp-mcp-server",
    version: "1.0.0",
  });

  server.tool("globalAccount_get", "Get BTP Global Account details", {}, async () => {
    const data = await cisGet("/accounts/v1/globalAccount?derivedAuthorizations=any");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  server.tool(
    "subaccounts_list",
    "List all BTP Subaccounts",
    { derivedAuthorizations: z.string().nullable().optional().default("any").describe("Filter: any, none") },
    async ({ derivedAuthorizations }) => {
      const da = derivedAuthorizations || "any";
      const data = await cisGet(`/accounts/v1/subaccounts?derivedAuthorizations=${da}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "subaccounts_get",
    "Get a specific BTP Subaccount by GUID",
    { guid: z.string().describe("Subaccount GUID") },
    async ({ guid }) => {
      if (!guid) return { content: [{ type: "text", text: "Error: guid is required" }], isError: true };
      const data = await cisGet(`/accounts/v1/subaccounts/${guid}?derivedAuthorizations=any`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "directories_list",
    "List all BTP Directories",
    { derivedAuthorizations: z.string().nullable().optional().default("any").describe("Filter: any, none") },
    async ({ derivedAuthorizations }) => {
      const da = derivedAuthorizations || "any";
      const data = await cisGet(`/accounts/v1/directories?derivedAuthorizations=${da}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "directories_get",
    "Get a specific BTP Directory by GUID",
    { guid: z.string().describe("Directory GUID") },
    async ({ guid }) => {
      if (!guid) return { content: [{ type: "text", text: "Error: guid is required" }], isError: true };
      const data = await cisGet(`/accounts/v1/directories/${guid}?derivedAuthorizations=any`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "entitlements_list",
    "List entitled and assigned services/quotas for the BTP global account. Use nameContains to search for a specific service (e.g. 'studio', 'launchpad'). Returns compact data without icons/descriptions.",
    {
      assignedOnly: z.boolean().nullable().optional().default(false).describe("If true, return only assignedServices (what is distributed to subaccounts). Default false = all entitledServices."),
      nameContains: z.string().nullable().optional().describe("Optional: filter by service name or displayName (case-insensitive, partial match). E.g. 'studio', 'launchpad', 'sapappstudio'."),
    },
    async ({ assignedOnly = false, nameContains }) => {
      const data = await entGet("/entitlements/v1/assignments");
      // Strip heavy fields (iconBase64, applicationCoordinates, dataCenters) to reduce response size
      function compactService(svc) {
        return {
          name: svc.name,
          displayName: svc.displayName,
          businessCategory: svc.businessCategory?.displayName,
          servicePlans: (svc.servicePlans || []).map(p => ({
            name: p.name,
            displayName: p.displayName,
            amount: p.amount,
            remainingAmount: p.remainingAmount,
            unlimited: p.unlimited,
            numberOfAssignedEntities: p.numberOfAssignedEntities,
            autoAssign: p.autoAssign,
          })),
        };
      }
      const filter = nameContains ? nameContains.toLowerCase() : null;
      function applyFilter(arr) {
        if (!arr) return [];
        const filtered = filter
          ? arr.filter(s => (s.name || "").toLowerCase().includes(filter) || (s.displayName || "").toLowerCase().includes(filter))
          : arr;
        return filtered.map(compactService);
      }
      const result = assignedOnly
        ? { assignedServices: applyFilter(data.assignedServices) }
        : { entitledServices: applyFilter(data.entitledServices), total: (data.entitledServices || []).length };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "service_instances_list",
    "List all Service Manager service instances (requires BTP_SM_* credentials in .env)",
    {
      subaccountID: z.string().nullable().optional().describe("Optional: filter by subaccount ID"),
      labelQuery: z.string().nullable().optional().describe("Optional: label selector query, e.g. 'env=prod'"),
    },
    async ({ subaccountID, labelQuery }) => {
      const params = new URLSearchParams();
      if (subaccountID) params.set("subaccount_id", subaccountID);
      if (labelQuery) params.set("labelQuery", labelQuery);
      const qs = params.toString() ? `?${params}` : "";
      const data = await smGet(`/v1/service_instances${qs}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "service_bindings_list",
    "List all Service Manager service bindings (requires BTP_SM_* credentials in .env)",
    {
      serviceInstanceID: z.string().nullable().optional().describe("Optional: filter by service instance ID"),
      labelQuery: z.string().nullable().optional().describe("Optional: label selector query"),
    },
    async ({ serviceInstanceID, labelQuery }) => {
      const params = new URLSearchParams();
      if (serviceInstanceID) params.set("service_instance_id", serviceInstanceID);
      if (labelQuery) params.set("labelQuery", labelQuery);
      const qs = params.toString() ? `?${params}` : "";
      const data = await smGet(`/v1/service_bindings${qs}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "provisioning_environments_list",
    "List all provisioned environment instances (Cloud Foundry orgs, Kyma clusters, etc.) per subaccount. Uses BTP CLI — same auth as Terraform provider.",
    {
      subaccountGUID: z.string().nullable().optional().describe("Required: subaccount GUID to list environments for. Get from subaccounts_list."),
    },
    async ({ subaccountGUID }) => {
      if (!subaccountGUID) return { content: [{ type: "text", text: "subaccountGUID is required. Call subaccounts_list first to get the GUID." }], isError: true };
      const data = btpCli(`list accounts/environment-instance --subaccount "${subaccountGUID}"`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "saas_subscriptions_list",
    "List SaaS application subscriptions. If subaccountGUID is omitted, automatically fetches all subaccounts and aggregates subscriptions across all of them in a single call. Uses BTP CLI.",
    {
      subaccountGUID: z.string().nullable().optional().describe("Optional: specific subaccount GUID. Omit to get subscriptions across ALL subaccounts (recommended for overview)."),
    },
    async ({ subaccountGUID }) => {
      // BTP CLI returns { applications: [...] } — filter to SUBSCRIBED only
      function extractSubscribed(raw) {
        const items = raw.applications || (Array.isArray(raw) ? raw : []);
        return items.filter(s => s.state === "SUBSCRIBED");
      }
      if (subaccountGUID) {
        const raw = btpCli(`list accounts/subscription --subaccount "${subaccountGUID}"`);
        return { content: [{ type: "text", text: JSON.stringify(extractSubscribed(raw), null, 2) }] };
      }
      // No subaccountGUID — aggregate across all subaccounts server-side (single LLM tool call)
      const subData = await cisGet("/accounts/v1/subaccounts?derivedAuthorizations=any");
      const subaccounts = subData.value || [];
      const results = [];
      for (const sa of subaccounts) {
        try {
          const raw = btpCli(`list accounts/subscription --subaccount "${sa.guid}"`);
          const subscribed = extractSubscribed(raw);
          if (subscribed.length > 0) {
            results.push({
              subaccount: sa.displayName,
              guid: sa.guid,
              subscriptions: subscribed.map(s => ({
                appName: s.appName,
                displayName: s.displayName,
                planName: s.planName,
                state: s.state,
                subscriptionUrl: s.subscriptionUrl || null,
              })),
            });
          }
        } catch (_) { /* skip subaccounts with no access */ }
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "users_list",
    "List users in the global account or a specific subaccount with first name, last name, email and ALL assigned role collections (merged across all identity providers). Uses BTP CLI.",
    {
      subaccountGUID: z.string().nullable().optional().describe("Optional: subaccount GUID for subaccount-level users. Omit for global account users."),
    },
    async ({ subaccountGUID }) => {
      const scope = subaccountGUID ? `--subaccount "${subaccountGUID}"` : `--global-account "${BTP_SUBDOMAIN}"`;
      // Collect unique usernames across all origins
      const origins = getOriginKeys(scope);
      const allEmails = new Set();
      for (const origin of origins) {
        try {
          const list = btpCli(`list security/user --of-idp "${origin}" ${scope}`);
          const users = Array.isArray(list) ? list : (list.value || []);
          users.forEach(u => allEmails.add(typeof u === "string" ? u : (u.username || u.mail)));
        } catch (_) {}
      }
      // Enrich each unique user across all origins
      const enriched = [];
      for (const email of allEmails) {
        enriched.push(getEnrichedUser(email, scope));
      }
      return { content: [{ type: "text", text: JSON.stringify({
        scope: subaccountGUID ? "subaccount" : "global-account",
        subaccountGUID: subaccountGUID || null,
        identityProviders: origins,
        total: enriched.length,
        users: enriched,
      }, null, 2) }] };
    }
  );

  server.tool(
    "user_get",
    "Get detailed information for a specific user by email/username, including first name, last name, and ALL assigned role collections (merged across all identity providers). Uses BTP CLI.",
    {
      username: z.string().describe("User email or username to look up"),
      subaccountGUID: z.string().nullable().optional().describe("Optional: subaccount GUID for subaccount-level user. Omit for global account."),
    },
    async ({ username, subaccountGUID }) => {
      const scope = subaccountGUID ? `--subaccount "${subaccountGUID}"` : `--global-account "${BTP_SUBDOMAIN}"`;
      const result = getEnrichedUser(username, scope);
      result.scope = subaccountGUID ? "subaccount" : "global-account";
      result.subaccountGUID = subaccountGUID || null;
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "role_collections_list",
    "List all role collections in the global account or a specific subaccount. Uses BTP CLI.",
    {
      subaccountGUID: z.string().nullable().optional().describe("Optional: subaccount GUID for subaccount-level role collections. Omit for global account level."),
    },
    async ({ subaccountGUID }) => {
      const scope = subaccountGUID ? `--subaccount "${subaccountGUID}"` : `--global-account "${BTP_SUBDOMAIN}"`;
      const data = btpCli(`list security/role-collection ${scope}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "role_collection_get",
    "Get a specific role collection by name with all assigned users (email, first name, last name, origin). Use this to find all users that have a specific role collection assigned. Uses BTP CLI.",
    {
      name: z.string().describe("Exact name of the role collection, e.g. 'Subaccount Administrator', 'Global Account Administrator'"),
      subaccountGUID: z.string().nullable().optional().describe("Optional: subaccount GUID for subaccount-level role collection. Omit for global account level."),
    },
    async ({ name, subaccountGUID }) => {
      const scope = subaccountGUID ? `--subaccount "${subaccountGUID}"` : `--global-account "${BTP_SUBDOMAIN}"`;
      const data = btpCli(`get security/role-collection "${name}" ${scope}`);
      // Extract unique users from the role collection and enrich with names
      const rawUsers = data.userReferences || data.users || [];
      const seen = new Set();
      const users = [];
      for (const u of rawUsers) {
        const email = u.username || u.name || u;
        if (seen.has(email)) continue;
        seen.add(email);
        const enriched = getEnrichedUser(email, scope);
        users.push({
          username: enriched.username,
          email: enriched.email,
          firstName: enriched.firstName,
          lastName: enriched.lastName,
        });
      }
      const result = {
        name: data.name,
        description: data.description || null,
        isReadOnly: data.isReadOnly || false,
        users,
        totalUsers: users.length,
        roleReferences: (data.roleReferences || []).map(r => ({
          roleName: r.name || r.roleName,
          roleTemplateName: r.roleTemplateName,
          appId: r.appId || r.roleTemplateAppId,
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "events_list",
    "List BTP platform audit events (account changes, entitlement updates, etc.)",
    {
      fromDate: z.string().nullable().optional().describe("Start date in ISO 8601 format, e.g. '2024-01-01T00:00:00Z'"),
      toDate: z.string().nullable().optional().describe("End date in ISO 8601 format, e.g. '2024-12-31T23:59:59Z'"),
      eventType: z.string().nullable().optional().describe("Optional: filter by event type, e.g. 'GlobalAccount_Update', 'Subaccount_Creation'"),
      entityType: z.string().nullable().optional().describe("Optional: filter by entity type, e.g. 'Subaccount', 'Directory', 'GlobalAccount'"),
    },
    async ({ fromDate, toDate, eventType, entityType }) => {
      const params = new URLSearchParams();
      if (fromDate) params.set("fromDate", fromDate);
      if (toDate) params.set("toDate", toDate);
      if (eventType) params.set("eventType", eventType);
      if (entityType) params.set("entityType", entityType);
      const qs = params.toString() ? `?${params}` : "";
      const data = await eventsGet(`/cloud-management/v1/events${qs}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "cf_orgs_list",
    "List all Cloud Foundry organizations accessible to the user. Each CF org corresponds to a BTP subaccount's CF environment.",
    {},
    async () => {
      const { resources } = await cfGetAll("/v3/organizations");
      const orgs = resources.map((o) => ({
        guid: o.guid,
        name: o.name,
        suspended: o.suspended,
        updated_at: o.updated_at,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ total: orgs.length, organizations: orgs }, null, 2) }] };
    }
  );

  server.tool(
    "cf_spaces_list",
    "List all Cloud Foundry spaces across all CF organizations.",
    {
      orgGUID: z.string().nullable().optional().describe("Optional: filter spaces by CF organization GUID"),
      orgName: z.string().nullable().optional().describe("Optional: filter spaces by CF organization name (case-sensitive)"),
    },
    async ({ orgGUID, orgName }) => {
      const params = new URLSearchParams();
      params.set("include", "organization");
      if (orgGUID) params.set("organization_guids", orgGUID);
      const { resources, included } = await cfGetAll(`/v3/spaces?${params}`);
      const orgMap = Object.fromEntries((included.organizations || []).map((o) => [o.guid, o.name]));
      const spaces = resources
        .map((s) => ({
          guid: s.guid,
          name: s.name,
          org_guid: s.relationships?.organization?.data?.guid,
          org_name: orgMap[s.relationships?.organization?.data?.guid] || "unknown",
          created_at: s.created_at,
          updated_at: s.updated_at,
        }))
        .filter((s) => !orgName || s.org_name === orgName);
      return { content: [{ type: "text", text: JSON.stringify({ total: spaces.length, spaces }, null, 2) }] };
    }
  );

  server.tool(
    "cf_apps_list",
    "List Cloud Foundry applications across ALL orgs and spaces in ONE call. Do NOT call cf_spaces_list first — this tool already includes org/space info via include=space.organization. Call without filters to get everything at once. Use orgGUID/spaceGUID (not names) for server-side filtering when you already have them. state filter is client-side only (CF v3 API does not support server-side state filtering).",
    {
      orgName: z.string().nullable().optional().describe("Filter by CF organization name (exact, client-side)"),
      orgGUID: z.string().nullable().optional().describe("Filter by CF organization GUID — server-side, faster (use when already known)"),
      spaceName: z.string().nullable().optional().describe("Filter by CF space name (exact, client-side)"),
      spaceGUID: z.string().nullable().optional().describe("Filter by CF space GUID — server-side, faster (use when already known)"),
      state: z.string().nullable().optional().describe("Filter by state: 'STARTED' or 'STOPPED' (client-side filter, CF API does not support this server-side)"),
      nameContains: z.string().nullable().optional().describe("Filter apps whose name contains this string (case-insensitive, client-side)"),
      page: z.number().nullable().optional().describe("Page number, starting at 1 (default: 1)"),
      pageSize: z.number().nullable().optional().describe("Apps per page (default: 25, max: 50)"),
    },
    async ({ orgName, orgGUID, spaceName, spaceGUID, state, nameContains, page = 1, pageSize = 25 }) => {
      const params = new URLSearchParams({ include: "space.organization" });
      // Only GUIDs are supported server-side by CF v3 /v3/apps
      if (spaceGUID) params.set("space_guids", spaceGUID);
      if (orgGUID) params.set("organization_guids", orgGUID);
      // NOTE: CF v3 does NOT support ?states= on /v3/apps — state is filtered client-side below

      const { resources, included } = await cfGetAll(`/v3/apps?${params}`);

      const spaceMap = Object.fromEntries((included.spaces || []).map((s) => [s.guid, s]));
      const orgMap = Object.fromEntries((included.organizations || []).map((o) => [o.guid, o.name]));

      let apps = resources.map((app) => {
        const spaceGuid = app.relationships?.space?.data?.guid;
        const space = spaceMap[spaceGuid];
        const orgGuid = space?.relationships?.organization?.data?.guid;
        return {
          guid: app.guid,
          name: app.name,
          state: app.state,
          buildpacks: app.lifecycle?.data?.buildpacks || [],
          space_guid: spaceGuid || "unknown",
          space_name: space?.name || "unknown",
          org_guid: orgGuid || "unknown",
          org_name: orgMap[orgGuid] || "unknown",
          updated_at: app.updated_at,
        };
      });

      // All filters are client-side (CF v3 /v3/apps only supports server-side filtering by GUIDs)
      if (state) apps = apps.filter((a) => a.state === state.toUpperCase());
      if (orgName) apps = apps.filter((a) => a.org_name === orgName);
      if (spaceName) apps = apps.filter((a) => a.space_name === spaceName);
      if (nameContains) apps = apps.filter((a) => a.name.toLowerCase().includes(nameContains.toLowerCase()));

      const totalCount = apps.length;
      const safePage = Math.max(1, page);
      const safePageSize = Math.min(50, Math.max(1, pageSize));
      const start = (safePage - 1) * safePageSize;
      const pagedApps = apps.slice(start, start + safePageSize);
      const totalPages = Math.ceil(totalCount / safePageSize);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: totalCount,
            page: safePage,
            pageSize: safePageSize,
            totalPages,
            apps: pagedApps,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "cf_app_processes",
    "Get process details for a CF app: running instances, desired instances, memory (MB), disk (MB), CPU usage. Requires app GUID from cf_apps_list.",
    {
      appGUID: z.string().describe("CF application GUID (from cf_apps_list result)"),
    },
    async ({ appGUID }) => {
      const data = await cfGet(`/v3/apps/${appGUID}/processes`);
      const processes = (data.resources || []).map((p) => ({
        type: p.type,
        instances: p.instances,
        memory_in_mb: p.memory_in_mb,
        disk_in_mb: p.disk_in_mb,
        health_check_type: p.health_check?.type,
      }));
      // Also fetch live instance stats for the web process
      let stats = null;
      const webProcess = (data.resources || []).find((p) => p.type === "web");
      if (webProcess?.guid) {
        try {
          const statsData = await cfGet(`/v3/processes/${webProcess.guid}/stats`);
          stats = (statsData.resources || []).map((s) => ({
            index: s.index,
            state: s.state,
            cpu: s.usage?.cpu != null ? `${(s.usage.cpu * 100).toFixed(1)}%` : null,
            mem_mb: s.usage?.mem != null ? Math.round(s.usage.mem / 1024 / 1024) : null,
            uptime_s: s.uptime,
          }));
        } catch {
          // stats endpoint may fail if app is stopped — that's ok
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ app_guid: appGUID, processes, instance_stats: stats }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "cf_app_routes",
    "Get all routes (URLs) mapped to a CF application. Requires app GUID from cf_apps_list.",
    {
      appGUID: z.string().describe("CF application GUID (from cf_apps_list result)"),
    },
    async ({ appGUID }) => {
      const { resources } = await cfGetAll(`/v3/apps/${appGUID}/routes?include=domain`);
      const routes = resources.map((r) => ({
        guid: r.guid,
        url: r.url,
        host: r.host,
        path: r.path,
        created_at: r.created_at,
      }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ app_guid: appGUID, total: routes.length, routes }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "cf_app_env",
    "Get environment variables and system-injected VCAP_SERVICES / VCAP_APPLICATION for a CF app. Requires app GUID from cf_apps_list. WARNING: may contain sensitive credentials.",
    {
      appGUID: z.string().describe("CF application GUID (from cf_apps_list result)"),
    },
    async ({ appGUID }) => {
      const data = await cfGet(`/v3/apps/${appGUID}/env`);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            app_guid: appGUID,
            environment_variables: data.environment_variables || {},
            vcap_application: data.system_env_json?.VCAP_APPLICATION || null,
            vcap_services: data.system_env_json?.VCAP_SERVICES || null,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "cf_app_get",
    "Get full details for a single CF application by GUID. Combines app metadata, processes, and routes in one call. Use this when you already know the app GUID to avoid multiple round-trips.",
    {
      appGUID: z.string().describe("CF application GUID (from cf_apps_list result)"),
    },
    async ({ appGUID }) => {
      const [appData, processesData, routesData] = await Promise.all([
        cfGet(`/v3/apps/${appGUID}`),
        cfGet(`/v3/apps/${appGUID}/processes`),
        cfGetAll(`/v3/apps/${appGUID}/routes?include=domain`),
      ]);
      const result = {
        guid: appData.guid,
        name: appData.name,
        state: appData.state,
        buildpacks: appData.lifecycle?.data?.buildpacks || [],
        created_at: appData.created_at,
        updated_at: appData.updated_at,
        space_guid: appData.relationships?.space?.data?.guid,
        processes: (processesData.resources || []).map((p) => ({
          type: p.type,
          instances: p.instances,
          memory_in_mb: p.memory_in_mb,
          disk_in_mb: p.disk_in_mb,
        })),
        routes: routesData.resources.map((r) => r.url),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // ─── CF Service Instances ────────────────────────────────────────────────
  server.tool(
    "cf_service_instances_list",
    "List Cloud Foundry service instances across orgs/spaces (CF API level — different from Service Manager). Shows which services are provisioned in which space. Use spaceGUID or orgGUID from cf_spaces_list/cf_orgs_list for efficient filtering.",
    {
      spaceGUID: z.string().nullable().optional().describe("Filter by CF space GUID (from cf_spaces_list)"),
      orgGUID: z.string().nullable().optional().describe("Filter by CF org GUID (from cf_orgs_list)"),
      serviceOffering: z.string().nullable().optional().describe("Filter by service offering name, e.g. 'hana', 'xsuaa', 'destination'"),
      nameContains: z.string().nullable().optional().describe("Filter by instance name (case-insensitive partial match)"),
    },
    async ({ spaceGUID, orgGUID, serviceOffering, nameContains }) => {
      const params = new URLSearchParams({ include: "space.organization,service_plan.service_offering" });
      if (spaceGUID) params.set("space_guids", spaceGUID);
      if (orgGUID) params.set("organization_guids", orgGUID);
      const { resources, included } = await cfGetAll(`/v3/service_instances?${params}`);

      const spaceMap = Object.fromEntries((included.spaces || []).map((s) => [s.guid, s]));
      const orgMap = Object.fromEntries((included.organizations || []).map((o) => [o.guid, o.name]));
      const planMap = Object.fromEntries((included.service_plans || []).map((p) => [p.guid, p]));
      const offeringMap = Object.fromEntries((included.service_offerings || []).map((o) => [o.guid, o]));

      let instances = resources.map((si) => {
        const spaceGuid = si.relationships?.space?.data?.guid;
        const space = spaceMap[spaceGuid];
        const orgGuid = space?.relationships?.organization?.data?.guid;
        const plan = planMap[si.relationships?.service_plan?.data?.guid];
        const offering = offeringMap[plan?.relationships?.service_offering?.data?.guid];
        return {
          guid: si.guid,
          name: si.name,
          type: si.type,
          service_offering: offering?.name || "unknown",
          service_plan: plan?.name || "unknown",
          space_guid: spaceGuid,
          space_name: space?.name || "unknown",
          org_name: orgMap[orgGuid] || "unknown",
          created_at: si.created_at,
          last_operation: si.last_operation?.type,
          last_operation_state: si.last_operation?.state,
        };
      });

      if (serviceOffering) instances = instances.filter((i) => i.service_offering.toLowerCase().includes(serviceOffering.toLowerCase()));
      if (nameContains) instances = instances.filter((i) => i.name.toLowerCase().includes(nameContains.toLowerCase()));

      return {
        content: [{ type: "text", text: JSON.stringify({ total: instances.length, service_instances: instances }, null, 2) }],
      };
    }
  );

  // ─── CF Service Credential Bindings ──────────────────────────────────────
  server.tool(
    "cf_service_bindings_list",
    "List CF service credential bindings — which apps are bound to which service instances. Requires app_guid or service_instance_guid from previous queries.",
    {
      appGUID: z.string().nullable().optional().describe("Filter by app GUID (from cf_apps_list)"),
      serviceInstanceGUID: z.string().nullable().optional().describe("Filter by service instance GUID (from cf_service_instances_list)"),
      nameContains: z.string().nullable().optional().describe("Filter by binding name (partial, case-insensitive)"),
    },
    async ({ appGUID, serviceInstanceGUID, nameContains }) => {
      const params = new URLSearchParams({ include: "app,service_instance" });
      if (appGUID) params.set("app_guids", appGUID);
      if (serviceInstanceGUID) params.set("service_instance_guids", serviceInstanceGUID);
      const { resources, included } = await cfGetAll(`/v3/service_credential_bindings?${params}`);

      const appMap = Object.fromEntries((included.apps || []).map((a) => [a.guid, a.name]));
      const siMap = Object.fromEntries((included.service_instances || []).map((s) => [s.guid, s.name]));

      let bindings = resources.map((b) => ({
        guid: b.guid,
        name: b.name,
        type: b.type,
        app_guid: b.relationships?.app?.data?.guid,
        app_name: appMap[b.relationships?.app?.data?.guid] || null,
        service_instance_guid: b.relationships?.service_instance?.data?.guid,
        service_instance_name: siMap[b.relationships?.service_instance?.data?.guid] || "unknown",
        created_at: b.created_at,
        last_operation: b.last_operation?.type,
        last_operation_state: b.last_operation?.state,
      }));

      if (nameContains) bindings = bindings.filter((b) => (b.name || "").toLowerCase().includes(nameContains.toLowerCase()));

      return {
        content: [{ type: "text", text: JSON.stringify({ total: bindings.length, bindings }, null, 2) }],
      };
    }
  );

  // ─── CF App Events ────────────────────────────────────────────────────────
  server.tool(
    "cf_app_events",
    "Get recent platform events for a CF app: crashes, restarts, staging failures, deployments. Requires app GUID from cf_apps_list.",
    {
      appGUID: z.string().describe("CF application GUID (from cf_apps_list)"),
      type: z.string().nullable().optional().describe("Filter by event type, e.g. 'audit.app.crash', 'audit.app.update', 'audit.app.restage'"),
    },
    async ({ appGUID, type }) => {
      const params = new URLSearchParams({ target_guids: appGUID, order_by: "-created_at", per_page: "50" });
      if (type) params.set("types", type);
      const data = await cfGet(`/v3/audit_events?${params}`);
      const events = (data.resources || []).map((e) => ({
        type: e.type,
        actor: e.actor?.name,
        created_at: e.created_at,
        data: e.data,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ app_guid: appGUID, total: events.length, events }, null, 2) }],
      };
    }
  );

  // ─── CF Org Quotas ────────────────────────────────────────────────────────
  server.tool(
    "cf_org_quotas_list",
    "List CF organization quota definitions: memory limits, service instance limits, route limits, app instance limits. Shows resource ceilings per org.",
    {},
    async () => {
      // Get our orgs first, then fetch only the quotas applied to them.
      // /v3/organization_quotas without filter returns the entire SAP CF platform (34k+ entries).
      const { resources: orgs } = await cfGetAll("/v3/organizations");
      const quotaGuids = [...new Set(
        orgs.map((o) => o.relationships?.quota?.data?.guid).filter(Boolean)
      )];
      if (quotaGuids.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ total: 0, quotas: [] }, null, 2) }] };
      }
      const params = new URLSearchParams({ guids: quotaGuids.join(",") });
      const { resources } = await cfGetAll(`/v3/organization_quotas?${params}`);
      const orgsByQuota = {};
      for (const org of orgs) {
        const qguid = org.relationships?.quota?.data?.guid;
        if (qguid) {
          if (!orgsByQuota[qguid]) orgsByQuota[qguid] = [];
          orgsByQuota[qguid].push(org.name);
        }
      }
      const quotas = resources.map((q) => ({
        guid: q.guid,
        name: q.name,
        total_memory_mb: q.apps?.total_memory_in_mb,
        per_app_tasks: q.apps?.per_app_tasks,
        total_service_instances: q.services?.total_service_instances,
        paid_services_allowed: q.services?.paid_services_allowed,
        total_routes: q.routes?.total_routes,
        total_app_instances: q.apps?.total_instances,
        applied_to_orgs: orgsByQuota[q.guid] || [],
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ total: quotas.length, quotas }, null, 2) }],
      };
    }
  );

  // ─── CF Domains ───────────────────────────────────────────────────────────
  server.tool(
    "cf_domains_list",
    "List CF routing domains (shared and private). Useful to understand which domains are available for app routes.",
    {
      orgGUID: z.string().nullable().optional().describe("Filter by owning org GUID (for private domains)"),
    },
    async ({ orgGUID }) => {
      const params = new URLSearchParams();
      if (orgGUID) params.set("organization_guids", orgGUID);
      const { resources } = await cfGetAll(`/v3/domains${params.toString() ? `?${params}` : ""}`);
      const domains = resources.map((d) => ({
        guid: d.guid,
        name: d.name,
        internal: d.internal,
        supported_protocols: d.supported_protocols,
        owning_org_guid: d.relationships?.organization?.data?.guid || null,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ total: domains.length, domains }, null, 2) }],
      };
    }
  );

  // ─── Trust Configurations Viewer ──────────────────────────────────────────
  server.tool(
    "trust_configurations_list",
    "List all identity provider trust configurations for a subaccount or the global account. Shows origin keys, IdP names, protocol, status, and whether auto-creation of shadow users is enabled. Uses BTP CLI.",
    {
      subaccountGUID: z.string().nullable().optional().describe("Optional: subaccount GUID. Omit for global account trust configs."),
    },
    async ({ subaccountGUID }) => {
      const scope = subaccountGUID ? `--subaccount "${subaccountGUID}"` : `--global-account "${BTP_SUBDOMAIN}"`;
      const trusts = getTrustConfigurations(scope);
      const result = trusts.map(t => ({
        name: t.name || t.displayName || null,
        originKey: t.originKey,
        identityProvider: t.identityProvider || null,
        protocol: t.protocol || null,
        type: t.typeOfTrust || t.type || null,
        status: t.status || null,
        readOnly: t.readOnly || false,
        autoCreateShadowUsers: t.availableForUserLogon != null ? t.availableForUserLogon : null,
        description: t.description || null,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({
          scope: subaccountGUID ? "subaccount" : "global-account",
          subaccountGUID: subaccountGUID || null,
          total: result.length,
          trustConfigurations: result,
        }, null, 2) }],
      };
    }
  );

  // ─── Security Audit ───────────────────────────────────────────────────────
  server.tool(
    "security_audit",
    "Security audit: find users with critical/admin role collections. Scans all users and highlights those with admin, administrator, security, or custom critical roles. Useful for access reviews and compliance. Uses BTP CLI.",
    {
      subaccountGUID: z.string().nullable().optional().describe("Optional: subaccount GUID. Omit for global account."),
      customCriticalRoles: z.array(z.string()).nullable().optional().describe("Optional: additional role collection names to flag as critical beyond the defaults (Administrator, Security, Admin)."),
    },
    async ({ subaccountGUID, customCriticalRoles }) => {
      const scope = subaccountGUID ? `--subaccount "${subaccountGUID}"` : `--global-account "${BTP_SUBDOMAIN}"`;
      const origins = getOriginKeys(scope);

      // Collect all unique emails
      const allEmails = new Set();
      for (const origin of origins) {
        try {
          const list = btpCliSafe(`list security/user --of-idp "${origin}" ${scope}`);
          const users = Array.isArray(list) ? list : (list.value || []);
          users.forEach(u => allEmails.add(typeof u === "string" ? u : (u.username || u.mail)));
        } catch (_) {}
      }

      // Default critical keywords
      const criticalKeywords = ["administrator", "admin", "security", "auditor"];
      const extraRoles = (customCriticalRoles || []).map(r => r.toLowerCase());

      const criticalUsers = [];
      const normalUsers = [];

      for (const email of allEmails) {
        const user = getEnrichedUser(email, scope);
        const criticalRoles = user.roleCollections.filter(rc => {
          const lower = rc.name.toLowerCase();
          return criticalKeywords.some(kw => lower.includes(kw)) || extraRoles.includes(lower);
        });
        if (criticalRoles.length > 0) {
          criticalUsers.push({
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            active: user.active,
            lastLogonTime: user.lastLogonTime,
            criticalRoles: criticalRoles.map(rc => ({ name: rc.name, assignedVia: rc.assignedVia })),
            totalRoles: user.roleCollections.length,
          });
        } else {
          normalUsers.push({
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            active: user.active,
            lastLogonTime: user.lastLogonTime,
            totalRoles: user.roleCollections.length,
          });
        }
      }

      // Sort critical users: inactive first (potential stale admin accounts), then by last logon
      criticalUsers.sort((a, b) => {
        if (a.active !== b.active) return a.active ? 1 : -1; // inactive first
        return (a.lastLogonTime || "").localeCompare(b.lastLogonTime || "");
      });

      return {
        content: [{ type: "text", text: JSON.stringify({
          scope: subaccountGUID ? "subaccount" : "global-account",
          subaccountGUID: subaccountGUID || null,
          summary: {
            totalUsers: allEmails.size,
            usersWithCriticalRoles: criticalUsers.length,
            usersWithoutCriticalRoles: normalUsers.length,
          },
          criticalUsers,
          normalUsers,
        }, null, 2) }],
      };
    }
  );

  // ─── Cross-Subaccount User Lookup ─────────────────────────────────────────
  server.tool(
    "user_cross_subaccount_lookup",
    "Find a user across ALL subaccounts: shows in which subaccounts they exist and what role collections they have in each. Essential for offboarding reviews and access audits. Uses BTP CLI.",
    {
      username: z.string().describe("User email or username to search for across all subaccounts"),
    },
    async ({ username }) => {
      // Get all subaccounts
      const subData = await cisGet("/accounts/v1/subaccounts?derivedAuthorizations=any");
      const subaccounts = subData.value || [];

      const results = [];
      for (const sa of subaccounts) {
        const scope = `--subaccount "${sa.guid}"`;
        try {
          const user = getEnrichedUser(username, scope);
          if (user.origins.length > 0) {
            results.push({
              subaccount: sa.displayName,
              subaccountGUID: sa.guid,
              region: sa.region || null,
              active: user.active,
              lastLogonTime: user.lastLogonTime,
              origins: user.origins,
              roleCollections: user.roleCollections,
            });
          }
        } catch (_) {
          // User doesn't exist in this subaccount or no access
        }
      }

      // Also check global account
      const globalScope = `--global-account "${BTP_SUBDOMAIN}"`;
      let globalResult = null;
      try {
        const user = getEnrichedUser(username, globalScope);
        if (user.origins.length > 0) {
          globalResult = {
            scope: "global-account",
            active: user.active,
            lastLogonTime: user.lastLogonTime,
            origins: user.origins,
            roleCollections: user.roleCollections,
          };
        }
      } catch (_) {}

      return {
        content: [{ type: "text", text: JSON.stringify({
          username,
          globalAccount: globalResult,
          subaccountsFound: results.length,
          subaccountsTotal: subaccounts.length,
          subaccounts: results,
        }, null, 2) }],
      };
    }
  );

  // ─── CF App Crashes / Recent Failures ─────────────────────────────────────
  server.tool(
    "cf_app_crashes",
    "Find CF apps that have recently crashed or are in a failed state. Scans all apps and returns those with crash events or STOPPED state with error indicators. Use without filters to get a full health overview.",
    {
      orgGUID: z.string().nullable().optional().describe("Optional: filter by CF organization GUID"),
      hoursBack: z.number().nullable().optional().default(24).describe("How many hours to look back for crash events (default: 24)"),
    },
    async ({ orgGUID, hoursBack = 24 }) => {
      const params = new URLSearchParams({ include: "space.organization" });
      if (orgGUID) params.set("organization_guids", orgGUID);
      const { resources: apps, included } = await cfGetAll(`/v3/apps?${params}`);

      const spaceMap = Object.fromEntries((included.spaces || []).map((s) => [s.guid, s]));
      const orgMap = Object.fromEntries((included.organizations || []).map((o) => [o.guid, o.name]));

      const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
      const problematicApps = [];

      for (const app of apps) {
        const spaceGuid = app.relationships?.space?.data?.guid;
        const space = spaceMap[spaceGuid];
        const orgGuid = space?.relationships?.organization?.data?.guid;

        // Check for crash events
        try {
          const evtParams = new URLSearchParams({
            target_guids: app.guid,
            types: "audit.app.process.crash",
            order_by: "-created_at",
            per_page: "10",
            created_ats: `[gte]${since}`,
          });
          const evtData = await cfGet(`/v3/audit_events?${evtParams}`);
          const crashes = (evtData.resources || []).map(e => ({
            created_at: e.created_at,
            exit_status: e.data?.exit_status,
            exit_description: e.data?.exit_description || e.data?.reason,
          }));

          if (crashes.length > 0 || app.state === "STOPPED") {
            problematicApps.push({
              guid: app.guid,
              name: app.name,
              state: app.state,
              space_name: space?.name || "unknown",
              org_name: orgMap[orgGuid] || "unknown",
              updated_at: app.updated_at,
              recentCrashes: crashes,
              crashCount: crashes.length,
            });
          }
        } catch (_) {
          // Skip if we can't access events for this app
        }
      }

      // Sort: most crashes first, then stopped apps
      problematicApps.sort((a, b) => b.crashCount - a.crashCount);

      return {
        content: [{ type: "text", text: JSON.stringify({
          hoursBack,
          since,
          totalAppsScanned: apps.length,
          problematicApps: problematicApps.length,
          apps: problematicApps,
        }, null, 2) }],
      };
    }
  );

  // ─── Entitlement Quota vs. Usage ──────────────────────────────────────────
  server.tool(
    "entitlement_quota_usage",
    "Compare entitled quota vs. actual assigned/used quota across all service plans. Highlights over-provisioned and near-limit services. Useful for cost optimization and capacity planning.",
    {},
    async () => {
      const data = await entGet("/entitlements/v1/assignments");
      const services = data.entitledServices || [];

      const analysis = [];
      for (const svc of services) {
        for (const plan of (svc.servicePlans || [])) {
          if (plan.unlimited) continue; // Skip unlimited plans
          const total = plan.amount || 0;
          const remaining = plan.remainingAmount || 0;
          const used = total - remaining;
          const usagePercent = total > 0 ? Math.round((used / total) * 100) : 0;

          if (total > 0) {
            analysis.push({
              service: svc.displayName || svc.name,
              plan: plan.displayName || plan.name,
              entitled: total,
              assigned: used,
              remaining,
              usagePercent,
              status: usagePercent >= 90 ? "CRITICAL" : usagePercent >= 70 ? "WARNING" : "OK",
            });
          }
        }
      }

      // Sort by usage percentage descending
      analysis.sort((a, b) => b.usagePercent - a.usagePercent);

      const critical = analysis.filter(a => a.status === "CRITICAL");
      const warning = analysis.filter(a => a.status === "WARNING");

      return {
        content: [{ type: "text", text: JSON.stringify({
          summary: {
            totalPlans: analysis.length,
            critical: critical.length,
            warning: warning.length,
            ok: analysis.length - critical.length - warning.length,
          },
          services: analysis,
        }, null, 2) }],
      };
    }
  );

  // ─── Service Binding / Key Rotation Audit ─────────────────────────────────
  server.tool(
    "cf_service_binding_age_audit",
    "Audit CF service credential bindings by age. Finds bindings older than a threshold (default: 90 days) that may need credential rotation. Sorted by age descending.",
    {
      maxAgeDays: z.number().nullable().optional().default(90).describe("Flag bindings older than this many days (default: 90)"),
      orgGUID: z.string().nullable().optional().describe("Optional: filter by CF org GUID"),
    },
    async ({ maxAgeDays = 90, orgGUID }) => {
      const params = new URLSearchParams({ include: "app,service_instance" });
      if (orgGUID) {
        // Get spaces for this org, then filter bindings
        const spaceParams = new URLSearchParams({ organization_guids: orgGUID });
        const { resources: spaces } = await cfGetAll(`/v3/spaces?${spaceParams}`);
        if (spaces.length > 0) {
          params.set("service_instance_space_guids", spaces.map(s => s.guid).join(","));
        }
      }
      const { resources, included } = await cfGetAll(`/v3/service_credential_bindings?${params}`);

      const appMap = Object.fromEntries((included.apps || []).map((a) => [a.guid, a.name]));
      const siMap = Object.fromEntries((included.service_instances || []).map((s) => [s.guid, s.name]));

      const now = Date.now();
      const thresholdMs = maxAgeDays * 24 * 60 * 60 * 1000;

      const bindings = resources.map(b => {
        const createdAt = new Date(b.created_at).getTime();
        const ageDays = Math.round((now - createdAt) / (24 * 60 * 60 * 1000));
        return {
          guid: b.guid,
          name: b.name,
          type: b.type,
          app_name: appMap[b.relationships?.app?.data?.guid] || null,
          service_instance_name: siMap[b.relationships?.service_instance?.data?.guid] || "unknown",
          created_at: b.created_at,
          ageDays,
          needsRotation: ageDays > maxAgeDays,
        };
      });

      // Sort by age descending
      bindings.sort((a, b) => b.ageDays - a.ageDays);

      const stale = bindings.filter(b => b.needsRotation);

      return {
        content: [{ type: "text", text: JSON.stringify({
          maxAgeDays,
          summary: {
            totalBindings: bindings.length,
            needsRotation: stale.length,
            ok: bindings.length - stale.length,
          },
          staleBindings: stale,
          allBindings: bindings,
        }, null, 2) }],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1 — Game Changer Features
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── BTP Health Dashboard ─────────────────────────────────────────────────
  server.tool(
    "btp_health_dashboard",
    "One-call complete health overview. Use scope to choose what to check: 'all' (full landscape), 'global' (global account only), or a specific subaccount GUID. Checks CF apps, quota limits, stale bindings, inactive admins, subscriptions. Returns per-subaccount breakdown with overall status.",
    {
      scope: z.string().optional().default("all").describe("'all' = full landscape across all subaccounts (default), 'global' = global account level only, or a specific subaccount GUID"),
      staleBindingDays: z.number().nullable().optional().default(90).describe("Flag bindings older than this (default: 90 days)"),
    },
    async ({ scope = "all", staleBindingDays = 90 }) => {
      const _tTotal = Date.now();
      console.log(`[dashboard] ▶ START scope=${scope} staleBindingDays=${staleBindingDays}`);
      const report = {
        timestamp: new Date().toISOString(),
        scope,
        globalAccount: { name: BTP_SUBDOMAIN, status: "HEALTHY" },
        subaccounts: [],
        cfApps: { total: 0, started: 0, stopped: 0, crashed: 0, perSubaccount: {} },
        quota: { critical: [], warning: [], perSubaccount: {} },
        staleBindings: { total: 0, stale: 0, oldest: null, perSubaccount: {} },
        security: { globalAdmins: [], subaccountAdmins: {} },
        subscriptions: [],
        resources: { runningMemoryMB: 0, wastedMemoryMB: 0, deployerMemoryMB: 0, totalAllocatedMB: 0, wastedPct: 0, perSubaccount: {} },
        finops: { udmAvailable: !!(UDM_BASE_URL && UDM_TOKEN_URL && UDM_CLIENT_ID && UDM_CLIENT_SECRET), consumption: null, zombieServiceInstances: [] },
        history: [],
        overall: "HEALTHY",
      };

      // Resolve which subaccounts to check
      let subaccounts = [];
      try {
        const _tSA = Date.now();
        const subData = await cisGet("/accounts/v1/subaccounts?derivedAuthorizations=any");
        subaccounts = subData.value || [];
        console.log(`[dashboard] subaccounts_list: ${subaccounts.length} entries in ${Date.now()-_tSA}ms`);
      } catch (_) {}

      if (scope !== "all" && scope !== "global") {
        // Specific subaccount GUID
        subaccounts = subaccounts.filter(sa => sa.guid === scope);
        if (subaccounts.length === 0) {
          return { content: [{ type: "text", text: JSON.stringify({ error: `Subaccount ${scope} not found` }, null, 2) }], isError: true };
        }
      }

      // --- Subaccount overview with state ---
      for (const sa of subaccounts) {
        const saInfo = {
          name: sa.displayName,
          guid: sa.guid,
          region: sa.region,
          state: sa.state,
          betaEnabled: sa.betaEnabled || false,
        };
        report.subaccounts.push(saInfo);
      }

      // --- Sections 1–5 all run in parallel ---
      await Promise.allSettled([

        // --- 1. CF Apps health ---
        (async () => {
          const _t1 = Date.now();
          console.log('[dashboard] S1 CF Apps: START');
          try {
            const params = new URLSearchParams({ include: "space.organization" });
            const [{ resources: apps, included }, crashResult] = await Promise.allSettled([
              cfGetAll(`/v3/apps?${params}`),
              (async () => {
                const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                const evtParams = new URLSearchParams({ types: "audit.app.process.crash", order_by: "-created_at", per_page: "100", created_ats: `[gte]${since}` });
                return cfGet(`/v3/audit_events?${evtParams}`);
              })(),
            ]).then(([r1, r2]) => [r1.value || { resources: [], included: {} }, r2.value || { resources: [] }]);

            const spaceMap = Object.fromEntries((included.spaces || []).map(s => [s.guid, s]));
            const orgMap = Object.fromEntries((included.organizations || []).map(o => [o.guid, o]));
            const crashedGuids = new Set((crashResult.resources || []).map(e => e.target?.guid).filter(Boolean));

            // Map CF org GUIDs/names → subaccount names (parallel per subaccount)
            const orgToSubaccount = {};
            await Promise.allSettled(subaccounts.map(async sa => {
              try {
                const envs = await btpCliAsync(`list accounts/environment-instance --subaccount "${sa.guid}"`);
                const cfEnvs = (Array.isArray(envs) ? envs : envs.environmentInstances || []).filter(e => e.environmentType === "cloudfoundry");
                for (const env of cfEnvs) {
                  const labels = typeof env.labels === "string" ? JSON.parse(env.labels) : (env.labels || {});
                  if (labels.Org_GUID) orgToSubaccount[labels.Org_GUID] = sa.displayName;
                  if (labels.Org_Name) orgToSubaccount[labels.Org_Name] = sa.displayName;
                }
              } catch (_) {}
            }));

            report.cfApps.total = apps.length;
            // Build buckets synchronously first, then fetch process details in parallel
            const processDetailTasks = [];
            for (const app of apps) {
              const spaceGuid = app.relationships?.space?.data?.guid;
              const space = spaceMap[spaceGuid];
              const orgGuid = space?.relationships?.organization?.data?.guid;
              const org = orgMap[orgGuid];
              const orgName = org?.name || "unknown";
              const saName = orgToSubaccount[orgGuid] || orgToSubaccount[orgName] || orgName;
              const isCrashed = crashedGuids.has(app.guid);
              if (app.state === "STARTED") report.cfApps.started++;
              else report.cfApps.stopped++;
              if (isCrashed) report.cfApps.crashed++;
              if (!report.cfApps.perSubaccount[saName]) report.cfApps.perSubaccount[saName] = { total: 0, started: 0, stopped: 0, crashed: 0, apps: [] };
              const bucket = report.cfApps.perSubaccount[saName];
              bucket.total++;
              if (app.state === "STARTED") bucket.started++; else bucket.stopped++;
              if (isCrashed) bucket.crashed++;
              if (app.state !== "STARTED" || isCrashed || scope !== "all") {
                const appEntry = { name: app.name, guid: app.guid, state: app.state, crashed: isCrashed, isDeployer: isDeployerApp(app.name), space: space?.name || "unknown", org: orgName, created: app.created_at, updated: app.updated_at };
                bucket.apps.push(appEntry);
                processDetailTasks.push(
                  cfGet(`/v3/apps/${app.guid}/processes`).then(procs => {
                    const webProc = (procs.resources || []).find(p => p.type === "web") || (procs.resources || [])[0];
                    if (webProc) { appEntry.instances = webProc.instances; appEntry.memoryMB = webProc.memory_in_mb; appEntry.diskMB = webProc.disk_in_mb; }
                  }).catch(() => {})
                );
              }
            }
            await Promise.allSettled(processDetailTasks);

            // ── Resource attribution (memory breakdown) ──────────────────────
            for (const [saName, bucket] of Object.entries(report.cfApps.perSubaccount)) {
              let saRunning = 0, saWasted = 0, saDeployer = 0;
              for (const a of bucket.apps) {
                const mb = (a.memoryMB || 0) * (a.instances || 1);
                if (a.state === "STARTED" && !a.crashed)      saRunning  += mb;
                else if (!a.isDeployer)                        saWasted   += mb;
                else                                           saDeployer += mb;
              }
              // also count started apps not in the apps array (only stopped/crashed are stored)
              report.resources.perSubaccount[saName] = { runningMemoryMB: saRunning, wastedMemoryMB: saWasted, deployerMemoryMB: saDeployer };
              report.resources.runningMemoryMB  += saRunning;
              report.resources.wastedMemoryMB   += saWasted;
              report.resources.deployerMemoryMB += saDeployer;
            }
            report.resources.totalAllocatedMB = report.resources.runningMemoryMB + report.resources.wastedMemoryMB + report.resources.deployerMemoryMB;
            const tot = report.resources.totalAllocatedMB;
            report.resources.wastedPct   = tot > 0 ? Math.round((report.resources.wastedMemoryMB  / tot) * 100) : 0;
            report.resources.runningPct  = tot > 0 ? Math.round((report.resources.runningMemoryMB / tot) * 100) : 0;
            report.resources.deployerPct = tot > 0 ? Math.round((report.resources.deployerMemoryMB/ tot) * 100) : 0;
          } catch (_) {}
          console.log(`[dashboard] S1 CF Apps: DONE ${Date.now()-_t1}ms (total=${report.cfApps.total} started=${report.cfApps.started} stopped=${report.cfApps.stopped} crashed=${report.cfApps.crashed})`);
        })(),

        // --- 2. Quota analysis ---
        (async () => {
          const _t2 = Date.now();
          console.log('[dashboard] S2 Quota: START');
          const tasks = [];
          if (scope === "all" || scope === "global") {
            tasks.push((async () => {
              try {
                const data = await entGet("/entitlements/v1/assignments");
                for (const svc of (data.entitledServices || [])) {
                  for (const plan of (svc.servicePlans || [])) {
                    if (plan.unlimited || !plan.amount) continue;
                    const used = plan.amount - (plan.remainingAmount || 0);
                    const pct = Math.round((used / plan.amount) * 100);
                    const entry = { service: svc.displayName || svc.name, plan: plan.displayName || plan.name, entitled: plan.amount, used, remaining: plan.remainingAmount, pct,
                      assignedTo: (plan.assignedTo || []).map(a => ({ subaccount: subaccounts.find(sa => sa.guid === a.entityId)?.displayName || a.entityId, amount: a.amount })).filter(a => a.amount > 0) };
                    if (pct >= 90) report.quota.critical.push(entry);
                    else if (pct >= 70) report.quota.warning.push(entry);
                  }
                }
              } catch (_) {}
            })());
          }
          if (scope !== "global") {
            tasks.push(...subaccounts.map(async sa => {
              try {
                const saData = await entGet(`/entitlements/v1/assignments?subaccountGUID=${sa.guid}`);
                const saQuota = [];
                for (const svc of (saData.entitledServices || [])) {
                  for (const plan of (svc.servicePlans || [])) {
                    if (plan.unlimited || !plan.amount) continue;
                    const used = plan.amount - (plan.remainingAmount || 0);
                    const pct = Math.round((used / plan.amount) * 100);
                    if (pct >= 50) saQuota.push({ service: svc.displayName || svc.name, plan: plan.displayName || plan.name, entitled: plan.amount, used, remaining: plan.remainingAmount, pct });
                  }
                }
                if (saQuota.length > 0) report.quota.perSubaccount[sa.displayName] = saQuota;
              } catch (_) {}
            }));
          }
          await Promise.allSettled(tasks);
          console.log(`[dashboard] S2 Quota: DONE ${Date.now()-_t2}ms (critical=${report.quota.critical.length} warning=${report.quota.warning.length})`);
        })(),

        // --- 3. Stale bindings ---
        (async () => {
          const _t3 = Date.now();
          console.log('[dashboard] S3 StaleBindings: START');
          try {
            const [{ resources: bindings }, { resources: siList, included: siIncluded }] = await Promise.all([
              cfGetAll("/v3/service_credential_bindings?include=service_instance,app"),
              cfGetAll(`/v3/service_instances?${new URLSearchParams({ include: "space.organization" })}`),
            ]);
            const siMap = Object.fromEntries(siList.map(si => [si.guid, si]));
            const siSpaceMap = Object.fromEntries((siIncluded?.spaces || []).map(s => [s.guid, s]));
            const siOrgMap = Object.fromEntries((siIncluded?.organizations || []).map(o => [o.guid, o]));
            const now = Date.now();
            const threshold = staleBindingDays * 24 * 60 * 60 * 1000;
            report.staleBindings.total = bindings.length;
            let oldestAge = 0;
            for (const b of bindings) {
              const age = now - new Date(b.created_at).getTime();
              if (age > oldestAge) oldestAge = age;
              if (age <= threshold) continue;
              report.staleBindings.stale++;
              const siGuid = b.relationships?.service_instance?.data?.guid;
              const si = siMap[siGuid];
              const space = siSpaceMap[si?.relationships?.space?.data?.guid];
              const org = siOrgMap[space?.relationships?.organization?.data?.guid];
              const orgName = org?.name || "unknown";
              const saName = Object.keys(report.cfApps.perSubaccount).find(k => k === orgName) || orgName;
              if (!report.staleBindings.perSubaccount[saName]) report.staleBindings.perSubaccount[saName] = [];
              report.staleBindings.perSubaccount[saName].push({ bindingName: b.name || b.guid, type: b.type, ageDays: Math.round(age / (24 * 60 * 60 * 1000)), serviceName: si?.name || "unknown", serviceOffering: si?.type || "unknown", appName: b.relationships?.app?.data?.guid || null, space: space?.name || "unknown", created: b.created_at });
            }
            report.staleBindings.oldest = oldestAge > 0 ? Math.round(oldestAge / (24 * 60 * 60 * 1000)) + " days" : null;
          } catch (_) {}
          console.log(`[dashboard] S3 StaleBindings: DONE ${Date.now()-_t3}ms (total=${report.staleBindings.total} stale=${report.staleBindings.stale})`);
        })(),

        // --- 4. Security: admins (global + all subaccounts in parallel) ---
        (async () => {
          const _t4 = Date.now();
          console.log('[dashboard] S4 Admins: START');
          const tasks = [];
          if (scope === "all" || scope === "global") tasks.push(checkAdminsAsync(`--global-account "${BTP_SUBDOMAIN}"`).then(admins => { report.security.globalAdmins = admins; }).catch(() => {}));
          if (scope !== "global") {
            for (const sa of subaccounts) tasks.push(checkAdminsAsync(`--subaccount "${sa.guid}"`).then(admins => { if (admins.length > 0) report.security.subaccountAdmins[`${sa.displayName} (${sa.guid})`] = admins; }).catch(() => {}));
          }
          await Promise.allSettled(tasks);
          console.log(`[dashboard] S4 Admins: DONE ${Date.now()-_t4}ms (global=${report.security.globalAdmins.length} subaccounts=${Object.keys(report.security.subaccountAdmins).length})`);
        })(),

        // --- 5. SaaS Subscriptions (all subaccounts in parallel) ---
        scope !== "global"
          ? (async () => {
              const _t5 = Date.now();
              console.log('[dashboard] S5 SaaS: START');
              await Promise.allSettled(subaccounts.map(async sa => {
                try {
                  const raw = await btpCliAsync(`list accounts/subscription --subaccount "${sa.guid}"`);
                  const allApps = raw.applications || [];
                  const subscribed = allApps.filter(s => s.state === "SUBSCRIBED");
                  const failed = allApps.filter(s => s.state === "SUBSCRIBE_FAILED" || s.state === "UNSUBSCRIBE_FAILED");
                  if (subscribed.length > 0 || failed.length > 0) {
                    report.subscriptions.push({ subaccount: sa.displayName, subaccountGUID: sa.guid, subscribed: subscribed.length, failed: failed.length,
                      apps: subscribed.map(s => ({ appName: s.appName, planName: s.planName, category: s.category || s.commercialAppName || "application", appId: s.appId })),
                      failedApps: failed.map(s => ({ appName: s.appName, planName: s.planName, state: s.state, error: s.errorMessage || null })) });
                  }
                } catch (_) {}
              }));
              console.log(`[dashboard] S5 SaaS: DONE ${Date.now()-_t5}ms (entries=${report.subscriptions.length})`);
            })()
          : Promise.resolve(),

        // --- 6. FinOps: UDM Consumption + Zombie Service Instances ---
        (async () => {
          const _t6 = Date.now();
          console.log('[dashboard] S6 FinOps: START');
          // 6a. UDM Consumption (optional)
          if (report.finops.udmAvailable) {
            try {
              const token = await getUdmToken();
              const targetMonth = new Date().toISOString().substring(0, 7);
              const udmRes = await fetch(
                `${UDM_BASE_URL}/reports/v1/monthlyUsage?fromDate=${targetMonth}&toDate=${targetMonth}`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
              if (udmRes.ok) {
                const raw = await udmRes.json();
                const entries = raw.reportEntries || raw.content || [];
                const byName = {};
                for (const e of entries) {
                  const name = e.subaccountName || e.subaccountId || "Global";
                  if (!byName[name]) byName[name] = { name, serviceCount: 0, services: [] };
                  byName[name].serviceCount++;
                  byName[name].services.push({ service: e.serviceName, plan: e.planName, metric: e.metric, usage: e.usage, unit: e.unit });
                }
                const topConsumers = Object.values(byName).sort((a, b) => b.serviceCount - a.serviceCount);
                report.finops.consumption = { month: targetMonth, totalEntries: entries.length, topConsumers };
              } else {
                const body = await udmRes.text();
                report.finops.consumption = { error: `HTTP ${udmRes.status}: ${body.slice(0, 200)}` };
              }
            } catch (e) {
              report.finops.consumption = { error: e.message };
            }
          }
          // 6b. Zombie Service Instances (no CF bindings + age > 30 days)
          try {
            const ZOMBIE_DAYS = 30;
            const [siResult, bindResult] = await Promise.all([
              cfGetAll("/v3/service_instances?include=space.organization"),
              cfGetAll("/v3/service_credential_bindings"),
            ]);
            const boundGuids = new Set(
              (bindResult.resources || [])
                .map(b => b.relationships?.service_instance?.data?.guid)
                .filter(Boolean)
            );
            const spaceMap = Object.fromEntries((siResult.included?.spaces || []).map(s => [s.guid, s]));
            const orgMap   = Object.fromEntries((siResult.included?.organizations || []).map(o => [o.guid, o.name]));
            const now2 = Date.now();
            report.finops.zombieServiceInstances = (siResult.resources || [])
              .filter(si => !boundGuids.has(si.guid) && (now2 - new Date(si.created_at).getTime()) > ZOMBIE_DAYS * 86400000)
              .map(si => {
                const space = spaceMap[si.relationships?.space?.data?.guid];
                const orgGuid = space?.relationships?.organization?.data?.guid;
                return {
                  name: si.name,
                  type: si.type || "managed",
                  space: space?.name || "unknown",
                  org: orgMap[orgGuid] || "unknown",
                  created: si.created_at,
                  ageDays: Math.round((now2 - new Date(si.created_at).getTime()) / 86400000),
                };
              })
              .sort((a, b) => b.ageDays - a.ageDays);
          } catch (_) {}
          console.log(`[dashboard] S6 FinOps: DONE ${Date.now()-_t6}ms (udm=${!!report.finops.consumption} zombieSvc=${report.finops.zombieServiceInstances.length})`);
        })(),

      ]);
      console.log(`[dashboard] ■ ALL SECTIONS DONE in ${Date.now()-_tTotal}ms`);

      // --- Per-subaccount status + overall status ---
      // CF perSubaccount keys may be CF org names, not BTP subaccount display names.
      // Build a fuzzy lookup: try exact match, then case-insensitive prefix match.
      const cfSaKeys = Object.keys(report.cfApps.perSubaccount);
      function findCfBucket(saName) {
        if (report.cfApps.perSubaccount[saName]) return report.cfApps.perSubaccount[saName];
        const lower = saName.toLowerCase();
        const key = cfSaKeys.find(k => k.toLowerCase() === lower || k.toLowerCase().startsWith(lower) || lower.startsWith(k.toLowerCase()));
        return key ? report.cfApps.perSubaccount[key] : null;
      }

      for (const saInfo of report.subaccounts) {
        let saStatus = "HEALTHY";
        const saName = saInfo.name;

        // Check CF apps in this subaccount
        const saCfApps = findCfBucket(saName);
        if (saCfApps?.crashed > 0) saStatus = "CRITICAL";
        else if (saCfApps?.stopped > 0 && saStatus !== "CRITICAL") saStatus = "WARNING";

        // Check stale bindings in this subaccount
        const saStaleBindings = report.staleBindings.perSubaccount[saName];
        if (saStaleBindings?.length > 3 && saStatus !== "CRITICAL") saStatus = "WARNING";

        // Check admins in this subaccount
        const saAdminKey = Object.keys(report.security.subaccountAdmins).find(k => k.startsWith(saName));
        if (saAdminKey) {
          const inactiveAdmins = report.security.subaccountAdmins[saAdminKey].filter(a => a.active === false).length;
          if (inactiveAdmins > 0 && saStatus !== "CRITICAL") saStatus = "WARNING";
        }

        // Check failed subscriptions
        const saSubs = report.subscriptions.find(s => s.subaccount === saName);
        if (saSubs?.failed > 0) saStatus = "CRITICAL";

        // Check per-subaccount quota
        const saQuota = report.quota.perSubaccount[saName];
        if (saQuota?.some(q => q.usagePercent >= 90)) saStatus = "CRITICAL";
        else if (saQuota?.some(q => q.usagePercent >= 70) && saStatus !== "CRITICAL") saStatus = "WARNING";

        saInfo.status = saStatus;
      }

      // Global overall status
      const inactiveGlobalAdmins = report.security.globalAdmins.filter(a => a.active === false).length;
      const hasCriticalSubaccount = report.subaccounts.some(sa => sa.status === "CRITICAL");
      const hasWarningSubaccount = report.subaccounts.some(sa => sa.status === "WARNING");

      if (report.cfApps.crashed > 0 || report.quota.critical.length > 0 || inactiveGlobalAdmins > 0 || hasCriticalSubaccount) {
        report.overall = "CRITICAL";
      } else if (report.quota.warning.length > 0 || report.staleBindings.stale > 5 || hasWarningSubaccount) {
        report.overall = "WARNING";
      }

      report.globalAccount.status = report.overall;

      // --- Save snapshot + attach history ---
      report.history = saveSnapshot(report);

      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );

  // ─── CF App Logs ──────────────────────────────────────────────────────────
  server.tool(
    "cf_app_logs",
    "Get recent log lines for a CF application. Fetches from the CF log-cache API (logcache/v1). Returns recent log envelopes including stdout, stderr, and router logs. Requires app GUID.",
    {
      appGUID: z.string().describe("CF application GUID (from cf_apps_list)"),
      limit: z.number().nullable().optional().default(100).describe("Number of recent log lines to return (default: 100, max: 1000)"),
      logType: z.string().nullable().optional().describe("Optional filter: 'OUT' for stdout, 'ERR' for stderr, 'RTR' for router logs"),
    },
    async ({ appGUID, limit = 100, logType }) => {
      const safeLimit = Math.min(1000, Math.max(1, limit));
      // CF log-cache v1 API (Read endpoint)
      // Try the log-cache API which is available on most CF deployments
      const logCacheBase = CF_API_URL.replace("https://api.cf.", "https://log-cache.cf.");

      try {
        const token = await getCfToken();
        const params = new URLSearchParams({
          envelope_types: "LOG",
          limit: String(safeLimit),
          descending: "true",
        });
        const res = await fetch(`${logCacheBase}/api/v1/read/${appGUID}?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Log-cache API error (${res.status}): ${body}`);
        }
        const data = await res.json();
        const envelopes = (data.envelopes?.batch || []).map(env => {
          const log = env.log || {};
          const msg = log.payload ? Buffer.from(log.payload, "base64").toString("utf8") : "";
          const logTypeVal = log.type === 1 ? "ERR" : "OUT";
          return {
            timestamp: env.timestamp ? new Date(Number(env.timestamp) / 1e6).toISOString() : null,
            source: env.tags?.source_type || env.instance_id || null,
            type: logTypeVal,
            message: msg.trim(),
          };
        });

        const filtered = logType ? envelopes.filter(e => e.type === logType || e.source === logType) : envelopes;
        // Reverse to chronological order
        filtered.reverse();

        return {
          content: [{ type: "text", text: JSON.stringify({
            app_guid: appGUID,
            total: filtered.length,
            logType: logType || "ALL",
            logs: filtered,
          }, null, 2) }],
        };
      } catch (logCacheErr) {
        // Fallback: return recent audit events as a proxy for log activity
        try {
          const evtParams = new URLSearchParams({
            target_guids: appGUID,
            order_by: "-created_at",
            per_page: String(safeLimit),
          });
          const evtData = await cfGet(`/v3/audit_events?${evtParams}`);
          const events = (evtData.resources || []).map(e => ({
            timestamp: e.created_at,
            type: e.type,
            actor: e.actor?.name,
            data: e.data,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify({
              app_guid: appGUID,
              note: "Log-cache API not available — returning audit events as fallback",
              logCacheError: logCacheErr.message,
              total: events.length,
              events,
            }, null, 2) }],
          };
        } catch (evtErr) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              app_guid: appGUID,
              error: `Could not fetch logs: ${logCacheErr.message}. Audit events fallback also failed: ${evtErr.message}`,
            }, null, 2) }],
            isError: true,
          };
        }
      }
    }
  );

  // ─── BTP Cleanup Recommendations ──────────────────────────────────────────
  server.tool(
    "btp_cleanup_recommendations",
    "Find unused and stale resources across the BTP landscape that can potentially be cleaned up. Checks: stopped CF apps not updated in X days, service instances without bindings (orphaned), orphaned routes without apps, and stale service bindings. Returns actionable cleanup recommendations.",
    {
      stoppedAppDays: z.number().nullable().optional().default(30).describe("Flag STOPPED apps not updated in this many days (default: 30)"),
      staleBindingDays: z.number().nullable().optional().default(90).describe("Flag bindings older than this (default: 90)"),
    },
    async ({ stoppedAppDays = 30, staleBindingDays = 90 }) => {
      const now = Date.now();
      const result = {
        timestamp: new Date().toISOString(),
        staleApps: [],
        orphanedServiceInstances: [],
        orphanedRoutes: [],
        staleBindings: [],
        summary: {},
      };

      // 1. Stopped apps not updated in X days
      try {
        const params = new URLSearchParams({ include: "space.organization" });
        const { resources: apps, included } = await cfGetAll(`/v3/apps?${params}`);
        const spaceMap = Object.fromEntries((included.spaces || []).map(s => [s.guid, s]));
        const orgMap = Object.fromEntries((included.organizations || []).map(o => [o.guid, o.name]));
        const threshold = stoppedAppDays * 24 * 60 * 60 * 1000;

        for (const app of apps) {
          if (app.state !== "STOPPED") continue;
          const updatedAge = now - new Date(app.updated_at).getTime();
          if (updatedAge > threshold) {
            const spaceGuid = app.relationships?.space?.data?.guid;
            const space = spaceMap[spaceGuid];
            const orgGuid = space?.relationships?.organization?.data?.guid;
            result.staleApps.push({
              guid: app.guid,
              name: app.name,
              space: space?.name || "unknown",
              org: orgMap[orgGuid] || "unknown",
              lastUpdated: app.updated_at,
              staleDays: Math.round(updatedAge / (24 * 60 * 60 * 1000)),
            });
          }
        }
      } catch (_) {}

      // 2. Service instances without bindings (orphaned)
      try {
        const [siResult, bindResult] = await Promise.all([
          cfGetAll("/v3/service_instances?include=space.organization,service_plan.service_offering"),
          cfGetAll("/v3/service_credential_bindings"),
        ]);

        const boundInstanceGuids = new Set(
          (bindResult.resources || []).map(b => b.relationships?.service_instance?.data?.guid).filter(Boolean)
        );

        const spaceMap = Object.fromEntries((siResult.included.spaces || []).map(s => [s.guid, s]));
        const orgMap = Object.fromEntries((siResult.included.organizations || []).map(o => [o.guid, o.name]));
        const planMap = Object.fromEntries((siResult.included.service_plans || []).map(p => [p.guid, p]));
        const offeringMap = Object.fromEntries((siResult.included.service_offerings || []).map(o => [o.guid, o]));

        for (const si of siResult.resources) {
          if (si.type === "user-provided") continue; // Skip UPS
          if (!boundInstanceGuids.has(si.guid)) {
            const spaceGuid = si.relationships?.space?.data?.guid;
            const space = spaceMap[spaceGuid];
            const orgGuid = space?.relationships?.organization?.data?.guid;
            const plan = planMap[si.relationships?.service_plan?.data?.guid];
            const offering = offeringMap[plan?.relationships?.service_offering?.data?.guid];
            result.orphanedServiceInstances.push({
              guid: si.guid,
              name: si.name,
              service: offering?.name || "unknown",
              plan: plan?.name || "unknown",
              space: space?.name || "unknown",
              org: orgMap[orgGuid] || "unknown",
              created_at: si.created_at,
              ageDays: Math.round((now - new Date(si.created_at).getTime()) / (24 * 60 * 60 * 1000)),
            });
          }
        }

        // 4. Stale bindings (while we have the data)
        const bindThreshold = staleBindingDays * 24 * 60 * 60 * 1000;
        for (const b of bindResult.resources) {
          const age = now - new Date(b.created_at).getTime();
          if (age > bindThreshold) {
            result.staleBindings.push({
              guid: b.guid,
              name: b.name,
              type: b.type,
              created_at: b.created_at,
              ageDays: Math.round(age / (24 * 60 * 60 * 1000)),
            });
          }
        }
      } catch (_) {}

      // 3. Orphaned routes (no app destinations)
      try {
        const { resources: routes } = await cfGetAll("/v3/routes");
        for (const route of routes) {
          try {
            const destData = await cfGet(`/v3/routes/${route.guid}/destinations`);
            if (!destData.destinations || destData.destinations.length === 0) {
              result.orphanedRoutes.push({
                guid: route.guid,
                url: route.url,
                host: route.host,
                path: route.path || "/",
                created_at: route.created_at,
              });
            }
          } catch (_) {}
        }
      } catch (_) {}

      result.summary = {
        staleApps: result.staleApps.length,
        orphanedServiceInstances: result.orphanedServiceInstances.length,
        orphanedRoutes: result.orphanedRoutes.length,
        staleBindings: result.staleBindings.length,
        totalCleanupCandidates:
          result.staleApps.length + result.orphanedServiceInstances.length +
          result.orphanedRoutes.length + result.staleBindings.length,
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2 — Power User Features
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── Subaccount Compare ───────────────────────────────────────────────────
  server.tool(
    "subaccount_compare",
    "Compare two BTP subaccounts side-by-side: differences in entitlements, services, subscriptions, users, and role collections. Ideal for 'Why does X work in Dev but not in Prod?' troubleshooting.",
    {
      subaccountGUID_A: z.string().describe("First subaccount GUID (e.g. Dev)"),
      subaccountGUID_B: z.string().describe("Second subaccount GUID (e.g. Prod)"),
    },
    async ({ subaccountGUID_A, subaccountGUID_B }) => {
      // Fetch both subaccount details
      const [saA, saB] = await Promise.all([
        cisGet(`/accounts/v1/subaccounts/${subaccountGUID_A}?derivedAuthorizations=any`),
        cisGet(`/accounts/v1/subaccounts/${subaccountGUID_B}?derivedAuthorizations=any`),
      ]);

      const result = {
        subaccounts: {
          A: { guid: subaccountGUID_A, name: saA.displayName, region: saA.region, state: saA.state },
          B: { guid: subaccountGUID_B, name: saB.displayName, region: saB.region, state: saB.state },
        },
        subscriptions: { onlyInA: [], onlyInB: [], inBoth: [] },
        roleCollections: { onlyInA: [], onlyInB: [], inBoth: [] },
        users: { onlyInA: [], onlyInB: [], inBoth: [] },
      };

      // Compare SaaS subscriptions
      try {
        const [rawA, rawB] = await Promise.all([
          btpCliSafe(`list accounts/subscription --subaccount "${subaccountGUID_A}"`),
          btpCliSafe(`list accounts/subscription --subaccount "${subaccountGUID_B}"`),
        ]);
        const subsA = new Map((rawA.applications || []).filter(s => s.state === "SUBSCRIBED").map(s => [s.appName, s]));
        const subsB = new Map((rawB.applications || []).filter(s => s.state === "SUBSCRIBED").map(s => [s.appName, s]));
        for (const [name, s] of subsA) {
          if (subsB.has(name)) result.subscriptions.inBoth.push(name);
          else result.subscriptions.onlyInA.push({ appName: name, planName: s.planName });
        }
        for (const [name, s] of subsB) {
          if (!subsA.has(name)) result.subscriptions.onlyInB.push({ appName: name, planName: s.planName });
        }
      } catch (_) {}

      // Compare role collections
      try {
        const [rcA, rcB] = await Promise.all([
          btpCliSafe(`list security/role-collection --subaccount "${subaccountGUID_A}"`),
          btpCliSafe(`list security/role-collection --subaccount "${subaccountGUID_B}"`),
        ]);
        const namesA = new Set((Array.isArray(rcA) ? rcA : rcA.value || []).map(r => r.name));
        const namesB = new Set((Array.isArray(rcB) ? rcB : rcB.value || []).map(r => r.name));
        for (const n of namesA) {
          if (namesB.has(n)) result.roleCollections.inBoth.push(n);
          else result.roleCollections.onlyInA.push(n);
        }
        for (const n of namesB) {
          if (!namesA.has(n)) result.roleCollections.onlyInB.push(n);
        }
      } catch (_) {}

      // Compare users
      try {
        const scopeA = `--subaccount "${subaccountGUID_A}"`;
        const scopeB = `--subaccount "${subaccountGUID_B}"`;
        const originsA = getOriginKeys(scopeA);
        const originsB = getOriginKeys(scopeB);
        const emailsA = new Set();
        const emailsB = new Set();
        for (const o of originsA) {
          try { const l = btpCliSafe(`list security/user --of-idp "${o}" ${scopeA}`); (Array.isArray(l) ? l : l.value || []).forEach(u => emailsA.add(typeof u === "string" ? u : u.username || u.mail)); } catch (_) {}
        }
        for (const o of originsB) {
          try { const l = btpCliSafe(`list security/user --of-idp "${o}" ${scopeB}`); (Array.isArray(l) ? l : l.value || []).forEach(u => emailsB.add(typeof u === "string" ? u : u.username || u.mail)); } catch (_) {}
        }
        for (const e of emailsA) {
          if (emailsB.has(e)) result.users.inBoth.push(e);
          else result.users.onlyInA.push(e);
        }
        for (const e of emailsB) {
          if (!emailsA.has(e)) result.users.onlyInB.push(e);
        }
      } catch (_) {}

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ─── CF App Scaling Analysis ──────────────────────────────────────────────
  server.tool(
    "cf_app_scaling_analysis",
    "Right-sizing analysis for CF applications. Compares allocated memory/disk vs. actual usage for all running apps. Identifies over-provisioned apps (wasting resources) and under-provisioned apps (risk of OOM). Provides concrete scaling recommendations.",
    {
      orgGUID: z.string().nullable().optional().describe("Optional: filter by CF org GUID"),
    },
    async ({ orgGUID }) => {
      const params = new URLSearchParams({ include: "space.organization" });
      if (orgGUID) params.set("organization_guids", orgGUID);
      const { resources: apps, included } = await cfGetAll(`/v3/apps?${params}`);

      const spaceMap = Object.fromEntries((included.spaces || []).map(s => [s.guid, s]));
      const orgMap = Object.fromEntries((included.organizations || []).map(o => [o.guid, o.name]));

      const runningApps = apps.filter(a => a.state === "STARTED");
      const analyses = [];

      for (const app of runningApps) {
        const spaceGuid = app.relationships?.space?.data?.guid;
        const space = spaceMap[spaceGuid];
        const orgGuid = space?.relationships?.organization?.data?.guid;

        try {
          const procData = await cfGet(`/v3/apps/${app.guid}/processes`);
          const webProc = (procData.resources || []).find(p => p.type === "web");
          if (!webProc) continue;

          let stats = null;
          try {
            const statsData = await cfGet(`/v3/processes/${webProc.guid}/stats`);
            stats = statsData.resources || [];
          } catch (_) { continue; }

          const allocatedMB = webProc.memory_in_mb;
          const allocatedDiskMB = webProc.disk_in_mb;
          const instances = webProc.instances;

          // Calculate peak usage across all instances
          let peakMemMB = 0, peakDiskMB = 0, avgCpu = 0;
          let activeInstances = 0;
          for (const s of stats) {
            if (s.state !== "RUNNING") continue;
            activeInstances++;
            const memMB = s.usage?.mem ? Math.round(s.usage.mem / 1024 / 1024) : 0;
            const diskMB = s.usage?.disk ? Math.round(s.usage.disk / 1024 / 1024) : 0;
            if (memMB > peakMemMB) peakMemMB = memMB;
            if (diskMB > peakDiskMB) peakDiskMB = diskMB;
            avgCpu += (s.usage?.cpu || 0);
          }
          if (activeInstances > 0) avgCpu = avgCpu / activeInstances;

          const memUsagePct = allocatedMB > 0 ? Math.round((peakMemMB / allocatedMB) * 100) : 0;
          const diskUsagePct = allocatedDiskMB > 0 ? Math.round((peakDiskMB / allocatedDiskMB) * 100) : 0;

          let recommendation = "OK";
          let details = null;
          if (memUsagePct < 30 && allocatedMB > 256) {
            recommendation = "OVER_PROVISIONED";
            const suggested = Math.max(256, Math.ceil(peakMemMB * 1.5 / 64) * 64); // Round up to 64MB
            details = `Memory: using ${peakMemMB}MB of ${allocatedMB}MB (${memUsagePct}%). Suggest: ${suggested}MB — saves ${(allocatedMB - suggested) * instances}MB total`;
          } else if (memUsagePct > 85) {
            recommendation = "UNDER_PROVISIONED";
            const suggested = Math.ceil(peakMemMB * 1.3 / 64) * 64;
            details = `Memory: using ${peakMemMB}MB of ${allocatedMB}MB (${memUsagePct}%). Risk of OOM. Suggest: ${suggested}MB`;
          }

          analyses.push({
            app: app.name,
            guid: app.guid,
            space: space?.name || "unknown",
            org: orgMap[orgGuid] || "unknown",
            instances,
            activeInstances,
            allocated: { memoryMB: allocatedMB, diskMB: allocatedDiskMB },
            peakUsage: { memoryMB: peakMemMB, diskMB: peakDiskMB, cpuPercent: Math.round(avgCpu * 10000) / 100 },
            memUsagePercent: memUsagePct,
            diskUsagePercent: diskUsagePct,
            recommendation,
            details,
          });
        } catch (_) {}
      }

      // Sort: under-provisioned first, then over-provisioned, then OK
      const order = { UNDER_PROVISIONED: 0, OVER_PROVISIONED: 1, OK: 2 };
      analyses.sort((a, b) => (order[a.recommendation] ?? 3) - (order[b.recommendation] ?? 3));

      const overProv = analyses.filter(a => a.recommendation === "OVER_PROVISIONED");
      const underProv = analyses.filter(a => a.recommendation === "UNDER_PROVISIONED");
      const totalWastedMB = overProv.reduce((sum, a) => {
        const suggested = Math.max(256, Math.ceil(a.peakUsage.memoryMB * 1.5 / 64) * 64);
        return sum + (a.allocated.memoryMB - suggested) * a.instances;
      }, 0);

      return {
        content: [{ type: "text", text: JSON.stringify({
          summary: {
            totalRunningApps: runningApps.length,
            analyzed: analyses.length,
            overProvisioned: overProv.length,
            underProvisioned: underProv.length,
            ok: analyses.length - overProv.length - underProv.length,
            totalWastedMemoryMB: totalWastedMB,
          },
          apps: analyses,
        }, null, 2) }],
      };
    }
  );

  // ─── BTP Change History ───────────────────────────────────────────────────
  server.tool(
    "btp_change_history",
    "Timeline of platform changes: who changed what and when. Correlates BTP audit events with user names for a human-readable change log. Useful for incident analysis and change management.",
    {
      daysBack: z.number().nullable().optional().default(7).describe("How many days of history (default: 7)"),
      entityType: z.string().nullable().optional().describe("Optional filter: 'Subaccount', 'Directory', 'GlobalAccount', 'Entitlement'"),
    },
    async ({ daysBack = 7, entityType }) => {
      const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
      const params = new URLSearchParams({
        fromDate,
        sortField: "createdAt",
        sortOrder: "desc",
      });
      if (entityType) params.set("entityType", entityType);
      const data = await eventsGet(`/cloud-management/v1/events?${params}`);
      const events = (data.events || data.value || []);

      const timeline = events.map(e => ({
        timestamp: e.createdAt || e.created_at,
        eventType: e.eventType || e.type,
        entityType: e.entityType,
        entityId: e.entityId,
        description: e.description || null,
        triggeredBy: e.triggeredBy?.name || e.triggeredBy?.email || e.actor?.name || "system",
        details: e.eventData || e.parameters || null,
      }));

      // Group by day for summary
      const byDay = {};
      for (const e of timeline) {
        const day = (e.timestamp || "").substring(0, 10);
        if (!byDay[day]) byDay[day] = [];
        byDay[day].push(e.eventType);
      }
      const dailySummary = Object.entries(byDay)
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([day, types]) => ({
          date: day,
          totalEvents: types.length,
          types: [...new Set(types)],
        }));

      return {
        content: [{ type: "text", text: JSON.stringify({
          daysBack,
          fromDate,
          totalEvents: timeline.length,
          dailySummary,
          events: timeline,
        }, null, 2) }],
      };
    }
  );

  // ─── FinOps Analyst Report ────────────────────────────────────────────────
  server.tool(
    "btp_finops_report",
    "FinOps Analyst Module (Whitepaper Modul 2): Memory waste cost analysis, zombie resource detection with cost impact, burn-rate trend from historical snapshots, and month-end waste projection. If BTP_UDM_BASE_URL is configured, fetches actual service consumption data from the SAP Usage Data Management Service. Implements proactive FinOps monitoring per the BTP Digital Advisor concept.",
    {
      month: z.string().nullable().optional().describe("Month for UDM consumption query in YYYY-MM format (default: current month)"),
      zombieThresholdDays: z.number().nullable().optional().default(30).describe("Flag stopped apps / unbound instances not updated in this many days (default: 30)"),
    },
    async ({ month, zombieThresholdDays = 30 }) => {
      const targetMonth = month || new Date().toISOString().substring(0, 7);
      const thresholdMs  = zombieThresholdDays * 24 * 60 * 60 * 1000;
      const now = Date.now();

      const report = {
        generatedAt: new Date().toISOString(),
        month: targetMonth,
        udmAvailable: !!(UDM_BASE_URL && UDM_TOKEN_URL && UDM_CLIENT_ID && UDM_CLIENT_SECRET),
        consumption: null,
        zombieApps: [],
        zombieInstances: [],
        burnRate: null,
        efficiencyScore: null,
        summary: {},
      };

      // ── 1. UDM Consumption (if configured) ──────────────────────────────
      if (report.udmAvailable) {
        try {
          const token = await getUdmToken();
          const res = await fetch(
            `${UDM_BASE_URL}/reports/v1/monthlyUsage?fromDate=${targetMonth}&toDate=${targetMonth}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (res.ok) {
            const raw = await res.json();
            const entries = raw.reportEntries || raw.content || [];
            // Group by subaccount
            const bySubaccount = {};
            for (const e of entries) {
              const sa = e.subaccountName || e.subaccountId || "Global";
              if (!bySubaccount[sa]) bySubaccount[sa] = [];
              bySubaccount[sa].push({
                service: e.serviceName,
                plan: e.planName,
                metric: e.metric,
                usage: e.usage,
                unit: e.unit,
                environment: e.environmentName || null,
              });
            }
            // Top consumers
            const topConsumers = Object.entries(bySubaccount)
              .map(([sa, items]) => ({ subaccount: sa, serviceCount: items.length, items }))
              .sort((a, b) => b.serviceCount - a.serviceCount);
            report.consumption = {
              source: "UDM",
              month: targetMonth,
              totalEntries: entries.length,
              subaccountCount: topConsumers.length,
              bySubaccount: Object.fromEntries(topConsumers.map(c => [c.subaccount, c.items])),
              topConsumers: topConsumers.slice(0, 5).map(c => ({ subaccount: c.subaccount, serviceCount: c.serviceCount })),
            };
          } else {
            const body = await res.text();
            report.consumption = { source: "UDM", error: `HTTP ${res.status}: ${body}` };
          }
        } catch (e) {
          report.consumption = { source: "UDM", error: e.message };
        }
      }

      // ── 2. Zombie CF Apps (stopped + not updated in threshold) ──────────
      try {
        const params = new URLSearchParams({ include: "space.organization", states: "STOPPED" });
        const { resources: stoppedApps, included } = await cfGetAll(`/v3/apps?${params}`);
        const spaceMap = Object.fromEntries((included.spaces || []).map(s => [s.guid, s]));
        const orgMap   = Object.fromEntries((included.organizations || []).map(o => [o.guid, o.name]));

        // Fetch process details for memory cost — parallel
        const detailTasks = stoppedApps
          .filter(app => (now - new Date(app.updated_at).getTime()) > thresholdMs)
          .map(async app => {
            const spaceGuid = app.relationships?.space?.data?.guid;
            const space     = spaceMap[spaceGuid];
            const orgGuid   = space?.relationships?.organization?.data?.guid;
            const daysSince = Math.floor((now - new Date(app.updated_at).getTime()) / (24 * 60 * 60 * 1000));
            let memoryMB = 0, instances = 1;
            try {
              const procs = await cfGet(`/v3/apps/${app.guid}/processes`);
              const web = (procs.resources || []).find(p => p.type === "web") || (procs.resources || [])[0];
              if (web) { memoryMB = web.memory_in_mb || 0; instances = web.instances || 1; }
            } catch (_) {}
            return {
              name: app.name,
              guid: app.guid,
              org: orgMap[orgGuid] || "unknown",
              space: space?.name || "unknown",
              updatedAt: app.updated_at,
              daysSinceUpdate: daysSince,
              allocatedMemoryMB: memoryMB,
              instances,
              wastedQuotaMB: memoryMB * instances,
              isDeployer: isDeployerApp(app.name),
            };
          });
        const results = await Promise.allSettled(detailTasks);
        report.zombieApps = results
          .filter(r => r.status === "fulfilled")
          .map(r => r.value)
          .filter(a => !a.isDeployer)                          // exclude deployer artifacts
          .sort((a, b) => b.wastedQuotaMB - a.wastedQuotaMB); // heaviest first
      } catch (e) {
        report.zombieApps = [{ error: e.message }];
      }

      // ── 3. Zombie Service Instances (no CF bindings, old) ───────────────
      try {
        const [siResult, bindResult] = await Promise.all([
          cfGetAll("/v3/service_instances?include=space.organization,service_plan.service_offering"),
          cfGetAll("/v3/service_credential_bindings"),
        ]);
        const boundGuids = new Set(
          (bindResult.resources || []).map(b => b.relationships?.service_instance?.data?.guid).filter(Boolean)
        );
        const spaceMap2   = Object.fromEntries((siResult.included.spaces || []).map(s => [s.guid, s]));
        const orgMap2     = Object.fromEntries((siResult.included.organizations || []).map(o => [o.guid, o.name]));
        const planMap     = Object.fromEntries((siResult.included.service_plans || []).map(p => [p.guid, p]));
        const offeringMap = Object.fromEntries((siResult.included.service_offerings || []).map(o => [o.guid, o]));

        for (const si of siResult.resources) {
          if (si.type === "user-provided") continue;
          const age = now - new Date(si.created_at).getTime();
          if (!boundGuids.has(si.guid) && age > thresholdMs) {
            const spaceGuid = si.relationships?.space?.data?.guid;
            const space     = spaceMap2[spaceGuid];
            const orgGuid   = space?.relationships?.organization?.data?.guid;
            const plan      = planMap[si.relationships?.service_plan?.data?.guid];
            const offering  = offeringMap[plan?.relationships?.service_offering?.data?.guid];
            report.zombieInstances.push({
              name: si.name,
              guid: si.guid,
              service: offering?.name || "unknown",
              plan: plan?.name || "unknown",
              space: space?.name || "unknown",
              org: orgMap2[orgGuid] || "unknown",
              createdAt: si.created_at,
              ageDays: Math.floor(age / (24 * 60 * 60 * 1000)),
            });
          }
        }
        report.zombieInstances.sort((a, b) => b.ageDays - a.ageDays);
      } catch (e) {
        report.zombieInstances = [{ error: e.message }];
      }

      // ── 4. Burn-Rate from history snapshots ──────────────────────────────
      const history = loadHistory();
      if (history.length >= 2) {
        const window = history.slice(-10); // up to last 10 snapshots
        const oldest = window[0];
        const newest = window[window.length - 1];
        const spanMs = new Date(newest.t) - new Date(oldest.t);
        const spanDays = spanMs / (24 * 60 * 60 * 1000);

        if (spanDays >= 0.01) {
          const wastedDelta  = newest.wastedMemoryMB - oldest.wastedMemoryMB;
          const stoppedDelta = newest.cfStopped      - oldest.cfStopped;
          const wastedPerDay = wastedDelta / spanDays;
          const stoppedPerDay = stoppedDelta / spanDays;

          const today = new Date();
          const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
          const dayOfMonth  = today.getDate();
          const daysLeft    = daysInMonth - dayOfMonth;

          const projectedWastedMB = Math.max(0, Math.round(newest.wastedMemoryMB + wastedPerDay * daysLeft));

          report.burnRate = {
            basedOnSnapshots: window.length,
            spanDays: Math.round(spanDays * 10) / 10,
            currentWastedMemoryMB: newest.wastedMemoryMB,
            currentWastedMemoryGB: (newest.wastedMemoryMB / 1024).toFixed(2),
            wastedTrendMBPerDay: Math.round(wastedPerDay * 10) / 10,
            stoppedAppsTrendPerDay: Math.round(stoppedPerDay * 10) / 10,
            daysLeftInMonth: daysLeft,
            projectedMonthEndWastedMB: projectedWastedMB,
            projectedMonthEndWastedGB: (projectedWastedMB / 1024).toFixed(2),
            trend: wastedPerDay > 5 ? "INCREASING" : wastedPerDay < -5 ? "DECREASING" : "STABLE",
          };
        }
      }

      // ── 5. Efficiency Score ───────────────────────────────────────────────
      // Uses current history snapshot if available
      const latestSnap = history.length > 0 ? history[history.length - 1] : null;
      if (latestSnap && latestSnap.runningMemoryMB + latestSnap.wastedMemoryMB > 0) {
        const total = latestSnap.runningMemoryMB + latestSnap.wastedMemoryMB;
        const eff   = Math.round((latestSnap.runningMemoryMB / total) * 100);
        report.efficiencyScore = {
          value: eff,
          label: eff >= 85 ? "GOOD" : eff >= 65 ? "FAIR" : "POOR",
          runningMemoryMB: latestSnap.runningMemoryMB,
          wastedMemoryMB: latestSnap.wastedMemoryMB,
          interpretation: `${eff}% of allocated CF memory is actively used. ${100 - eff}% is wasted by stopped apps.`,
        };
      }

      // ── Summary ───────────────────────────────────────────────────────────
      const zombieAppsClean = report.zombieApps.filter(a => !a.error);
      const zombieInstancesClean = report.zombieInstances.filter(i => !i.error);
      const totalZombieWasteMB = zombieAppsClean.reduce((s, a) => s + (a.wastedQuotaMB || 0), 0);

      report.summary = {
        zombieAppsFound: zombieAppsClean.length,
        zombieInstancesFound: zombieInstancesClean.length,
        totalZombieWasteGB: (totalZombieWasteMB / 1024).toFixed(2),
        efficiencyScore: report.efficiencyScore?.value ?? null,
        efficiencyLabel: report.efficiencyScore?.label ?? null,
        burnRateTrend: report.burnRate?.trend ?? "UNKNOWN",
        projectedMonthEndWasteGB: report.burnRate?.projectedMonthEndWastedGB ?? null,
        udmAvailable: report.udmAvailable,
        recommendation: zombieAppsClean.length > 0
          ? `${zombieAppsClean.length} zombie apps allocate ${(totalZombieWasteMB / 1024).toFixed(1)} GB quota. Run btp_cleanup_recommendations for deletion candidates.`
          : "No zombie CF apps found beyond threshold.",
      };

      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 3 — Nice to Have
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── BTP Best Practice Check ──────────────────────────────────────────────
  server.tool(
    "btp_best_practice_check",
    "Automated check against SAP BTP best practices and security recommendations. Checks: subaccounts with missing custom IdP trust, admin users without custom IdP, production apps with single instances, service keys vs. bindings usage, and more.",
    {},
    async () => {
      const checks = [];

      // 1. Subaccounts without custom IdP trust
      try {
        const subData = await cisGet("/accounts/v1/subaccounts?derivedAuthorizations=any");
        const subaccounts = subData.value || [];
        for (const sa of subaccounts) {
          const scope = `--subaccount "${sa.guid}"`;
          const origins = getOriginKeys(scope);
          const hasCustomIdP = origins.some(o => o !== "sap.default");
          if (!hasCustomIdP) {
            checks.push({
              severity: "HIGH",
              category: "Security",
              check: "Missing Custom IdP Trust",
              resource: `Subaccount: ${sa.displayName}`,
              detail: "No custom identity provider configured — users can only authenticate via SAP default IdP. Configure a custom IdP (e.g. Azure AD, IAS) for enterprise SSO.",
            });
          }
        }
      } catch (_) {}

      // 2. Production apps with single instance
      try {
        const { resources: apps, included } = await cfGetAll("/v3/apps?include=space.organization");
        const spaceMap = Object.fromEntries((included.spaces || []).map(s => [s.guid, s]));
        const orgMap = Object.fromEntries((included.organizations || []).map(o => [o.guid, o.name]));

        for (const app of apps) {
          if (app.state !== "STARTED") continue;
          try {
            const procData = await cfGet(`/v3/apps/${app.guid}/processes`);
            const webProc = (procData.resources || []).find(p => p.type === "web");
            if (webProc && webProc.instances === 1) {
              const spaceGuid = app.relationships?.space?.data?.guid;
              const space = spaceMap[spaceGuid];
              const orgGuid = space?.relationships?.organization?.data?.guid;
              checks.push({
                severity: "MEDIUM",
                category: "Availability",
                check: "Single Instance App",
                resource: `App: ${app.name} (${space?.name || "?"} / ${orgMap[orgGuid] || "?"})`,
                detail: "Running with only 1 instance — no high availability. Scale to 2+ instances for production workloads.",
              });
            }
          } catch (_) {}
        }
      } catch (_) {}

      // 3. Service keys vs bindings (prefer bindings)
      try {
        const { resources: bindings } = await cfGetAll("/v3/service_credential_bindings");
        const serviceKeys = bindings.filter(b => b.type === "key");
        if (serviceKeys.length > 0) {
          checks.push({
            severity: "LOW",
            category: "Security",
            check: "Service Keys in Use",
            resource: `${serviceKeys.length} service key(s) found`,
            detail: "Service keys are long-lived credentials. Prefer service bindings (type: app) which are automatically rotated when an app restages.",
          });
        }
      } catch (_) {}

      // 4. Apps with health_check_type = "process" (should be http or port)
      try {
        const { resources: apps } = await cfGetAll("/v3/apps");
        for (const app of apps) {
          if (app.state !== "STARTED") continue;
          try {
            const procData = await cfGet(`/v3/apps/${app.guid}/processes`);
            const webProc = (procData.resources || []).find(p => p.type === "web");
            if (webProc && webProc.health_check?.type === "process") {
              checks.push({
                severity: "MEDIUM",
                category: "Reliability",
                check: "Process-only Health Check",
                resource: `App: ${app.name}`,
                detail: "Using 'process' health check — CF only checks if process is running, not if it serves traffic. Switch to 'http' or 'port' for better crash detection.",
              });
            }
          } catch (_) {}
        }
      } catch (_) {}

      // Sort by severity
      const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
      checks.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

      const high = checks.filter(c => c.severity === "HIGH").length;
      const medium = checks.filter(c => c.severity === "MEDIUM").length;
      const low = checks.filter(c => c.severity === "LOW").length;

      return {
        content: [{ type: "text", text: JSON.stringify({
          summary: { totalFindings: checks.length, high, medium, low },
          findings: checks,
        }, null, 2) }],
      };
    }
  );

  // ─── CF Network Topology ──────────────────────────────────────────────────
  server.tool(
    "cf_network_topology",
    "Build a dependency graph of the CF landscape: which apps are bound to which services, which routes point to which apps. Returns a structured adjacency list that can be visualized as a Mermaid diagram. Essential for understanding service dependencies and blast radius.",
    {
      orgGUID: z.string().nullable().optional().describe("Optional: filter by CF org GUID"),
    },
    async ({ orgGUID }) => {
      const appParams = new URLSearchParams({ include: "space.organization" });
      if (orgGUID) appParams.set("organization_guids", orgGUID);

      const [appResult, bindResult, siResult, routeResult] = await Promise.all([
        cfGetAll(`/v3/apps?${appParams}`),
        cfGetAll("/v3/service_credential_bindings?include=app,service_instance"),
        cfGetAll("/v3/service_instances?include=service_plan.service_offering"),
        cfGetAll("/v3/routes"),
      ]);

      const spaceMap = Object.fromEntries((appResult.included.spaces || []).map(s => [s.guid, s]));
      const orgMap = Object.fromEntries((appResult.included.organizations || []).map(o => [o.guid, o.name]));
      const offeringMap = Object.fromEntries((siResult.included.service_offerings || []).map(o => [o.guid, o]));
      const planMap = Object.fromEntries((siResult.included.service_plans || []).map(p => [p.guid, p]));

      // Build app nodes
      const nodes = { apps: {}, services: {}, routes: {} };
      const edges = [];

      for (const app of appResult.resources) {
        const spaceGuid = app.relationships?.space?.data?.guid;
        const space = spaceMap[spaceGuid];
        const orgGuid = space?.relationships?.organization?.data?.guid;
        nodes.apps[app.guid] = {
          type: "app",
          name: app.name,
          state: app.state,
          space: space?.name || "unknown",
          org: orgMap[orgGuid] || "unknown",
        };
      }

      for (const si of siResult.resources) {
        const plan = planMap[si.relationships?.service_plan?.data?.guid];
        const offering = offeringMap[plan?.relationships?.service_offering?.data?.guid];
        nodes.services[si.guid] = {
          type: "service",
          name: si.name,
          offering: offering?.name || "unknown",
          plan: plan?.name || "unknown",
        };
      }

      // App ↔ Service edges (from bindings)
      for (const b of bindResult.resources) {
        const appGuid = b.relationships?.app?.data?.guid;
        const siGuid = b.relationships?.service_instance?.data?.guid;
        if (appGuid && siGuid) {
          edges.push({
            from: appGuid,
            fromType: "app",
            to: siGuid,
            toType: "service",
            relation: "bound_to",
            bindingType: b.type,
          });
        }
      }

      // Route → App edges
      for (const route of routeResult.resources) {
        nodes.routes[route.guid] = {
          type: "route",
          url: route.url,
          host: route.host,
        };
        // Fetch destinations for each route
        try {
          const destData = await cfGet(`/v3/routes/${route.guid}/destinations`);
          for (const dest of (destData.destinations || [])) {
            const appGuid = dest.app?.guid;
            if (appGuid) {
              edges.push({
                from: route.guid,
                fromType: "route",
                to: appGuid,
                toType: "app",
                relation: "routes_to",
                port: dest.port || null,
              });
            }
          }
        } catch (_) {}
      }

      // Build Mermaid diagram
      const mermaidLines = ["graph LR"];
      for (const [guid, app] of Object.entries(nodes.apps)) {
        const short = guid.substring(0, 8);
        const icon = app.state === "STARTED" ? "✅" : "⛔";
        mermaidLines.push(`  APP_${short}["${icon} ${app.name}"]`);
      }
      for (const [guid, svc] of Object.entries(nodes.services)) {
        const short = guid.substring(0, 8);
        mermaidLines.push(`  SVC_${short}[("${svc.offering}/${svc.name}")]`);
      }
      for (const edge of edges) {
        const fromShort = edge.from.substring(0, 8);
        const toShort = edge.to.substring(0, 8);
        const fromPrefix = edge.fromType === "app" ? "APP" : edge.fromType === "route" ? "RT" : "SVC";
        const toPrefix = edge.toType === "app" ? "APP" : edge.toType === "route" ? "RT" : "SVC";
        if (edge.relation === "bound_to") {
          mermaidLines.push(`  ${fromPrefix}_${fromShort} -->|bound| ${toPrefix}_${toShort}`);
        } else if (edge.relation === "routes_to") {
          mermaidLines.push(`  ${fromPrefix}_${fromShort} -->|route| ${toPrefix}_${toShort}`);
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({
          summary: {
            apps: Object.keys(nodes.apps).length,
            services: Object.keys(nodes.services).length,
            routes: Object.keys(nodes.routes).length,
            bindings: edges.filter(e => e.relation === "bound_to").length,
            routeMappings: edges.filter(e => e.relation === "routes_to").length,
          },
          nodes,
          edges,
          mermaidDiagram: mermaidLines.join("\n"),
        }, null, 2) }],
      };
    }
  );

  return server;
}

// --- Express + Streamable HTTP Transport ---
const app = express();
app.use(express.json());
const transports = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports.has(sessionId)) {
    // Existing session — route to stored transport
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId && !transports.has(sessionId)) {
    // Unknown session ID — reject instead of creating uninitialized transport
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unknown session" },
      id: null,
    });
    return;
  }

  // No session ID — new initialize request
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      transports.set(sessionId, transport);
      console.log(`New session: ${sessionId}`);
    },
  });
  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports.has(sessionId)) {
    return res.status(400).json({ error: "No active session" });
  }

  // Send SSE keepalive pings every 20s to prevent Docker/proxy idle-TCP timeout (which fires at ~60s)
  // LibreChat treats any 60s idle as a disconnect → state=error → tool calls blocked
  const keepalive = setInterval(() => {
    if (!res.writableEnded) {
      res.write(":\n\n");
    } else {
      clearInterval(keepalive);
    }
  }, 20000);
  req.on("close", () => clearInterval(keepalive));

  await transports.get(sessionId).handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
    console.log(`Session closed: ${sessionId}`);
  } else {
    res.status(200).end();
  }
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", name: "btp-mcp-server", sessions: transports.size });
});

const httpServer = app.listen(PORT, "0.0.0.0", () => {
  console.log(`btp-mcp-server listening on port ${PORT}`);
  console.log(`  MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
});
// Disable timeouts to prevent SSE streams from dropping every ~60s
httpServer.timeout = 0;
httpServer.keepAliveTimeout = 0;
httpServer.headersTimeout = 0;
httpServer.requestTimeout = 0;