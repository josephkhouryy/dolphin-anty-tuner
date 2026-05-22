/**
 * bench.js — Score a Dolphin Anty (or Vision) profile against fingerprint.com.
 *
 * The dial-in metric is fingerprint.com's *suspect_score* (0 = clean, 100 = certain fraud).
 * fingerprint.com exposes it in two public places:
 *
 *   1. https://demo.fingerprint.com/playground
 *      Renders every Smart Signal as a labelled row (Bot / VPN / Tampering / VM /
 *      Incognito / DevTools / Privacy / IP Blocklist / High-Activity) and a numeric
 *      Suspect Score. Both the human-readable rows and the raw JSON server response
 *      are in the DOM after the SDK call finishes.
 *
 *   2. https://fingerprint.com/demo/
 *      Marketing page that embeds the same SDK call; the JSON payload appears in a
 *      <pre> block. Useful as a backup if the playground is rate-limited or down.
 *
 * Composite score (0–100, higher = trustier):
 *   - 70 pts: 70 × (1 - suspect_score / 100)
 *   - 30 pts: 3 pts each for 10 binary signals (Bot/VPN/Tampering/VM/Incognito/
 *             DevTools/Privacy/Proxy/IPBlocklist/HighActivity), awarded when the
 *             signal is "not detected" / false.
 *
 * Side trips (creepjs / sannysoft / abusedummy) are visited for screenshots and
 * the on-disk record but not scored — fingerprint.com is the ground truth Joe asked
 * for. CreepJS can be promoted to a scoring component later by reading its DOM via
 * page.locator(...).evaluate(...) once we understand its async render order.
 *
 * Connects to an already-launched Dolphin profile via CDP, visits each site in
 * its own tab, captures screenshots and the extracted signals. Appends one
 * JSONL record per call to data/bench-results.jsonl.
 */
'use strict';
require('dotenv').config({ override: true });

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── Sites ────────────────────────────────────────────────────────────────────

const SITES = [
  // Joe's manual workflow — visit before scoring so any signup cookies are warm.
  { id: 'abusedummy_signup', url: 'https://abusedummy-latest.onrender.com/signup', waitMs: 6000, scored: false },

  // Primary scoring source — the modern FP.com demo with all Smart Signals.
  { id: 'fp_playground', url: 'https://demo.fingerprint.com/playground', waitMs: 18000, scored: true },

  // Backup scoring source — the marketing demo with the raw JSON in <pre>.
  { id: 'fingerprint_com', url: 'https://fingerprint.com/demo/', waitMs: 18000, scored: true },

  // Diagnostic — sannysoft's bot table. Not scored yet; valuable in screenshots.
  { id: 'sannysoft', url: 'https://bot.sannysoft.com/', waitMs: 6000, scored: false },

  // Diagnostic — CreepJS. Not scored yet (its trust % is computed client-side and
  // we haven't pinned down the selector across async renders).
  { id: 'creepjs', url: 'https://abrahamjuliot.github.io/creepjs/', waitMs: 22000, scored: false },
];

// ─── In-browser fingerprint probe ─────────────────────────────────────────────

async function probe(page) {
  return page.evaluate(() => {
    const tryFn = (fn) => { try { return fn(); } catch (e) { return `ERR: ${e.message}`; } };
    return {
      ua: navigator.userAgent,
      uaData: tryFn(() => navigator.userAgentData?.toJSON?.() ?? null),
      platform: navigator.platform,
      hwConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      languages: navigator.languages,
      language: navigator.language,
      webdriver: navigator.webdriver,
      doNotTrack: navigator.doNotTrack,
      cookieEnabled: navigator.cookieEnabled,
      screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, dpr: window.devicePixelRatio, colorDepth: screen.colorDepth },
      timezone: tryFn(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      tzOffsetMin: new Date().getTimezoneOffset(),
      plugins: Array.from(navigator.plugins || []).map(p => p.name),
      webgl: tryFn(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (!gl) return null;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        };
      }),
      chromeRuntime: !!window.chrome?.runtime,
    };
  });
}

// ─── Fingerprint.com scraping ─────────────────────────────────────────────────

/**
 * Pull the FingerprintJS-Pro server response object out of the page. Both the
 * /demo/ page and the /playground page render it into <pre> or <code> elements.
 * Walks every such element, JSON-parses each, and returns the first one that
 * looks like an FP server response.
 */
