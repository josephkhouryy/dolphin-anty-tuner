/**
 * iproyal.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Proxy provider for the tuner. Two paths:
 *
 * 1. UPSTREAM (preferred): consume a pre-scored Microsoft-acceptable IP from
 *    `../Good IP Finder/output/index.jsonl`. Each row carries proxy creds +
 *    a session ID + an IP we already know. We mark the row as used in
 *    `data/consumed-ips.jsonl` so we never reuse it across two profiles.
 *
 *    See `../Good IP Finder/STATUS.md` for the ledger format and the
 *    consume-once contract.
 *
 * 2. DIRECT iproyal fallback: when no fresh row is available upstream, fall
 *    back to generating a fresh `_session-XXXX` directly against geo.iproyal.com
 *    and discover the IP via ipify. This path bypasses IPQS pre-scoring — the
 *    profile's own fingerprint judges become the only quality gate. Use sparingly.
 *
 * Public API (unchanged, callers don't need to know which path was taken):
 *   rotateAndGetIP() → Promise<string>   the IP that will be exposed
 *   buildProxyUrl()  → string            the proxy URL for the current session
 *   getCurrentSessionId() → string|null  the session ID used in the last rotation
 */

'use strict';

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { randomBytes } = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const {
  IPROYAL_HOST,
  IPROYAL_PORT,
  IPROYAL_USERNAME,
  IPROYAL_BASE_PASSWORD,   // e.g. fVZQYtIcuAykqgcx
  IPROYAL_COUNTRY = 'us',
  IPROYAL_LIFETIME = '168h',
  IPROYAL_STREAMING = '1',
} = process.env;

// Upstream ledger + local consumed-log paths. Resolved at module load so they
// don't depend on process.cwd().
const UPSTREAM_LEDGER = path.resolve(__dirname, '..', 'Good IP Finder', 'output', 'index.jsonl');
const CONSUMED_LOG = path.resolve(__dirname, 'data', 'consumed-ips.jsonl');

// Mutable state set by the last rotation. `currentUpstreamProxyUrl` is only
// non-null when the last rotation consumed an upstream row — in that case
// buildProxyUrl() returns it verbatim instead of rebuilding from local env
// (because upstream creds may differ from this folder's IPROYAL_USERNAME).
let currentSessionId = null;
let currentUpstreamProxyUrl = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateSessionId() {
  return randomBytes(4).toString('hex'); // e.g. "a3f8c1d2"
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function consumedKey(ip, sessionId) {
  return `${ip}|${sessionId}`;
}

function readConsumedKeys() {
  if (!fs.existsSync(CONSUMED_LOG)) return new Set();
  try {
    const lines = fs.readFileSync(CONSUMED_LOG, 'utf8').split('\n').filter(Boolean);
    const set = new Set();
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && row.ip && row.session) set.add(consumedKey(row.ip, row.session));
      } catch {
        // Skip malformed lines; consumed-log is best-effort, not authoritative.
      }
    }
    return set;
  } catch (e) {
    console.warn(`[upstream] could not read consumed-log (${e.message}); treating as empty`);
    return new Set();
  }
}

function appendConsumed(entry) {
  const dir = path.dirname(CONSUMED_LOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const row = {
    ts: new Date().toISOString(),
    ip: entry.ip,
    session: entry.session,
    score: entry.score,
    country: entry.country,
    source: 'good-ip-finder',
  };
  try {
    fs.appendFileSync(CONSUMED_LOG, JSON.stringify(row) + '\n');
  } catch (e) {
    console.warn(`[upstream] could not append to consumed-log: ${e.message}`);
    // Best-effort — if write fails, we may re-consume this row on next call,
    // but the worst case is wasted work, not corruption.
  }
}

/**
 * Reads the upstream ledger, returns the freshest row that:
 *   - is not a stale marker (stale !== true)
 *   - has not passed its staleAt timestamp
 *   - has not been consumed by this folder before
 * or null if no such row exists.
 *
 * Picks the latest row per (ip, session) pair per the consumer pattern in
 * STATUS.md.
 */
function findFreshUpstreamRow() {
  if (!fs.existsSync(UPSTREAM_LEDGER)) return null;
  let lines;
  try {
    lines = fs.readFileSync(UPSTREAM_LEDGER, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    console.warn(`[upstream] could not read ledger ${UPSTREAM_LEDGER}: ${e.message}`);
    return null;
  }

  // Walk in order so the LAST occurrence of each (ip, session) wins.
  const byKey = new Map();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && row.ip && row.session) byKey.set(consumedKey(row.ip, row.session), row);
    } catch {
      // Skip malformed lines.
    }
  }

  const consumed = readConsumedKeys();
  const now = Date.now();
  const candidates = [];
  for (const [key, row] of byKey) {
    if (row.stale === true) continue;
    if (row.staleAt && now > Date.parse(row.staleAt)) continue;
    if (consumed.has(key)) continue;
    if (!row.proxy || !row.proxy.host || !row.proxy.port || !row.proxy.login || !row.proxy.password) continue;
    candidates.push(row);
  }
  if (candidates.length === 0) return null;

  // Freshest first — `ts` is the score timestamp from Good IP Finder.
  candidates.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return candidates[0];
}

