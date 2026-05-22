/**
 * bench.js — Benchmark a Vision profile against fingerprint-detection sites
 *
 * Connects to an already-launched Vision profile via CDP, then visits each
 * benchmark site in its own tab, captures a full-page screenshot, scrapes the
 * visible text, and runs a JS probe to read what the browser actually reports
 * vs. what Vision was configured to spoof.
 *
 * Results appended to data/bench-results.jsonl
 *
 * Used by:
 *   - bench-existing.js   (launch one existing profile and benchmark it)
 *   - tune.js             (iteration loop — create profile, bench, close, repeat)
 */
'use strict';
require('dotenv').config({ override: true });
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITES = [
  // Visit the user's own test signup first — mimics his manual workflow
  // (sign up, then check fingerprint.com sees a "trustworthy" returning visitor)
  { id: 'abusedummy_signup', url: 'https://abusedummy-latest.onrender.com/signup', waitMs: 8000 },
  { id: 'fingerprint_com',   url: 'https://fingerprint.com/demo/',                  waitMs: 15000 },
  { id: 'creepjs',           url: 'https://abrahamjuliot.github.io/creepjs/',       waitMs: 22000 },
  { id: 'browserleaks_bot',  url: 'https://browserleaks.com/bot',                   waitMs: 8000  },
  { id: 'pixelscan',         url: 'https://pixelscan.net/',                         waitMs: 14000 },
];

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
      webdriver: navigator.webdriver,                       // the #1 bot tell — must be false/undef
      doNotTrack: navigator.doNotTrack,
      cookieEnabled: navigator.cookieEnabled,
      screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, dpr: window.devicePixelRatio, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth },
      timezone: tryFn(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
      tzOffsetMin: new Date().getTimezoneOffset(),
      plugins: Array.from(navigator.plugins || []).map(p => p.name),
      mimeTypes: Array.from(navigator.mimeTypes || []).map(m => m.type),
      webgl: tryFn(() => {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (!gl) return null;
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          extensions: gl.getSupportedExtensions(),
        };
      }),
      canvas: tryFn(() => {
        const c = document.createElement('canvas');
        c.width = 200; c.height = 50;
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(0, 0, 100, 30);
        ctx.fillStyle = '#069';
        ctx.fillText('fp-probe-canvas-🎨', 2, 15);
        return c.toDataURL().slice(-40);                    // last 40 chars of the dataURL = stable fingerprint
      }),
      audio: tryFn(() => {
        if (!window.OfflineAudioContext && !window.webkitOfflineAudioContext) return null;
        // We can't run the full audio fingerprint synchronously, just expose what's available
        return { hasContext: true, sampleRate: new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100).sampleRate };
      }),
      mediaDevices: tryFn(async () => {
        if (!navigator.mediaDevices?.enumerateDevices) return null;
        const d = await navigator.mediaDevices.enumerateDevices();
        return d.map(x => ({ kind: x.kind, label: x.label ? '<has-label>' : '<empty>' }));
      }),
      chromeRuntime: !!window.chrome?.runtime,
      hasNotificationPermission: tryFn(() => Notification?.permission),
      permissionsState: tryFn(async () => {
        const p = await navigator.permissions.query({ name: 'notifications' });
        return p.state;
      }),
    };
  });
}

async function bench({ cdpPort, profileId, label = 'unknown', visionConfig = null }) {
  const wsBase = `http://127.0.0.1:${cdpPort}`;
  console.log(`🔌  Connecting to CDP at ${wsBase} ...`);
  const browser = await chromium.connectOverCDP(wsBase);

  const ctx = browser.contexts()[0] || (await browser.newContext());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotsDir = path.join(__dirname, 'screenshots', 'bench');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // First page: run the probe on about:blank (no detection logic interfering)
  console.log(`🧪  Running fingerprint probe...`);
  const probePage = await ctx.newPage();
  await probePage.goto('about:blank');
  const probeData = await probe(probePage);
  await probePage.close();

  const flags = [];
  if (probeData.webdriver === true) flags.push('webdriver=TRUE (instant bot flag)');
  if (probeData.hwConcurrency && probeData.hwConcurrency < 2) flags.push(`hwConcurrency=${probeData.hwConcurrency} (suspicious)`);
  if (!probeData.webgl?.renderer || probeData.webgl.renderer === 'Mesa OffScreen') flags.push(`webgl.renderer=${probeData.webgl?.renderer} (headless tell)`);
  if (probeData.plugins.length === 0 && probeData.platform?.startsWith('Win')) flags.push('plugins=[] on Windows (unusual)');
  if (probeData.languages.length === 0) flags.push('languages=[] (suspicious)');

  console.log(`   webdriver: ${probeData.webdriver}`);
  console.log(`   UA: ${probeData.ua}`);
  console.log(`   WebGL renderer: ${probeData.webgl?.renderer}`);
  console.log(`   hwConcurrency=${probeData.hwConcurrency}, deviceMemory=${probeData.deviceMemory}`);
  if (flags.length) console.log(`   ⚠️  Probe flags:\n     - ${flags.join('\n     - ')}`);

  const results = {};
  for (const site of SITES) {
    console.log(`\n📍  ${site.id} → ${site.url}`);
    const page = await ctx.newPage();
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(site.waitMs);

      const shot = path.join(screenshotsDir, `${timestamp}_${label}_${site.id}.png`);
      await page.screenshot({ path: shot, fullPage: true });

      const text = await page.evaluate(() => document.body.innerText || '');
      const title = await page.title();

      results[site.id] = {
        url: site.url,
        screenshot: shot,
        text: text.slice(0, 8000),
        title,
        extracted: extractSiteSignals(site.id, text),
      };
      console.log(`   ✓ captured ${text.length} chars + screenshot`);
      if (results[site.id].extracted) {
        for (const [k, v] of Object.entries(results[site.id].extracted)) {
          console.log(`     ${k}: ${v}`);
        }
      }
    } catch (e) {
      console.warn(`   ✗ ${site.id} failed: ${e.message}`);
      results[site.id] = { error: e.message, url: site.url };
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});

  const record = {
    timestamp,
    profileId,
    label,
    probe: probeData,
    probeFlags: flags,
    visionConfig,                        // optional: { canvas_pref, webgl_pref, ... }
    score: scoreResults(results, flags),
    results,
  };

  const outFile = path.join(__dirname, 'data', 'bench-results.jsonl');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, JSON.stringify(record) + '\n');

  console.log(`\n📊  Composite score: ${record.score.total}/100`);
  console.log(`     breakdown: ${JSON.stringify(record.score.breakdown)}`);
  console.log(`💾  Appended to ${outFile}`);
  return record;
}

