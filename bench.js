// bench.js -- Multi-judge scorer for a Dolphin Anty profile.
//
// Connects to an already-launched Dolphin profile via CDP and runs the profile
// through five judges in sequence:
//   1. fingerprint.com playground (primary, returns suspect_score + signals)
//   2. CreepJS                    (trust % + lies)
//   3. Pixelscan                  (anti-detect verdict)
//   4. bot.sannysoft              (classic puppeteer/playwright tells)
//   5. browserleaks composite     (webrtc/webgl/canvas/fonts)
//
// Returns a record with:
//   - judges[id] -- { pass, reasons[], raw, screenshot, error? } per judge
//   - pass_all   -- AND of judges[].pass (the strict gate)
//   - score      -- legacy 0-100 internal score derived from fp_playground
//                   (kept for backward compat with tune.js)
//   - suspect_score, signals -- legacy fp_playground shortcuts
//
// Appends one JSONL record per call to data/bench-results.jsonl.
'use strict';
require('dotenv').config({ override: true });

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const fpPlayground = require('./judges/fp-playground');
const creepjs      = require('./judges/creepjs');
const pixelscan    = require('./judges/pixelscan');
const sannysoft    = require('./judges/sannysoft');
const browserleaks = require('./judges/browserleaks');

const JUDGES = [
  { id: 'fp_playground', mod: fpPlayground },
  { id: 'creepjs',       mod: creepjs },
  { id: 'pixelscan',     mod: pixelscan },
  { id: 'sannysoft',     mod: sannysoft },
  { id: 'browserleaks',  mod: browserleaks },
];

const SIGNAL_KEYS = fpPlayground.SIGNAL_KEYS;

// In-browser probe (kept for diagnostic info on each run).
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
      chromeRuntime: !!window.chrome?.runtime,
    };
  });
}

// Legacy 0-100 score derived from fp_playground only (back-compat for tune.js).
function legacyScoreFromFp(fpResult) {
  const signals = fpResult?.raw?.signals || null;
  const payload = fpResult?.raw?.payload || null;
  const suspect_score = signals?.suspect_score ?? payload?.suspect_score ?? null;
  const merged = fpResult?.raw?.merged_signals || {};

  let suspectPts;
  if (typeof suspect_score === 'number') {
    suspectPts = Math.max(0, Math.min(70, Math.round(70 - 0.7 * suspect_score)));
  } else {
    suspectPts = 35;
  }

  let signalPts = 0;
  for (const key of SIGNAL_KEYS) {
    if (merged[key] === false) signalPts += 3;
    else if (merged[key] == null) signalPts += 1.5;
  }

  const total = Math.round(suspectPts + signalPts);
  return {
    total,
    breakdown: { suspectPts, signalPts: Math.round(signalPts * 10) / 10 },
    suspect_score,
    signals: merged,
  };
}

async function bench({
  cdpPort,
  profileId,
  label = 'unknown',
  visionConfig = null,
  expectedProxyIp = null,
  declaredOs = null,
  allowedLocalIps = null,
  skipLocalIpCheck = false,
}) {
  const wsBase = `http://127.0.0.1:${cdpPort}`;
  console.log(`Connecting to CDP at ${wsBase} ...`);
  const browser = await chromium.connectOverCDP(wsBase);

  const ctx = browser.contexts()[0] || (await browser.newContext());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotsDir = path.join(__dirname, 'screenshots', 'bench');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  // Each judge runs inside its own try/catch -- a thrown ctx.newPage() (e.g.
  // browser disconnect, resource exhaustion) on one judge must not abort the
  // whole bench, or the entire iteration's JSONL record is lost.
  const judges = {};
  for (const j of JUDGES) {
    console.log(`Judge: ${j.id} ...`);
    try {
      judges[j.id] = await j.mod.judge({
        ctx, screenshotsDir, timestamp, label, fs, path,
        expectedProxyIp, declaredOs,
        allowedLocalIps, skipLocalIpCheck,
      });
    } catch (e) {
      console.warn(`  Judge ${j.id} threw: ${e.message}`);
      judges[j.id] = { id: j.id, pass: false, reasons: [`error:${e.message}`], error: e.message };
    }
    const verdict = judges[j.id].pass ? 'PASS' : 'FAIL';
    const reasons = judges[j.id].reasons || [];
    console.log(`  ${verdict}  reasons: ${reasons.slice(0, 4).join(' | ') || '(none)'}`);
  }

  // ctx.newPage() can throw on a disconnected browser; if it does we still
  // want the run's JSONL record to land, just with probe=error.
  let probeData = null;
  let probeTab = null;
  try {
    probeTab = await ctx.newPage();
    await probeTab.goto('about:blank', { timeout: 10000 });
    probeData = await probe(probeTab);
  } catch (e) {
    probeData = { error: e.message };
  } finally {
    if (probeTab) await probeTab.close().catch(() => {});
  }
  await browser.close().catch(() => {});

  const score = legacyScoreFromFp(judges.fp_playground);
  const pass_all = JUDGES.every(j => judges[j.id]?.pass === true);
  const passing = JUDGES.filter(j => judges[j.id]?.pass === true).map(j => j.id);
  const failing = JUDGES.filter(j => judges[j.id]?.pass !== true).map(j => j.id);

  const record = {
    timestamp,
    profileId,
    label,
    probe: probeData,
    visionConfig,
    expectedProxyIp,
    declaredOs,
    judges,
    pass_all,
    passing,
    failing,
    // Legacy keys retained for backward compatibility with tune.js / finalize.js.
    score,
    suspect_score: score.suspect_score,
    signals: score.signals,
  };

  const outFile = path.join(__dirname, 'data', 'bench-results.jsonl');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.appendFileSync(outFile, JSON.stringify(record) + '\n');

  console.log(`\nLegacy score: ${score.total}/100   suspect_score=${score.suspect_score}`);
  console.log(`Multi-judge: ${pass_all ? 'PASS_ALL' : 'FAIL'}   passing=[${passing.join(',')}]  failing=[${failing.join(',')}]`);
  return record;
}

module.exports = { bench, legacyScoreFromFp, JUDGES, SIGNAL_KEYS };

if (require.main === module) {
  const cdpPort = process.argv[2] ? parseInt(process.argv[2]) : null;
  const profileId = process.argv[3] || 'manual';
  const label = process.argv[4] || 'manual-run';
  const expectedProxyIp = process.argv[5] || null;
  const declaredOs = process.argv[6] || null;
  // Allow the bench-machine VPC private IP via env so the WebRTC local-IP
  // check doesn't trip on the host's own ICE candidate. Use a comma-separated
  // list or set BENCH_SKIP_LOCAL_IP_CHECK=1 to bypass entirely.
  const allowedLocalIps = process.env.BENCH_ALLOWED_LOCAL_IPS
    ? process.env.BENCH_ALLOWED_LOCAL_IPS.split(',').map(s => s.trim()).filter(Boolean)
    : null;
  const skipLocalIpCheck = process.env.BENCH_SKIP_LOCAL_IP_CHECK === '1';
  if (!cdpPort) {
    console.error('Usage: node bench.js <cdpPort> [profileId] [label] [expectedProxyIp] [declaredOs]');
    process.exit(1);
  }
  bench({ cdpPort, profileId, label, expectedProxyIp, declaredOs, allowedLocalIps, skipLocalIpCheck })
    .then(() => process.exit(0))
    .catch(e => { console.error('ERROR:', e); process.exit(1); });
}