function buildProxyUrlFromRow(row) {
  const { type = 'http', host, port, login, password } = row.proxy;
  return `${type}://${encodeURIComponent(login)}:${encodeURIComponent(password)}@${host}:${port}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getCurrentSessionId() {
  return currentSessionId;
}

/**
 * Returns the proxy URL for the current session. When the last rotation
 * consumed an upstream row, returns that row's verbatim URL (upstream creds
 * may differ from this folder's env). Otherwise builds from env using the
 * passed sessionId, the current session, or a freshly generated one.
 */
function buildProxyUrl(sessionId) {
  // If caller didn't pin a sessionId AND we just consumed an upstream row,
  // return the upstream's URL.
  if (currentUpstreamProxyUrl && (!sessionId || sessionId === currentSessionId)) {
    return currentUpstreamProxyUrl;
  }

  if (!IPROYAL_HOST || !IPROYAL_PORT || !IPROYAL_USERNAME || !IPROYAL_BASE_PASSWORD) {
    throw new Error(
      'Missing IPRoyal credentials in .env. Required: IPROYAL_USERNAME, ' +
      'IPROYAL_BASE_PASSWORD, IPROYAL_HOST (geo.iproyal.com), IPROYAL_PORT (12321).'
    );
  }

  const sid = sessionId || currentSessionId || generateSessionId();
  const password = `${IPROYAL_BASE_PASSWORD}_country-${IPROYAL_COUNTRY}_session-${sid}_lifetime-${IPROYAL_LIFETIME}_streaming-${IPROYAL_STREAMING}`;

  return `http://${IPROYAL_USERNAME}:${encodeURIComponent(password)}@${IPROYAL_HOST}:${IPROYAL_PORT}`;
}

/**
 * Get a fresh never-used IP for the next profile build. Tries the upstream
 * ledger first; falls back to a fresh direct iproyal session if no upstream
 * row is available.
 */
async function rotateAndGetIP({ retries = 3 } = {}) {
  // ── 1. Try upstream ────────────────────────────────────────────────────────
  const upstreamRow = findFreshUpstreamRow();
  if (upstreamRow) {
    currentSessionId = upstreamRow.session;
    currentUpstreamProxyUrl = buildProxyUrlFromRow(upstreamRow);
    appendConsumed(upstreamRow);
    console.log(
      `📥  [upstream] consumed Good IP Finder row: ${upstreamRow.ip} ` +
      `(session ${upstreamRow.session}, score ${upstreamRow.score}, ${upstreamRow.country})`
    );
    return upstreamRow.ip;
  }

  // ── 2. Fall back to direct iproyal rotation ────────────────────────────────
  console.log('[upstream] no fresh row in ../Good IP Finder/output/index.jsonl; rotating direct iproyal session');
  currentUpstreamProxyUrl = null;

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const newSessionId = generateSessionId();
    currentSessionId = newSessionId;

    console.log(`🔄  Rotating proxy session ID to: ${newSessionId}${attempt > 1 ? `  (attempt ${attempt}/${retries})` : ''}`);
    await sleep(attempt === 1 ? 1_500 : 4_000);

    const proxyUrl = buildProxyUrl(newSessionId);
    const agent = new HttpsProxyAgent(proxyUrl);

    try {
      const res = await axios.get('https://api.ipify.org?format=json', {
        httpsAgent: agent, httpAgent: agent, proxy: false, timeout: 20_000,
      });
      const ip = res.data?.ip;
      if (!ip) throw new Error(`No IP in response: ${JSON.stringify(res.data)}`);
      console.log(`📍  New proxy IP: ${ip}`);
      return ip;
    } catch (err) {
      lastErr = err;
      const code = err.response?.status;
      const transient = !code || code >= 500 || ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(err.code);
      console.warn(`    ⚠  proxy check failed (${code || err.code || err.message}); ${transient && attempt < retries ? 'will retry' : 'giving up'}`);
      if (!transient || attempt === retries) break;
    }
  }
  throw new Error(`Could not rotate IPRoyal proxy after ${retries} attempts: ${lastErr?.message || lastErr}`);
}

module.exports = { rotateAndGetIP, buildProxyUrl, getCurrentSessionId };
