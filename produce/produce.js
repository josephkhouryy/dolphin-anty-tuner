// produce/produce.js -- Continuous multi-judge profile producer.
//
// See produce/README.md for the high-level shape. This file is the loop:
// rotate IP, build Dolphin profile, grade against all 5 judges, publish if
// clean, delete the live profile (with the never-delete guard), append per-
// attempt record, repeat.
'use strict';
require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');

const { startProfile, stopProfile, createProfile, deleteProfile } = require('../dolphin');
const { buildBaseline, freshName } = require('../generate');
const { rotateAndGetIP, getCurrentSessionId } = require('../iproyal');
const { bench } = require('../bench');
const { isProfileUsedDownstream } = require('../lib/never-delete-guard');

// ─── Config ──────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS    = parseInt(process.env.PRODUCE_MAX_ATTEMPTS || '0', 10);   // 0 = run forever
const SUMMARY_EVERY   = parseInt(process.env.PRODUCE_SUMMARY_EVERY || '25', 10);
// Delay between iterations when the previous one errored (IPRoyal down, Dolphin
// API hiccup, etc.). Without this a hard outage produces a tight retry loop
// that fills log.jsonl with thousands of error rows and risks a rate-limit
// ban upstream. 5s is short enough to recover quickly when the outage clears.
const ERROR_BACKOFF_MS = parseInt(process.env.PRODUCE_ERROR_BACKOFF_MS || '5000', 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const SUBPROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR      = path.join(SUBPROJECT_ROOT, 'output');
const INDEX_FILE      = path.join(OUTPUT_DIR, 'index.jsonl');
const EXPERIMENTS_DIR = path.join(SUBPROJECT_ROOT, 'experiments');
const RUN_ID          = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR         = path.join(EXPERIMENTS_DIR, RUN_ID);
const RUN_LOG         = path.join(RUN_DIR, 'log.jsonl');
const RUN_SUMMARY     = path.join(RUN_DIR, 'summary.md');
const PRODUCE_LOG     = path.join(SUBPROJECT_ROOT, 'produce.log');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(RUN_DIR,    { recursive: true });

// ─── Tee stdout/stderr to produce.log (same pattern as tune.js) ─────────────
// Background-launched processes on Windows (Scheduled Task) have null stdio
// handles; mirror every console line so progress is observable.
(() => {
  try { fs.writeFileSync(PRODUCE_LOG, ''); } catch {}
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const tee = (args, prefix = '') => {
    try {
      fs.appendFileSync(PRODUCE_LOG,
        prefix + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    } catch {}
  };
  console.log   = (...a) => { origLog(...a); tee(a); };
  console.warn  = (...a) => { origErr(...a); tee(a, '[warn] '); };
  console.error = (...a) => { origErr(...a); tee(a, '[err] '); };
})();

// ─── Output writers ──────────────────────────────────────────────────────────

function persistGoodProfile({ dolphinProfileId, ip, judges, score, payload }) {
  const safeScore = String(score.total).padStart(3, '0');
  const filename = `${dolphinProfileId}__score${safeScore}.json`;
  const file = path.join(OUTPUT_DIR, filename);
  const record = {
    dolphin_profile_id: dolphinProfileId,
    ip,
    score: score.total,
    suspect_score: score.suspect_score,
    signals: score.signals,
    judges: Object.fromEntries(
      Object.entries(judges).map(([id, j]) => [id, { pass: j.pass, reasons: j.reasons }])
    ),
    validated_at: new Date().toISOString(),
    payload,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  const indexRow = {
    file: filename,
    dolphin_profile_id: dolphinProfileId,
    ip,
    score: score.total,
    suspect_score: score.suspect_score,
    flagged_signals: Object.entries(score.signals || {}).filter(([, v]) => v === true).map(([k]) => k),
    judges_passed: Object.entries(judges).filter(([, j]) => j.pass).map(([id]) => id),
    validated_at: record.validated_at,
  };
  try { fs.appendFileSync(INDEX_FILE, JSON.stringify(indexRow) + '\n'); } catch {}
  return file;
}

function appendRunLog(record) {
  try { fs.appendFileSync(RUN_LOG, JSON.stringify(record) + '\n'); } catch {}
}

function readRunLog() {
  if (!fs.existsSync(RUN_LOG)) return [];
  return fs.readFileSync(RUN_LOG, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function writeSummary() {
  const rows = readRunLog();
  const total = rows.length;
  const hits = rows.filter(r => r.pass_all).length;
  const successRate = total ? (hits / total * 100).toFixed(1) : '0.0';

  // Per-judge failure counts. Denominator excludes iterations that errored
  // out before reaching bench -- those don't have a `judges` field. Reporting
  // against `total` would understate the real failure rate among iterations
  // that actually ran.
  const benchedTotal = rows.filter(r => r.judges).length;
  const judgeFailCounts = {};
  for (const r of rows) {
    for (const [id, j] of Object.entries(r.judges || {})) {
      if (j && j.pass === false) judgeFailCounts[id] = (judgeFailCounts[id] || 0) + 1;
    }
  }
  const judgeFailTable = Object.entries(judgeFailCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([id, c]) => `- ${id}: ${c} (${benchedTotal ? (c / benchedTotal * 100).toFixed(1) : '0.0'}% of benched)`)
    .join('\n') || '(none yet)';

  // Most common fp.com signals flagged.
  const signalCounts = {};
  for (const r of rows) {
    for (const sig of r.flagged_signals || []) {
      signalCounts[sig] = (signalCounts[sig] || 0) + 1;
    }
  }
  const signalTable = Object.entries(signalCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([s, c]) => `- ${s}: ${c}`)
    .join('\n') || '(none)';

  const lastHit = rows.slice().reverse().find(r => r.pass_all);
  const md = [
    `# Run ${RUN_ID}`,
    ``,
    `- Attempts: **${total}**`,
    `- Hits (passed all 5 judges): **${hits}**`,
    `- Success rate: **${successRate}%**`,
    `- Last hit: ${lastHit ? `${lastHit.iter} at ${lastHit.ts}` : '(none yet)'}`,
    ``,
    `## Per-judge failure counts`,
    judgeFailTable,
    ``,
    `## fp.com flagged signals across all attempts`,
    signalTable,
    ``,
    `_Updated automatically every ${SUMMARY_EVERY} attempts._`,
    ``,
  ].join('\n');
  try { fs.writeFileSync(RUN_SUMMARY, md); } catch {}
}

// ─── One iteration ───────────────────────────────────────────────────────────

async function runOnce(iter) {
  console.log(`\n──── iter ${iter} ${'─'.repeat(58)}`);
  const attempt = { iter, ts: new Date().toISOString() };

  let ip;
  try {
    ip = await rotateAndGetIP();
  } catch (e) {
    console.error(`IP rotation failed: ${e.message}`);
    attempt.error = `rotate:${e.message}`;
    appendRunLog(attempt);
    return attempt;
  }
  attempt.ip = ip;
  attempt.session = getCurrentSessionId();

  const profileName = freshName('tuner');
  let payload;
  try {
    // buildBaseline reads currentSessionId set by rotateAndGetIP above (or
    // upstream's verbatim proxy URL when consumed from Good IP Finder) and
    // wires the matching proxy block into the payload.
    payload = await buildBaseline({ name: profileName, sessionLabel: profileName });
  } catch (e) {
    console.error(`buildBaseline failed: ${e.message}`);
    attempt.error = `baseline:${e.message}`;
    appendRunLog(attempt);
    return attempt;
  }

  let profileId;
  try {
    profileId = await createProfile(payload);
  } catch (e) {
    console.error(`createProfile failed: ${e.message}`);
    attempt.error = `create:${e.message}`;
    appendRunLog(attempt);
    return attempt;
  }
  attempt.profileId = profileId;
  console.log(`profileId=${profileId}  ip=${ip}`);

  let benchResult = null;
  try {
    const { port } = await startProfile(profileId);
    await new Promise(r => setTimeout(r, 6000)); // let the browser settle
    benchResult = await bench({
      cdpPort: port,
      profileId,
      label: `produce-${iter}`,
      expectedProxyIp: ip,
      declaredOs: 'windows',
      allowedLocalIps: process.env.BENCH_ALLOWED_LOCAL_IPS
        ? process.env.BENCH_ALLOWED_LOCAL_IPS.split(',').map(s => s.trim()).filter(Boolean)
        : null,
      skipLocalIpCheck: process.env.BENCH_SKIP_LOCAL_IP_CHECK === '1',
    });
  } catch (e) {
    console.error(`bench failed: ${e.message}`);
    attempt.error = `bench:${e.message}`;
  } finally {
    try { await stopProfile(profileId); } catch {}
  }

  if (benchResult) {
    attempt.pass_all = !!benchResult.pass_all;
    attempt.passing = benchResult.passing;
    attempt.failing = benchResult.failing;
    attempt.judges = Object.fromEntries(
      Object.entries(benchResult.judges || {}).map(([id, j]) => [id, { pass: j.pass, reasons: j.reasons }])
    );
    attempt.suspect_score = benchResult.suspect_score;
    attempt.flagged_signals = Object.entries(benchResult.signals || {})
      .filter(([, v]) => v === true).map(([k]) => k);

    if (benchResult.pass_all) {
      // A disk-full / permissions error on persist must NOT kill the forever
      // loop. Log and keep going -- the bench result still went to log.jsonl
      // so we have the data even when output/ couldn't be written.
      try {
        const file = persistGoodProfile({
          dolphinProfileId: profileId,
          ip,
          judges: benchResult.judges,
          score: benchResult.score,
          payload,
        });
        console.log(`PUBLISHED ${file}`);
      } catch (e) {
        console.error(`persistGoodProfile failed: ${e.message}`);
        attempt.persist_error = e.message;
      }
    } else {
      console.log(`failing=[${benchResult.failing.join(',')}]`);
    }
  }

  // Never-delete guard: if downstream has consumed this profile, skip delete.
  const guard = isProfileUsedDownstream(profileId);
  if (guard.used) {
    console.log(`guard: profile ${profileId} in use by ${guard.where}; skipping delete`);
    attempt.deleted = false;
    attempt.guard_blocked = guard.where;
  } else {
    try {
      await deleteProfile(profileId);
      attempt.deleted = true;
    } catch (e) {
      console.warn(`deleteProfile failed: ${e.message}`);
      attempt.deleted = false;
      attempt.delete_error = e.message;
    }
  }

  appendRunLog(attempt);
  return attempt;
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  console.log('Continuous multi-judge producer');
  console.log(`  run id:        ${RUN_ID}`);
  console.log(`  log:           ${RUN_LOG}`);
  console.log(`  summary:       ${RUN_SUMMARY}`);
  console.log(`  output dir:    ${OUTPUT_DIR}`);
  console.log(`  max_attempts:  ${MAX_ATTEMPTS || 'unlimited'}`);
  console.log(`  summary_every: ${SUMMARY_EVERY} attempts`);

  let iter = 0;
  let hits = 0;
  while (true) {
    iter += 1;
    if (MAX_ATTEMPTS > 0 && iter > MAX_ATTEMPTS) {
      console.log(`Reached PRODUCE_MAX_ATTEMPTS=${MAX_ATTEMPTS}; stopping.`);
      break;
    }
    const r = await runOnce(iter);
    if (r.pass_all) hits += 1;
    if (iter % SUMMARY_EVERY === 0 || r.pass_all) writeSummary();
    console.log(`progress: iter=${iter}  hits=${hits}  rate=${(hits / iter * 100).toFixed(1)}%`);
    // Back off when this iteration errored out (rotation, baseline, create,
    // bench). Prevents a hard upstream outage from burning through iterations.
    if (r.error && ERROR_BACKOFF_MS > 0) {
      console.log(`(error backoff: sleeping ${ERROR_BACKOFF_MS}ms before next iter)`);
      await sleep(ERROR_BACKOFF_MS);
    }
  }

  writeSummary();
  console.log('\nFinal summary written:', RUN_SUMMARY);
}

main().catch(e => { console.error('FATAL', e?.stack || e); process.exit(1); });
