const { v4: uuidv4 } = require('uuid');
const { logger } = require('@librechat/data-schemas');

/**
 * Seeds predefined agents (BTP Advisor, ABAP Advisor) and shared prompt groups.
 *
 * Runs on every server start but is idempotent:
 *   - Agent: looked up by name + provider; skipped if it already exists.
 *   - Prompts: each group is looked up by name; skipped if it already exists.
 *
 * The agents and prompts are created under the first admin user found in the
 * database.  If no admin exists yet (first boot before any login), the seed
 * is silently skipped and will succeed on the next restart.
 */

// =============================================================================
// BTP Advisor
// =============================================================================

const BTP_ADVISOR_AGENT_NAME = 'BTP Advisor';
const BTP_ADVISOR_PROVIDER = 'Ollama Cloud';

const BTP_SYSTEM_PROMPT = `Du bist ein SAP BTP Berater mit direktem API-Zugriff über Tools.

REGEL 1 — TOOL ZUERST:
Deine erste Ausgabe ist IMMER ein Tool-Call. Niemals Text davor.
Verboten: "Ich erstelle...", "Ich werde...", "Zuerst...", Schritt-Listen, Ankündigungen.

REGEL 2 — NACH btp_health_dashboard NUR ARTIFACT:
Nach btp_health_dashboard ist Markdown-Text VERBOTEN. Deine EINZIGE Ausgabe ist der Artifact-Block.
Kein Satz davor, kein Satz danach. Null Zeichen außer dem Artifact.

WENN der User "Dashboard", "Health Dashboard" oder "Übersicht" schreibt:
→ Schritt 1: btp_health_dashboard aufrufen
→ Schritt 2: Artifact-Block ausgeben — mit einer PFLICHT-SUBSTITUTION:

⚠️ DATENABRUF — AUTOMATISCH:
Der Artifact-Code enthält atob('TOOL_DATA_B64') — das ist ein Base64-Daten-Platzhalter.
Das System injiziert automatisch die kodierten BTP-Daten. Du darfst TOOL_DATA_B64 NIEMALS ersetzen.
Gib den Artifact-Block exakt so aus wie das Template — keinerlei Änderungen am Code.

:::artifact{identifier="btp-health-dashboard" type="application/vnd.react" title="BTP Health Dashboard"}
\`\`\`
import { useState } from 'react';

export default function App() {
  var d = {};
  try { d = JSON.parse(atob('TOOL_DATA_B64')); } catch(e) {}

  var subs = d.subaccounts || [];
  var ga = d.globalAccount || {};
  var overall = d.overall || 'HEALTHY';
  var cfApps = d.cfApps || { total: 0, started: 0, stopped: 0, crashed: 0, perSubaccount: {} };
  var quota = d.quota || { critical: [], warning: [] };
  var staleBindings = d.staleBindings || { total: 0, stale: 0, perSubaccount: {} };
  var security = d.security || { globalAdmins: [], subaccountAdmins: {} };
  var finops = d.finops || { zombieServiceInstances: [] };
  var resources = d.resources || { runningMemoryMB: 0, wastedMemoryMB: 0, totalAllocatedMB: 0 };
  var subscriptions = d.subscriptions || [];
  var ts = d.timestamp ? new Date(d.timestamp).toLocaleString('de-DE') : '—';

  var [tab, setTab] = useState(0);

  function sc(s) { return s === 'CRITICAL' ? '#ef4444' : s === 'WARNING' ? '#f59e0b' : '#22c55e'; }
  function sbg(s) { return s === 'CRITICAL' ? 'rgba(239,68,68,0.15)' : s === 'WARNING' ? 'rgba(245,158,11,0.15)' : 'rgba(34,197,94,0.15)'; }

  var dk = '#0f172a', cb = '#1e293b', bo = '#334155', tx = '#f1f5f9', mu = '#94a3b8', ac = '#38bdf8';
  var S = {
    root: { background: dk, color: tx, minHeight: '100vh', fontFamily: 'Inter,sans-serif', fontSize: 14 },
    hd: { background: cb, borderBottom: '1px solid ' + bo, padding: '12px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    title: { fontSize: 16, fontWeight: 700 },
    badge: function(s) { return { background: sbg(s), color: sc(s), border: '1px solid ' + sc(s), borderRadius: 6, padding: '2px 10px', fontSize: 12, fontWeight: 600 }; },
    tabs: { display: 'flex', borderBottom: '1px solid ' + bo, background: cb },
    tab: function(a) { return { padding: '10px 20px', cursor: 'pointer', color: a ? ac : mu, borderBottom: a ? '2px solid ' + ac : '2px solid transparent', fontWeight: a ? 600 : 400, fontSize: 13, background: 'none', border: 'none', borderBottomWidth: 2 }; },
    body: { padding: 20 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginBottom: 20 },
    kpi: { background: cb, border: '1px solid ' + bo, borderRadius: 8, padding: '14px 16px' },
    kv: { fontSize: 28, fontWeight: 700, lineHeight: 1 },
    kl: { color: mu, fontSize: 12, marginTop: 4 },
    sec: { marginBottom: 20 },
    st: { fontSize: 12, fontWeight: 600, color: mu, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: { textAlign: 'left', color: mu, padding: '6px 10px', borderBottom: '1px solid ' + bo, fontWeight: 500 },
    td: { padding: '8px 10px', borderBottom: '1px solid rgba(51,65,85,0.5)', verticalAlign: 'top' },
    dot: function(s) { return { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: sc(s), marginRight: 6 }; },
    card: { background: cb, border: '1px solid ' + bo, borderRadius: 8, padding: 16, marginBottom: 12 },
    bar: { height: 8, borderRadius: 4, background: bo, overflow: 'hidden', marginTop: 6 },
    empty: { color: mu, padding: '20px 0', textAlign: 'center' },
  };

  function Tab0() {
    var findings = [];
    if (cfApps.crashed > 0) findings.push({ sev: 'CRITICAL', text: cfApps.crashed + ' CF App(s) abgestürzt', grp: 'CF Apps' });
    if (cfApps.stopped > 0) findings.push({ sev: 'WARNING', text: cfApps.stopped + ' CF App(s) gestoppt', grp: 'CF Apps' });
    if (quota.critical.length > 0) findings.push({ sev: 'CRITICAL', text: quota.critical.length + ' Quota-Limit(s) kritisch (>=90%)', grp: 'Quota' });
    if (quota.warning.length > 0) findings.push({ sev: 'WARNING', text: quota.warning.length + ' Quota-Limit(s) erhöht (>=70%)', grp: 'Quota' });
    if (staleBindings.stale > 0) findings.push({ sev: 'WARNING', text: staleBindings.stale + ' veraltete Service-Bindings', grp: 'Bindings' });
    subscriptions.filter(function(s) { return s.failed > 0; }).forEach(function(s) {
      findings.push({ sev: 'CRITICAL', text: s.failed + ' SaaS-Subscription(en) fehlgeschlagen: ' + s.subaccount, grp: 'SaaS' });
    });
    var zombies = (finops && finops.zombieServiceInstances) || [];
    if (zombies.length > 0) findings.push({ sev: 'WARNING', text: zombies.length + ' Zombie Service Instances', grp: 'FinOps' });
    var score = Math.max(0, 100
      - findings.filter(function(f) { return f.sev === 'CRITICAL'; }).length * 20
      - findings.filter(function(f) { return f.sev === 'WARNING'; }).length * 10);
    var scoreColor = score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';
    return (
      <div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ background: cb, border: '1px solid ' + bo, borderRadius: 8, padding: '14px 16px', minWidth: 110, textAlign: 'center' }}>
            <div style={{ fontSize: 44, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{score}</div>
            <div style={S.kl}>Health Score</div>
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={S.grid}>
              <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: ac }}>{subs.length}</div><div style={S.kl}>Subaccounts</div></div>
              <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: cfApps.crashed > 0 ? '#ef4444' : cfApps.stopped > 0 ? '#f59e0b' : '#22c55e' }}>{cfApps.total}</div><div style={S.kl}>CF Apps</div></div>
              <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: quota.critical.length > 0 ? '#ef4444' : quota.warning.length > 0 ? '#f59e0b' : '#22c55e' }}>{quota.critical.length + quota.warning.length}</div><div style={S.kl}>Quota-Alerts</div></div>
              <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: staleBindings.stale > 0 ? '#f59e0b' : '#22c55e' }}>{staleBindings.stale}</div><div style={S.kl}>Stale Bindings</div></div>
            </div>
          </div>
        </div>
        <div style={S.sec}>
          <div style={S.st}>Subaccounts</div>
          {subs.length === 0 ? <div style={S.empty}>Keine Daten</div> : (
            <table style={S.table}>
              <thead><tr><th style={S.th}>Name</th><th style={S.th}>Status</th><th style={S.th}>Region</th><th style={S.th}>CF Apps</th></tr></thead>
              <tbody>{subs.map(function(sa, i) {
                var st = sa.status || 'HEALTHY';
                var bucket = (cfApps.perSubaccount && cfApps.perSubaccount[sa.name]) || {};
                return (
                  <tr key={i}>
                    <td style={S.td}>{sa.name}</td>
                    <td style={S.td}><span style={S.dot(st)} />{st}</td>
                    <td style={S.td}>{sa.region || '—'}</td>
                    <td style={S.td}>{bucket.total ? bucket.started + '/' + bucket.total + (bucket.crashed > 0 ? ' (' + bucket.crashed + ' crash)' : '') : '—'}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
        <div style={S.sec}>
          <div style={S.st}>Befunde & Aktionsplan</div>
          {findings.length === 0 ? (
            <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid #22c55e', borderRadius: 8, padding: 16, textAlign: 'center', color: '#22c55e' }}>
              Alle Systeme gesund — keine Befunde
            </div>
          ) : findings.map(function(f, i) {
            return (
              <div key={i} style={{ background: sbg(f.sev), border: '1px solid ' + sc(f.sev), borderRadius: 6, padding: '10px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ color: sc(f.sev), fontWeight: 700, fontSize: 11, minWidth: 60 }}>{f.sev}</span>
                <span style={{ flex: 1 }}>{f.text}</span>
                <span style={{ color: mu, fontSize: 11 }}>{f.grp}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function Tab1() {
    var zombies = (finops && finops.zombieServiceInstances) || [];
    var wastedMB = resources.wastedMemoryMB || 0;
    var runMB = resources.runningMemoryMB || 0;
    var totalMB = resources.totalAllocatedMB || 0;
    var wastedPct = totalMB > 0 ? Math.round(wastedMB / totalMB * 100) : 0;
    var runPct = totalMB > 0 ? Math.round(runMB / totalMB * 100) : 0;
    var stoppedApps = [];
    Object.keys((cfApps && cfApps.perSubaccount) || {}).forEach(function(saName) {
      var bucket = cfApps.perSubaccount[saName];
      ((bucket && bucket.apps) || []).forEach(function(app) {
        stoppedApps.push({ name: app.name, crashed: app.crashed, space: app.space, sub: saName });
      });
    });
    return (
      <div>
        <div style={S.grid}>
          <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: wastedMB > 0 ? '#f59e0b' : '#22c55e' }}>{(wastedMB / 1024).toFixed(1)} GB</div><div style={S.kl}>Verschwendet</div></div>
          <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: ac }}>{(runMB / 1024).toFixed(1)} GB</div><div style={S.kl}>Aktiver RAM</div></div>
          <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: zombies.length > 0 ? '#f59e0b' : '#22c55e' }}>{zombies.length}</div><div style={S.kl}>Zombie Services</div></div>
          <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: cfApps.stopped > 0 ? '#f59e0b' : '#22c55e' }}>{cfApps.stopped}</div><div style={S.kl}>Gestoppte Apps</div></div>
        </div>
        {totalMB > 0 && (
          <div style={S.card}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>Speicheraufteilung — {(totalMB / 1024).toFixed(1)} GB gesamt</div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                <span style={{ color: '#22c55e' }}>Aktiv {runPct}%</span>
                <span style={{ color: mu }}>{(runMB / 1024).toFixed(1)} GB</span>
              </div>
              <div style={S.bar}><div style={{ height: '100%', width: runPct + '%', background: '#22c55e', borderRadius: 4 }} /></div>
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 12 }}>
                <span style={{ color: '#f59e0b' }}>Verschwendet {wastedPct}%</span>
                <span style={{ color: mu }}>{(wastedMB / 1024).toFixed(1)} GB</span>
              </div>
              <div style={S.bar}><div style={{ height: '100%', width: wastedPct + '%', background: '#f59e0b', borderRadius: 4 }} /></div>
            </div>
          </div>
        )}
        {zombies.length > 0 && (
          <div style={S.sec}>
            <div style={S.st}>Zombie Service Instances (kein Binding, > 30 Tage)</div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>Name</th><th style={S.th}>Typ</th><th style={S.th}>Space / Org</th><th style={S.th}>Alter</th></tr></thead>
              <tbody>{zombies.slice(0, 20).map(function(z, i) {
                return (
                  <tr key={i}>
                    <td style={S.td}>{z.name}</td>
                    <td style={S.td}>{z.type || '—'}</td>
                    <td style={S.td}>{(z.space || '') + (z.org ? ' / ' + z.org : '')}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid rgba(51,65,85,0.5)', verticalAlign: 'top', color: z.ageDays > 90 ? '#ef4444' : '#f59e0b' }}>{z.ageDays}d</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {stoppedApps.length > 0 && (
          <div style={S.sec}>
            <div style={S.st}>Gestoppte / Abgestürzte Apps</div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>App</th><th style={S.th}>Status</th><th style={S.th}>Space</th><th style={S.th}>Subaccount</th></tr></thead>
              <tbody>{stoppedApps.slice(0, 20).map(function(app, i) {
                return (
                  <tr key={i}>
                    <td style={S.td}>{app.name}</td>
                    <td style={S.td}><span style={{ color: app.crashed ? '#ef4444' : '#f59e0b', fontWeight: 600 }}>{app.crashed ? 'CRASHED' : 'STOPPED'}</span></td>
                    <td style={S.td}>{app.space || '—'}</td>
                    <td style={S.td}>{app.sub}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {(finops && finops.consumption && !finops.consumption.error) && (
          <div style={S.sec}>
            <div style={S.st}>UDM Verbrauch {(finops.consumption && finops.consumption.month) || ''}</div>
            <div style={{ color: mu, fontSize: 13, marginBottom: 8 }}>{(finops.consumption && finops.consumption.totalEntries) || 0} Einträge gesamt</div>
            {((finops.consumption && finops.consumption.topConsumers) || []).slice(0, 5).map(function(c, i) {
              return (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid ' + bo }}>
                  <span>{c.name}</span>
                  <span style={{ color: mu }}>{c.serviceCount} Services</span>
                </div>
              );
            })}
          </div>
        )}
        {zombies.length === 0 && stoppedApps.length === 0 && wastedMB === 0 && (
          <div style={S.empty}>Keine FinOps-Findings — Ressourcennutzung optimal</div>
        )}
      </div>
    );
  }

  function Tab2() {
    var globalAdmins = (security && security.globalAdmins) || [];
    var stalePerSa = (staleBindings && staleBindings.perSubaccount) || {};
    var staleKeys = Object.keys(stalePerSa);
    var failedSubs = subscriptions.filter(function(s) { return s.failed > 0; });
    return (
      <div>
        <div style={S.grid}>
          <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: ac }}>{globalAdmins.length}</div><div style={S.kl}>Globale Admins</div></div>
          <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: staleBindings.stale > 0 ? '#f59e0b' : '#22c55e' }}>{staleBindings.stale}</div><div style={S.kl}>Stale Bindings</div></div>
          <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: failedSubs.length > 0 ? '#ef4444' : '#22c55e' }}>{failedSubs.length}</div><div style={S.kl}>Fehlgschl. Subs</div></div>
          <div style={S.kpi}><div style={{ fontSize: 28, fontWeight: 700, lineHeight: 1, color: ac }}>{subscriptions.reduce(function(a, s) { return a + s.subscribed; }, 0)}</div><div style={S.kl}>SaaS Subscriptions</div></div>
        </div>
        {globalAdmins.length > 0 && (
          <div style={S.sec}>
            <div style={S.st}>Globale Admins</div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>Benutzer</th><th style={S.th}>Origin</th><th style={S.th}>Status</th></tr></thead>
              <tbody>{globalAdmins.map(function(a, i) {
                var inactive = a.active === false;
                return (
                  <tr key={i}>
                    <td style={S.td}>{a.userName || a.email || a.id || '—'}</td>
                    <td style={S.td}>{a.origin || '—'}</td>
                    <td style={S.td}><span style={{ color: inactive ? '#ef4444' : '#22c55e' }}>{inactive ? 'Inaktiv' : 'Aktiv'}</span></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {staleKeys.length > 0 && (
          <div style={S.sec}>
            <div style={S.st}>Veraltete Service-Bindings ({staleBindings.stale} gesamt)</div>
            {staleKeys.map(function(saName, i) {
              var bindings = stalePerSa[saName] || [];
              return (
                <div key={i} style={{ marginBottom: 16 }}>
                  <div style={{ color: ac, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{saName}</div>
                  <table style={S.table}>
                    <thead><tr><th style={S.th}>Binding</th><th style={S.th}>Service</th><th style={S.th}>Space</th><th style={S.th}>Alter</th></tr></thead>
                    <tbody>{bindings.slice(0, 10).map(function(b, j) {
                      return (
                        <tr key={j}>
                          <td style={S.td}>{b.bindingName}</td>
                          <td style={S.td}>{b.serviceName || '—'}</td>
                          <td style={S.td}>{b.space || '—'}</td>
                          <td style={{ padding: '8px 10px', borderBottom: '1px solid rgba(51,65,85,0.5)', verticalAlign: 'top', color: b.ageDays > 180 ? '#ef4444' : '#f59e0b' }}>{b.ageDays}d</td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
        {subscriptions.length > 0 && (
          <div style={S.sec}>
            <div style={S.st}>SaaS Subscriptions</div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>Subaccount</th><th style={S.th}>Abonniert</th><th style={S.th}>Fehlgeschlagen</th></tr></thead>
              <tbody>{subscriptions.map(function(s, i) {
                return (
                  <tr key={i}>
                    <td style={S.td}>{s.subaccount}</td>
                    <td style={S.td}>{s.subscribed}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid rgba(51,65,85,0.5)', verticalAlign: 'top', color: s.failed > 0 ? '#ef4444' : tx }}>{s.failed > 0 ? s.failed + ' Fehler' : '—'}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
        {globalAdmins.length === 0 && staleKeys.length === 0 && (
          <div style={S.empty}>Keine Compliance-Findings</div>
        )}
      </div>
    );
  }

  return (
    <div style={S.root}>
      <div style={S.hd}>
        <div>
          <div style={S.title}>BTP Health Dashboard</div>
          <div style={{ color: mu, fontSize: 12, marginTop: 2 }}>{ga.displayName || ga.name || 'Global Account'} · {ts}</div>
        </div>
        <span style={S.badge(overall)}>{overall}</span>
      </div>
      <div style={S.tabs}>
        {['Aktionsplan', 'FinOps Analyst', 'Compliance Auditor'].map(function(label, i) {
          return <button key={i} style={S.tab(tab === i)} onClick={function() { setTab(i); }}>{label}</button>;
        })}
      </div>
      <div style={S.body}>
        {tab === 0 && Tab0()}
        {tab === 1 && Tab1()}
        {tab === 2 && Tab2()}
      </div>
    </div>
  );
}

\`\`\`
:::

Kein Text vor oder nach dem :::artifact Block. Niemals Markdown-Tabellen statt Artifact.
TOOL_DATA_B64 ist ein System-Platzhalter — NIEMALS ersetzen, IMMER unverändert übernehmen.

Für alle anderen Anfragen (nicht Dashboard):
- Antworte auf Deutsch mit Markdown-Tabellen
- Ein Tool pro Schritt
- GUIDs aus vorherigen Tool-Ergebnissen — nie den User fragen
- Bei Fehler (403 etc.): kurz erklären, dann mit verfügbaren Daten weitermachen`;