async function extractFingerprintPayload(page) {
  return page.evaluate(() => {
    const looksLikeFpResponse = (o) => o && typeof o === 'object' && ('visitor_id' in o || 'identification' in o || 'suspect_score' in o);
    const blobs = Array.from(document.querySelectorAll('pre, code'))
      .map(el => (el.innerText || '').trim())
      .filter(t => t.length > 50 && t.includes('{'));
    for (const b of blobs) {
      // Try strict JSON first…
      try {
        const o = JSON.parse(b);
        if (looksLikeFpResponse(o)) return o;
      } catch {}
      // …then a lenient JS-object parse (the playground prints unquoted keys, like `visitor_id: "..."`).
      try {
        const fn = new Function('return (' + b + ');');
        const o = fn();
        if (looksLikeFpResponse(o)) return o;
      } catch {}
      // …then regex out the fields we care about as a last resort.
      const out = {};
      const ss   = b.match(/suspect_score[^\d-]*(-?\d+(?:\.\d+)?)/);
      const vid  = b.match(/visitor_id[^"]*"([^"]+)"/);
      const bot  = b.match(/\bbot[^\w]*"([^"]+)"/);
      const tampering = b.match(/tampering[^\w]*[:=]\s*(true|false)/);
      const vm   = b.match(/virtual_machine[^\w]*[:=]\s*(true|false)/);
      const vpn  = b.match(/\bvpn[^\w]*[:=]\s*(true|false)/);
      const incog = b.match(/incognito[^\w]*[:=]\s*(true|false)/);
      const dev  = b.match(/developer_tools[^\w]*[:=]\s*(true|false)/);
      const proxy= b.match(/\bproxy[^\w_]*[:=]\s*(true|false)/);
      const priv = b.match(/privacy_settings[^\w]*[:=]\s*(true|false)/);
      const hi   = b.match(/high_activity_device[^\w]*[:=]\s*(true|false)/);
      if (ss)  out.suspect_score = Number(ss[1]);
      if (vid) out.visitor_id = vid[1];
      if (bot) out.bot = bot[1] === 'not_detected' ? false : (bot[1] === 'detected' ? true : bot[1]);
      if (tampering) out.tampering = tampering[1] === 'true';
      if (vm)   out.virtual_machine = vm[1] === 'true';
      if (vpn)  out.vpn = vpn[1] === 'true';
      if (incog) out.incognito = incog[1] === 'true';
      if (dev)  out.developer_tools = dev[1] === 'true';
      if (proxy) out.proxy = proxy[1] === 'true';
      if (priv)  out.privacy_settings = priv[1] === 'true';
      if (hi)    out.high_activity_device = hi[1] === 'true';
      if (Object.keys(out).length) return out;
    }
    return null;
  });
}

/**
 * Parse the human-readable Smart Signals table from demo.fingerprint.com/playground.
 * Each row is a label followed by a verdict; we walk the document text and key off
 * the labels FP.com uses.
 */
async function extractPlaygroundSignals(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const lineAfter = (label) => {
      const re = new RegExp(label + '\\s*\\n+\\s*([^\\n]+)', 'i');
      const m = text.match(re);
      return m ? m[1].trim() : null;
    };
    const isPositive = (v) => v && /\bnot\s+detected\b|^false$/i.test(v);
    const isNegative = (v) => v && /\byes\b|\bdetected\b|^true$|using a vpn|tampering|virtual machine|is incognito/i.test(v);
    const sig = (label) => {
      const v = lineAfter(label);
      if (v == null) return { raw: null, flagged: null };
      if (isPositive(v)) return { raw: v, flagged: false };
      if (isNegative(v)) return { raw: v, flagged: true };
      return { raw: v, flagged: null };
    };
    const m = text.match(/Suspect Score\s*\n+\s*(-?\d+(?:\.\d+)?)/i);
    return {
      suspect_score: m ? Number(m[1]) : null,
      bot:          sig('Bot'),
      vpn:          sig('VPN'),
      tampering:    sig('Browser Tampering'),
      vm:           sig('Virtual Machine'),
      incognito:    sig('Incognito Mode'),
      dev_tools:    sig('Developer Tools'),
      privacy:      sig('Privacy Settings'),
      ip_blocklist: sig('IP Blocklist'),
      high_activity: sig('High-Activity Device'),
      // Visitor ID — handy correlation key when debugging multi-run consistency.
      visitor_id:   (text.match(/Visitor ID is\s*\n+\s*([A-Za-z0-9]+)/) || [])[1] || null,
    };
  });
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const SIGNAL_KEYS = ['bot', 'vpn', 'tampering', 'vm', 'incognito', 'dev_tools', 'privacy', 'ip_blocklist', 'high_activity', 'proxy'];

function scoreFromFpData(playgroundSignals, jsonPayload) {
  const suspect_score = playgroundSignals?.suspect_score ?? jsonPayload?.suspect_score ?? null;

  // Merge per-signal: prefer playground's human verdict, fall back to JSON booleans.
  const signals = {};
  for (const key of SIGNAL_KEYS) {
    let flagged = playgroundSignals?.[key]?.flagged;
    if (flagged == null && jsonPayload) {
      const jsonKey = key === 'vm' ? 'virtual_machine' : key === 'dev_tools' ? 'developer_tools' : key === 'privacy' ? 'privacy_settings' : key === 'ip_blocklist' ? 'ip_blocklist' : key === 'high_activity' ? 'high_activity_device' : key;
      if (jsonKey in jsonPayload) flagged = !!jsonPayload[jsonKey];
    }
    signals[key] = flagged;
  }

  // 70 points from suspect_score (linear, 0→70, 100→0). If unknown, half credit.
  let suspectPts;
  if (typeof suspect_score === 'number') suspectPts = Math.max(0, Math.min(70, Math.round(70 - 0.7 * suspect_score)));
  else                                   suspectPts = 35;

  // 30 points from binary signals (3 each, 10 signals). Unknown = half credit.
  let signalPts = 0;
  for (const key of SIGNAL_KEYS) {
    if (signals[key] === false) signalPts += 3;
    else if (signals[key] == null) signalPts += 1.5;
  }

  const total = Math.round(suspectPts + signalPts);
  return {
    total,
    breakdown: { suspectPts, signalPts: Math.round(signalPts * 10) / 10 },
    suspect_score,
    signals,
  };
}

// ─── Per-site visit ───────────────────────────────────────────────────────────

async function visitSite(ctx, site, screenshotsDir, timestamp, label) {
  console.log(`\n📍  ${site.id} → ${site.url}`);
  const page = await ctx.newPage();
  const out = { url: site.url };
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // For the FP sites: actively wait for the rendered output before scraping.
    if (site.id === 'fp_playground') {
      await page.waitForFunction(() => /Suspect Score\s*\n+\s*\d/.test(document.body.innerText || ''), { timeout: 30000 }).catch(() => {});
    } else if (site.id === 'fingerprint_com') {
      await page.waitForFunction(() => /suspect_score/.test(document.body.innerText || ''), { timeout: 30000 }).catch(() => {});
    }
    await page.waitForTimeout(site.waitMs);

    const shot = path.join(screenshotsDir, `${timestamp}_${label}_${site.id}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    out.screenshot = shot;
    out.title = await page.title().catch(() => null);

    if (site.id === 'fp_playground') {
      out.signals = await extractPlaygroundSignals(page);
      out.payload = await extractFingerprintPayload(page);
    } else if (site.id === 'fingerprint_com') {
      out.payload = await extractFingerprintPayload(page);
    } else {
      // Diagnostic-only sites: just record innerText so we can spot regressions later.
      out.text = (await page.evaluate(() => document.body.innerText || '')).slice(0, 4000);
    }

    if (out.signals?.suspect_score != null) console.log(`     suspect_score=${out.signals.suspect_score}`);
    if (out.payload?.suspect_score != null) console.log(`     (payload) suspect_score=${out.payload.suspect_score}`);
  } catch (e) {
    console.warn(`     ✗ ${site.id} failed: ${e.message}`);
    out.error = e.message;
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

async function bench({ cdpPort, profileId, label = 'unknown', visionConfig = null }) {
  const wsBase = `http://127.0.0.1:${cdpPort}`;
  console.log(`🔌  Connecting to CDP at ${wsBase} ...`);
  const browser = await chromium.connectOverCDP(wsBase);

  const ctx = browser.contexts()[0] || (await browser.newContext());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotsDir = path.join(__dirname, 'screenshots', 'bench');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // Probe runs on the playground page after it loads (real spoofing applied).
  console.log(`🧪  Visiting sites...`);
  const results = {};
  for (const site of SITES) {
    results[site.id] = await visitSite(ctx, site, screenshotsDir, timestamp, label);
  }

  // Cross-page probe — re-open playground and read navigator while we're there.
  const probeTab = await ctx.newPage();
  let probeData = null;
  try {
    await probeTab.goto('https://demo.fingerprint.com/playground', { waitUntil: 'domcontentloaded', timeout: 60000 });
    probeData = await probe(probeTab);
  } catch (e) {
    probeData = { error: e.message };
  } finally {
    await probeTab.close().catch(() => {});
  }
  await browser.close().catch(() => {});

  // Score from the playground signals + payload.
  const score = scoreFromFpData(results.fp_playground?.signals, results.fp_playground?.payload || results.fingerprint_com?.payload);

  const record = {
    timestamp,
    profileId,
    label,
    probe: probeData,
    visionConfig,
    score,
    results,
  };

  const outFile = path.join(__dirname, 'data', 'bench-results.jsonl');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, JSON.stringify(record) + '\n');

  console.log(`\n📊  Score: ${score.total}/100   suspect_score=${score.suspect_score}`);
  const flagged = Object.entries(score.signals).filter(([, v]) => v === true).map(([k]) => k);
  if (flagged.length) console.log(`     flagged: ${flagged.join(', ')}`);
  return record;
}

module.exports = { bench, scoreFromFpData, extractPlaygroundSignals, extractFingerprintPayload };

if (require.main === module) {
  const cdpPort = process.argv[2] ? parseInt(process.argv[2]) : null;
  const profileId = process.argv[3] || 'manual';
  const label = process.argv[4] || 'manual-run';
  if (!cdpPort) {
    console.error('Usage: node bench.js <cdpPort> [profileId] [label]');
    process.exit(1);
  }
  bench({ cdpPort, profileId, label }).then(() => process.exit(0)).catch(e => { console.error('💥', e); process.exit(1); });
}