// Light-touch text extraction per site — refined as we see real screenshots.
function extractSiteSignals(siteId, text) {
  const lc = text.toLowerCase();
  const out = {};
  if (siteId === 'fingerprint_com') {
    if (lc.includes('bot detection')) {
      const m = text.match(/bot\s+detection[^\n]*?\n([^\n]+)/i);
      if (m) out.botDetection = m[1].trim();
    }
    if (lc.includes('vpn detection')) out.vpnLine = (text.match(/vpn\s+detection[^\n]*?\n([^\n]+)/i) || [])[1]?.trim();
    if (lc.includes('incognito')) out.incognitoLine = (text.match(/incognito[^\n]*?\n([^\n]+)/i) || [])[1]?.trim();
    if (lc.includes('visitor id') || lc.includes('visitorid')) {
      const m = text.match(/[a-f0-9]{20,}/i);
      if (m) out.visitorIdSample = m[0];
    }
  } else if (siteId === 'creepjs') {
    const m = text.match(/(\d+(?:\.\d+)?)\s*%\s*\n?\s*trust/i) || text.match(/trust\s*score[^\d]*(\d+(?:\.\d+)?)/i);
    if (m) out.trustScorePct = parseFloat(m[1]);
    const lies = text.match(/(\d+)\s*lies?/i);
    if (lies) out.lies = parseInt(lies[1]);
  } else if (siteId === 'browserleaks_bot') {
    if (lc.includes('not a bot') || lc.includes('not detected')) out.verdict = 'not-bot';
    else if (lc.includes('detected') || lc.includes('bot')) out.verdict = 'flagged';
  } else if (siteId === 'pixelscan') {
    if (lc.includes('consistent') && !lc.includes('inconsistent')) out.consistency = 'consistent';
    else if (lc.includes('inconsistent')) out.consistency = 'inconsistent';
    if (lc.includes('mask')) out.mask = (text.match(/mask[^\n]*?:[^\n]+/i) || [])[0];
  }
  return Object.keys(out).length ? out : null;
}

function scoreResults(results, flags) {
  const breakdown = { probe: 0, fingerprintCom: 0, creepjs: 0, browserleaks: 0, pixelscan: 0 };

  // Probe (25): no bot-tell flags
  breakdown.probe = Math.max(0, 25 - flags.length * 10);

  // fingerprint.com (30): bot detection not flagged
  const fpc = results.fingerprint_com?.extracted?.botDetection?.toLowerCase() || '';
  if (fpc.includes('not detected') || fpc.includes('notdetected') || fpc.includes('good')) breakdown.fingerprintCom = 30;
  else if (fpc.includes('searchengine') || fpc.includes('searchEngine')) breakdown.fingerprintCom = 10;
  else if (fpc) breakdown.fingerprintCom = 0;
  else breakdown.fingerprintCom = 15;                       // unknown, partial credit

  // creepjs (25): trust score / 100 * 25
  const ts = results.creepjs?.extracted?.trustScorePct;
  if (typeof ts === 'number') breakdown.creepjs = Math.round((ts / 100) * 25);

  // browserleaks (10): verdict not flagged
  const bl = results.browserleaks_bot?.extracted?.verdict;
  if (bl === 'not-bot') breakdown.browserleaks = 10;
  else if (!bl) breakdown.browserleaks = 5;

  // pixelscan (10): consistent
  const ps = results.pixelscan?.extracted?.consistency;
  if (ps === 'consistent') breakdown.pixelscan = 10;
  else if (!ps) breakdown.pixelscan = 5;

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown };
}

module.exports = { bench, scoreResults, extractSiteSignals };

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