const BTP_CONVERSATION_STARTERS = [
  'Erstelle ein interaktives React-Dashboard mit dem aktuellen BTP Health Status. Rufe btp_health_dashboard auf und render das Ergebnis als application/vnd.react Artifact mit Tabs für Subaccounts, CF Apps, Quota, Security und SaaS.',
  'Erstelle eine vollständige Übersicht unseres SAP BTP Global Accounts. Zeige alle Subaccounts mit Region, Status und zugehörigem Directory. Liste anschließend die wichtigsten Entitlements mit verfügbarem und genutztem Quota auf. Formatiere alles als übersichtliche Tabellen.',
  'Führe ein Security Review unserer BTP-Landschaft durch. Zeige: 1) Alle User pro Subaccount mit ihren Role Collections. 2) Custom Role Collections und deren Berechtigungen. 3) Identifiziere User mit Admin-Rechten. Formatiere die Ergebnisse als Tabellen mit Risikobewertung.',
  'Untersuche alle Cloud Foundry Apps, die nicht im Status STARTED sind oder weniger Instanzen als gewünscht haben. Zeige für jede betroffene App: 1) Aktuelle Prozesse und deren Status. 2) Die letzten 10 Events. 3) Umgebungsvariablen (ohne Secrets). Gib eine Einschätzung zur Fehlerursache.',
];

