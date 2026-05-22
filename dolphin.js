/**
 * dolphin.js — Dolphin {anty} local API client
 *
 * Local API runs at http://localhost:3001 (the Dolphin app must be open).
 * Auth flow: POST /v1.0/auth/login-with-token with the API token (one-shot,
 * session-cookie based — axios keeps the cookie in its jar via withCredentials).
 *
 * Cloud API (for editing fingerprint config of existing profiles, or creating
 * new ones programmatically) is at https://dolphin-anty-api.com/ — Bearer auth.
 *
 * Reads from .env:
 *   DOLPHIN_API_TOKEN   — from Dolphin app: Settings → API tokens → Add new
 *   DOLPHIN_LOCAL_API   — default http://localhost:3001
 *   DOLPHIN_CLOUD_API   — default https://dolphin-anty-api.com
 */
'use strict';
require('dotenv').config({ override: true });

const axios = require('axios');
const tough = (() => { try { return require('tough-cookie'); } catch { return null; } })();

const {
  DOLPHIN_API_TOKEN,
  DOLPHIN_LOCAL_API = 'http://localhost:3001',
  DOLPHIN_CLOUD_API = 'https://dolphin-anty-api.com',
} = process.env;

// ─── Local API client (session-cookie based) ─────────────────────────────────

let localClient = null;
let localAuthed = false;

function buildLocalClient() {
  if (localClient) return localClient;
  const cfg = { baseURL: DOLPHIN_LOCAL_API, timeout: 60_000, withCredentials: true, validateStatus: () => true };
  if (tough) {
    const jar = new tough.CookieJar();
    // axios-cookiejar-support if available — best effort
    try {
      const { wrapper } = require('axios-cookiejar-support');
      localClient = wrapper(axios.create({ ...cfg, jar }));
    } catch {
      localClient = axios.create(cfg);
    }
  } else {
    localClient = axios.create(cfg);
  }
  return localClient;
}

