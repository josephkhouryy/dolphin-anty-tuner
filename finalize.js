/**
 * finalize.js — Verify the winning config reproduces on fresh proxies.
 *
 * Reads data/best-config.json, then for N (default 5) trials:
 *   rotate IPRoyal → clone the payload with a new name → create → start →
 *   bench → stop → delete → log.
 *
 * Pass criteria (per trial): score ≥ FINALIZE_PASS_SCORE (default 85).
 * If all N pass, writes winning-profile.json (the same payload, with `name`
 * stripped) and prints a one-line summary.
 *
 * Usage:
 *   node finalize.js               # 5 trials, pass=85
 *   FINALIZE_TRIALS=10 node finalize.js
 */
'use strict';
require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { startProfile, stopProfile, createProfile, deleteProfile } = require('./dolphin');
const { rotateAndGetIP } = require('./iproyal');
const { buildProxyBlock, freshName } = require('./generate');
const { bench } = require('./bench');

const TRIALS = parseInt(process.env.FINALIZE_TRIALS || '5', 10);
const PASS   = parseInt(process.env.FINALIZE_PASS_SCORE || '85', 10);

const DATA_DIR = path.join(__dirname, 'data');
const BEST_FILE = path.join(DATA_DIR, 'best-config.json');
const FINAL_FILE = path.join(__dirname, 'winning-profile.json');
const FINALIZE_LOG = path.join(DATA_DIR, 'finalize-log.jsonl');

function appendLog(rec) {
  fs.appendFileSync(FINALIZE_LOG, JSON.stringify(rec) + '\n');
}

async function trial(basePayload, idx) {
  console.log(`\n──── trial ${idx} of ${TRIALS} ────────────────────────────────`);
  const ip = await rotateAndGetIP();
  const payload = { ...basePayload, name: freshName('verify'), proxy: buildProxyBlock(`verify-${idx}`) };

  console.log(`📡  createProfile...`);
  const profileId = await createProfile(payload);

  let result;
  try {
    const { port } = await startProfile(profileId);
    await new Promise(r => setTimeout(r, 6000));
    result = await bench({ cdpPort: port, profileId, label: `verify-${idx}`, visionConfig: { ip, trialIndex: idx } });
  } finally {
    try { await stopProfile(profileId); } catch {}
    try { await deleteProfile(profileId); } catch {}
  }

  appendLog({ ts: new Date().toISOString(), trialIndex: idx, ip, score: result.score, profileId });
  console.log(`     score = ${result.score.total}/100   ${result.score.total >= PASS ? '✅ pass' : '❌ fail'}`);
  return result.score.total;
}

async function main() {
  if (!fs.existsSync(BEST_FILE)) {
    console.error(`💥 No ${BEST_FILE} — run tune.js first.`);
    process.exit(1);
  }
  const { payload: bestPayload, score: bestScore } = JSON.parse(fs.readFileSync(BEST_FILE, 'utf-8'));
  console.log(`🐬  Finalize — verifying best tuner config on ${TRIALS} fresh profiles`);
  console.log(`    saved best score = ${bestScore?.total}/100`);
  console.log(`    pass criterion = each trial ≥ ${PASS}/100`);

  const scores = [];
  for (let i = 1; i <= TRIALS; i++) {
    try { scores.push(await trial(bestPayload, i)); }
    catch (e) { console.warn(`     trial ${i} errored: ${e.message}`); scores.push(-1); }
  }

  const passCount = scores.filter(s => s >= PASS).length;
  const avg = scores.length ? (scores.reduce((a,b) => a + Math.max(0,b), 0) / scores.length).toFixed(1) : 0;
  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`  Trials: ${TRIALS}   Passes (≥${PASS}): ${passCount}   Avg: ${avg}`);
  console.log(`  Scores: ${scores.join(', ')}`);
  console.log(`══════════════════════════════════════════════════`);

  if (passCount === TRIALS) {
    // Strip the per-tuner name/proxy — leave a clean template
    const template = { ...bestPayload };
    delete template.name;
    delete template._meta;
    delete template.proxy;                                       // user injects their own proxy at use time
    fs.writeFileSync(FINAL_FILE, JSON.stringify(template, null, 2));
    console.log(`\n🏆  All ${TRIALS} trials passed.`);
    console.log(`    Winning template saved to: ${FINAL_FILE}`);
    console.log(`    Clone this profile in Dolphin or POST it to /browser_profiles with a fresh proxy attached.`);
  } else {
    console.log(`\n⚠️   ${TRIALS - passCount} of ${TRIALS} trials failed — winner is not yet reliable.`);
    console.log(`    Re-run tune.js with more iterations, or inspect data/tuning-history.jsonl.`);
  }
}

main().catch(e => { console.error('\n💥', e?.stack || e?.message || e); process.exit(1); });