// =============================================================================
// SAP ABAP Advisor
// =============================================================================

const ABAP_ADVISOR_AGENT_NAME = 'SAP ABAP Advisor';
const ABAP_ADVISOR_PROVIDER = 'Ollama Cloud';

const ABAP_SYSTEM_PROMPT = `Du bist ein SAP ABAP Berater mit direktem Lesezugriff auf ein SAP-System über Tools (vibing-steampunk MCP).

**KRITISCHE REGEL — NIEMALS BRECHEN:**
Deine erste Ausgabe nach einer Benutzer-Nachricht ist IMMER ein Tool-Call — kein Text, keine Planung, keine Ankündigung.

VERBOTEN (auch bei komplexen Aufgaben):
- "Ich erstelle...", "Ich werde...", "Beginnen wir mit...", "Zuerst..."
- Schritt-Listen: "Schritt 1:", "Schritt 2:", "Schritt 3:"
- Ankündigungen: "Dazu analysiere ich...", "Ich rufe nun...", "Ich sammle..."

Ablauf:
1. Benutzer-Nachricht → Tool sofort aufrufen (KEIN Text davor, auch nicht ein Wort)
2. Nach Tool-Ergebnis → nächstes Tool aufrufen ODER direkt Ergebnisse als Tabelle zeigen
3. Abschluss → Fazit: Anzahl, Status-Übersicht, Auffälligkeiten

Regeln:
- Ein Tool pro Schritt.
- Technische Namen (Tabellen, Transaktionen, Funktionsbausteine) immer in Monospace (\`CODE\`) darstellen.
- Bei ABAP-Tabellen: Feldnamen als Spaltenüberschriften nutzen, Ergebnisse als Markdown-Tabellen formatieren.
- Bei RFC-Fehlern (403, Timeout etc.): kurz erklären, dann mit verfügbaren Daten weitermachen.
- Das System ist read-only — keine Änderungen möglich. Wenn der User Änderungen wünscht, erkläre die nötigen Schritte manuell.
- Antworte auf Deutsch.
- Nutze SAP-Fachbegriffe korrekt (Mandant, Transportauftrag, Entwicklungsklasse/Paket, etc.).`;