async function localAuth() {
  if (localAuthed) return;
  if (!DOLPHIN_API_TOKEN) throw new Error('DOLPHIN_API_TOKEN is not set in .env');
  const c = buildLocalClient();
  const r = await c.post('/v1.0/auth/login-with-token', { token: DOLPHIN_API_TOKEN }, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 200 || !r.data?.success) {
    throw new Error(`Local auth failed: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  }
  localAuthed = true;
}

async function localGet(path) {
  await localAuth();
  const r = await localClient.get(path);
  if (r.status !== 200) throw new Error(`GET ${path} → HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

// ─── Cloud API (Bearer auth) ──────────────────────────────────────────────────

function cloudClient() {
  if (!DOLPHIN_API_TOKEN) throw new Error('DOLPHIN_API_TOKEN is not set in .env');
  return axios.create({
    baseURL: DOLPHIN_CLOUD_API,
    timeout: 30_000,
    headers: { Authorization: `Bearer ${DOLPHIN_API_TOKEN}` },
    validateStatus: () => true,
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** List profiles (cloud). Returns array of { id, name, ... } */
async function listProfiles({ limit = 50 } = {}) {
  const c = cloudClient();
  const r = await c.get('/browser_profiles', { params: { limit } });
  if (r.status !== 200) throw new Error(`listProfiles → HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data?.data || r.data || [];
}

/**
 * Start a profile via local API. Returns { port, wsEndpoint } where:
 *   - port is the CDP port on 127.0.0.1
 *   - wsEndpoint is the path (e.g. /devtools/browser/<uuid>) — append to ws://127.0.0.1:port
 */
async function startProfile(profileId, { headless = false } = {}) {
  await localAuth();
  const params = ['automation=1'];
  if (headless) params.push('headless=1');
  const path = `/v1.0/browser_profiles/${profileId}/start?${params.join('&')}`;
  const r = await localClient.get(path);
  if (r.status !== 200 || !r.data?.success) {
    throw new Error(`startProfile → HTTP ${r.status} ${JSON.stringify(r.data)}`);
  }
  const port = r.data?.automation?.port;
  const wsEndpoint = r.data?.automation?.wsEndpoint;
  if (!port || !wsEndpoint) throw new Error(`startProfile: no port/wsEndpoint in ${JSON.stringify(r.data)}`);
  return { port, wsEndpoint, wsURL: `ws://127.0.0.1:${port}${wsEndpoint}` };
}

async function stopProfile(profileId) {
  await localAuth();
  try {
    await localClient.get(`/v1.0/browser_profiles/${profileId}/stop`);
  } catch (e) {
    // best effort
  }
}

/**
 * Create a profile via the cloud API. The Dolphin profile payload is large;
 * we accept the full object and forward it. Returns the new profile id.
 *
 * Minimum payload (everything else gets Dolphin defaults):
 *   { name: "...", platform: "windows", browserType: "anty", mainWebsite: "facebook" }
 *
 * Full fingerprint knobs (subset, see Dolphin docs for complete list):
 *   canvas: { mode: 'real' | 'noise' | 'off' }
 *   webgl:  { mode: 'real' | 'noise' | 'off' }
 *   webgpu: { mode: 'real' | 'noise' | 'off' }
 *   webgl_info: { vendor, renderer }
 *   audio:  { mode: 'real' | 'noise' | 'off' }
 *   webrtc: { mode: 'real' | 'altered' | 'disabled', ipAddress }
 *   timezone: { mode: 'auto' | 'manual', value }
 *   locale:   { mode: 'auto' | 'manual', value }
 *   geolocation: { mode: 'auto' | 'manual' | 'disabled', latitude, longitude, accuracy }
 *   cpu: { mode: 'real' | 'manual', value }       // hardwareConcurrency
 *   memory: { mode: 'real' | 'manual', value }    // deviceMemory
 *   screen: { mode: 'real' | 'manual', resolution: "1920x1080" }
 *   fonts: ['Arial', 'Helvetica', ...] | undefined
 *   useragent: { mode: 'random' | 'manual', value }
 *   proxy: { name, type: 'http' | 'socks5', host, port, login, password, changeIpUrl }
 */
async function createProfile(payload) {
  const c = cloudClient();
  const r = await c.post('/browser_profiles', payload);
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`createProfile → HTTP ${r.status} ${JSON.stringify(r.data)}`);
  }
  const id = r.data?.browserProfileId || r.data?.data?.browserProfileId || r.data?.id;
  if (!id) throw new Error(`createProfile: no id in ${JSON.stringify(r.data)}`);
  return id;
}

async function deleteProfile(profileId) {
  const c = cloudClient();
  await c.delete(`/browser_profiles/${profileId}?forceDelete=1`);
}

/** Fetch a fresh randomized fingerprint from Dolphin's cloud API. */
async function getFingerprint({ platform = 'windows', browser_type = 'anty', browser_version = '147', screen, type = 'fingerprint' } = {}) {
  const c = cloudClient();
  const params = { platform, browser_type, browser_version, type };
  if (screen) params.screen = screen;
  const r = await c.get(`/fingerprints/fingerprint`, { params });
  if (r.status !== 200) throw new Error(`getFingerprint → HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data?.data || r.data;
}

/** Fetch the list of Useragents Dolphin can use for a given platform/browser. */
async function getUserAgents({ platform = 'windows', browser_type = 'anty', browser_version = '147' } = {}) {
  const c = cloudClient();
  const r = await c.get(`/fingerprints/useragent`, { params: { platform, browser_type, browser_version } });
  if (r.status !== 200) throw new Error(`getUserAgents → HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data?.data || r.data;
}

/** Fetch a single WebGL info pair (vendor + renderer) Dolphin considers valid for the platform. */
async function getWebGlInfo({ platform = 'windows', browser_type = 'anty', browser_version = '147' } = {}) {
  const c = cloudClient();
  const r = await c.get(`/fingerprints/webgl`, { params: { platform, browser_type, browser_version } });
  if (r.status !== 200) throw new Error(`getWebGlInfo → HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return r.data?.data || r.data;
}

module.exports = {
  listProfiles,
  startProfile,
  stopProfile,
  createProfile,
  deleteProfile,
  getFingerprint,
  getUserAgents,
  getWebGlInfo,
};
