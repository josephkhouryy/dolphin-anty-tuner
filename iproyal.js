/**
 * iproyal.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Handles all IPRoyal proxy interactions using SESSION-BASED rotation.
 *
 * How IPRoyal rotation works (your plan):
 *   Your proxy string looks like:
 *   http://USERNAME:PASSWORD_country-us_session-XXXXX_lifetime-168h_streaming-1@geo.iproyal.com:12321
 *
 *   To get a NEW IP, you simply change the "_session-XXXXX" part to a new
 *   random string. IPRoyal treats it as a new session and assigns a fresh IP.
 *   No rotation link needed!
 *
 * Functions:
 *   rotateAndGetIP() → string  builds a new session proxy URL → returns the new IP
 *   buildProxyUrl()  → string  returns the current proxy URL (used by vision.js)
 *   getCurrentSessionId() → string  the session ID used in the last rotation
 */

'use strict';

require('dotenv').config();
const axios = require('axios');
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

// We store the current session ID so vision.js can use the same session
let currentSessionId = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generates a random 8-character session ID (letters + numbers).
 * Changing this to a new value forces IPRoyal to assign a fresh IP.
 */
function generateSessionId() {
  return randomBytes(4).toString('hex'); // e.g. "a3f8c1d2"
}

/**
 * Builds the full IPRoyal proxy URL with the current session ID.
 *
 * Format:
 *   http://USER:PASS_country-XX_session-ID_lifetime-YY_streaming-1@host:port
 */
function buildProxyUrl(sessionId) {
  if (!IPROYAL_HOST || !IPROYAL_PORT || !IPROYAL_USERNAME || !IPROYAL_BASE_PASSWORD) {
    throw new Error(
      '❌  Missing IPRoyal credentials in your .env file.\n' +
      '    Make sure these are set:\n' +
      '      IPROYAL_USERNAME      (e.g. G2Z51L88zI5TTRZg)\n' +
      '      IPROYAL_BASE_PASSWORD (e.g. fVZQYtIcuAykqgcx  — just the part BEFORE "_country")\n' +
      '      IPROYAL_HOST          (geo.iproyal.com)\n' +
      '      IPROYAL_PORT          (12321)'
    );
  }

  const sid = sessionId || currentSessionId || generateSessionId();
  const password = `${IPROYAL_BASE_PASSWORD}_country-${IPROYAL_COUNTRY}_session-${sid}_lifetime-${IPROYAL_LIFETIME}_streaming-${IPROYAL_STREAMING}`;

  return `http://${IPROYAL_USERNAME}:${encodeURIComponent(password)}@${IPROYAL_HOST}:${IPROYAL_PORT}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the session ID used in the last rotation (so vision.js can
 * use the same proxy session when creating the profile).
 */
function getCurrentSessionId() {
  return currentSessionId;
}

/**
 * Rotates the proxy by generating a NEW session ID, then discovers the
 * assigned IP by routing a check request through the new proxy.
 *
 * @returns {Promise<string>} The new IP address
 */
async function rotateAndGetIP({ retries = 3 } = {}) {
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