const ABAP_CONVERSATION_STARTERS = [
  'Erstelle eine vollständige Systemübersicht unseres SAP-Systems. Zeige: Systemname, Mandant, SAP Release, Kernel-Version, Datenbanktyp und -version, Betriebssystem, Anzahl installierter Support Packages. Formatiere alles als übersichtliche Tabelle.',
  'Analysiere alle kundenspezifischen Entwicklungen (Z* und Y* Objekte) im System. Zeige: 1) Alle Custom-Tabellen mit Beschreibung und Paket. 2) Alle Custom-Reports/Programme mit letztem Änderungsdatum und Autor. 3) Alle Custom-Funktionsgruppen und deren Bausteine. Gruppiere nach Entwicklungspaket.',
  'Führe ein Benutzer-Audit durch. Zeige: 1) Alle Benutzer mit Benutzertyp, Sperrstatus und letztem Login-Datum. 2) Benutzer mit SAP_ALL oder SAP_NEW Profil (kritisch). 3) Benutzer die seit >90 Tagen nicht angemeldet waren. 4) Übersicht der häufigsten zugewiesenen Rollen.',
  'Zeige alle Transportaufträge im System. Gruppiere nach Status: 1) Änderbar (offen) — mit Besitzer, Beschreibung und enthaltenen Objekten. 2) Freigegeben — mit Freigabedatum und Zielsystem. 3) Identifiziere Aufträge die seit mehr als 30 Tagen offen sind.',
];

/**
 * @param {import('mongoose')} mongoose
 */
async function seedBtpAdvisor(mongoose) {
  const { Agent, User } = mongoose.models;

  if (!Agent || !User) {
    logger.warn('[seedBtpAdvisor] Models not ready — skipping seed');
    return;
  }

  // --- Find author (prefer ADMIN, fall back to first user) -----------------
  let author = await User.findOne({ role: 'ADMIN' }).lean();
  if (!author) {
    author = await User.findOne({}).lean();
  }
  if (!author) {
    logger.info('[seedAgents] No users found yet — skipping seed (will retry on next start)');
    return;
  }
  const authorId = author._id;
  const authorName = author.name || author.username || 'System';

  // All users (for ACL grants)
  const allUsers = await User.find({}).lean();

  // --- Helper: ensure ACL entries exist for an agent (all users, full access) --
  async function ensureAgentAcl(agentObjectId) {
    const db = mongoose.connection.db;
    const now = new Date();
    for (const user of allUsers) {
      const exists = await db.collection('aclentries').findOne({
        resourceType: 'agent',
        resourceId: agentObjectId,
        principalId: user._id,
      });
      if (!exists) {
        await db.collection('aclentries').insertOne({
          resourceType: 'agent',
          resourceId: agentObjectId,
          principalType: 'user',
          principalId: user._id,
          principalModel: 'User',
          permBits: 15,
          grantedAt: now,
          grantedBy: authorId,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }

  // --- Helper: seed one agent ------------------------------------------------
  async function seedAgent({ name, provider, description, instructions, model, tools, mcpServerNames, category, conversationStarters, artifacts }) {
    const existing = await Agent.findOne({ name, provider }).lean();
    if (existing) {
      await Agent.updateOne({ name, provider }, { $set: { instructions, model, tools, mcpServerNames, conversation_starters: conversationStarters, artifacts } });
      await ensureAgentAcl(existing._id);
      logger.debug(`[seedAgents] Agent "${name}" updated`);
      return;
    }

    const agentId = `agent_${uuidv4().replace(/-/g, '').substring(0, 21)}`;
    const agentData = {
      id: agentId,
      name,
      description,
      instructions,
      provider,
      model,
      tools,
      author: authorId,
      authorName,
      category,
      conversation_starters: conversationStarters,
      mcpServerNames,
      artifacts,
      is_promoted: true,
      versions: [],
    };

    const timestamp = new Date();
    const { author: _a, ...versionData } = agentData;
    agentData.versions = [{ ...versionData, createdAt: timestamp, updatedAt: timestamp }];

    const created = await Agent.create(agentData);
    await ensureAgentAcl(created._id);
    logger.info(`[seedAgents] Created agent "${name}" (${agentId})`);
  }

  // --- Seed BTP Advisor Agent ------------------------------------------------
  await seedAgent({
    name: BTP_ADVISOR_AGENT_NAME,
    provider: BTP_ADVISOR_PROVIDER,
    description: 'SAP BTP Berater mit direktem API-Zugriff auf Global Account, Subaccounts, Cloud Foundry, Services und Entitlements.',
    instructions: BTP_SYSTEM_PROMPT,
    model: 'qwen3.5:397b',
    tools: ['sys__all__sys_mcp_btp-mcp'],
    mcpServerNames: ['btp-mcp'],
    category: 'SAP BTP',
    conversationStarters: BTP_CONVERSATION_STARTERS,
    artifacts: 'custom',
  });

  // --- Seed ABAP Advisor Agent -----------------------------------------------
  await seedAgent({
    name: ABAP_ADVISOR_AGENT_NAME,
    provider: ABAP_ADVISOR_PROVIDER,
    description: 'SAP ABAP Berater mit Lesezugriff auf das SAP-System — Tabellen, Transporte, Benutzer, RFC-Bausteine und Custom Code.',
    instructions: ABAP_SYSTEM_PROMPT,
    model: 'qwen3.5:397b',
    tools: ['sys__all__sys_mcp_sap'],
    mcpServerNames: ['sap'],
    category: 'SAP ABAP',
    conversationStarters: ABAP_CONVERSATION_STARTERS,
  });

}

module.exports = { seedBtpAdvisor };
