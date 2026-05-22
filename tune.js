/**
 * tune.js — Hill-climbing tuner for Dolphin Anty fingerprint configs.
 *
 * Loop:
 *   1. Rotate IPRoyal session  (fresh IP every iteration)
 *   2. Start from the best-known config (or buildBaseline on iter 0)
 *   3. Pick the next un-tried (knob, value) mutation
 *   4. createProfile → startProfile → bench → stopProfile → deleteProfile
 *   5. Score the candidate. If better than best, promote to new base.
 *   6. Stop when best.score ≥ TARGET_SCORE for STREAK_TO_STOP consecutive iters,
 *      or after MAX_ITERATIONS.
 *
 * Persisted state (so Ctrl-C / crashes resume cleanly):
 *   data/tuning-history.jsonl  — append-only log, one record per iteration
 *   data/best-config.json      — current best payload (overwritten each promotion)
 *
 * Safety:
 *   - Every profile is stopped + deleted in a finally{} so a thrown bench
 *     doesn't leak profiles (free tier caps at 10).
 *   - On startup, scans for stale tuner-* profiles from previous runs and
 *     deletes them.
 */
'use strict';
require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const {
  listProfiles,
  startProfile,
  stopProfile,
  createProfile,
  deleteProfile,
} = require('./dolphin');
const { buildBaseline, mutate, candidateMoves, freshName } = require('./generate');
const { rotateAndGetIP } = require('./iproyal');
const { bench } = require('./bench');

// ─── Config ──────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = parseInt(process.env.TUNER_MAX_ITERATIONS || '40', 10);
const TARGET_SCORE   = parseInt(process.env.TUNER_TARGET_SCORE   || '90', 10);
const STREAK_TO_STOP = parseInt(process.env.TUNER_STREAK_TO_STOP || '3', 10);
const DATA_DIR     = path.join(__dirname, 'data');
const OUTPUT_DIR   = path.join(__dirname, 'output');
const HISTORY_FILE = path.join(DATA_DIR, 'tuning-history.jsonl');
const BEST_FILE    = path.join(DATA_DIR, 'best-config.json');

fs.mkdirSync(DATA_DIR,   { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Persist a profile that scored above the target into output/ so downstream
 * subprojects (Hotmail Multi Creator → Twilio Multi Account Creator) can read it.
 * Filename includes the score so newest-first + best-first sort cleanly.
 */
function persistGoodProfile({ dolphinProfileId, ip, score, payload }) {
  const safeScore = String(score.total).padStart(3, '0');
  const file = path.join(OUTPUT_DIR, `${dolphinProfileId}__score${safeScore}.json`);
  const record = {
    dolphin_profile_id: dolphinProfileId,
    ip,
    score: score.total,
    suspect_score: score.suspect_score,
    signals: score.signals,
    validated_at: new Date().toISOString(),
    payload,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function appendHistory(record) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n');
}

function persistBest(payload, score) {
  fs.writeFileSync(BEST_FILE, JSON.stringify({ savedAt: new Date().toISOString(), score, payload }, null, 2));
}

function loadBest() {
  if (!fs.existsSync(BEST_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(BEST_FILE, 'utf-8')); } catch { return null; }
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return fs.readFileSync(HISTORY_FILE, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function cleanupStaleTunerProfiles() {
  try {
    const profiles = await listProfiles({ limit: 50 });
    const stale = profiles.filter(p => p?.name?.startsWith('tuner-') || (p?.tags || []).includes('tuner'));
    if (stale.length) {
      console.log(`🧹  Deleting ${stale.length} stale tuner-* profile(s) from a previous run...`);
      for (const p of stale) {
        try { await deleteProfile(p.id); console.log(`     - deleted ${p.id} (${p.name})`); }
        catch (e) { console.warn(`     ! could not delete ${p.id}: ${e.message}`); }
      }
    }
  } catch (e) {
    console.warn(`(cleanup skipped: ${e.message})`);
  }
}

function summarizeProbe(probe) {
  return {
    ua: probe?.ua?.slice(0, 90),
    webgl: probe?.webgl?.renderer?.slice(0, 90),
    webdriver: probe?.webdriver,
    hwConcurrency: probe?.hwConcurrency,
    deviceMemory: probe?.deviceMemory,
    platform: probe?.platform,
    timezone: probe?.timezone,
  };
}

// ─── One iteration: create profile → bench → tear down ───────────────────────

async function runOnce({ payload, label, knob, value }) {
  console.log(`\n──── iteration ${label} ─────────────────────────────────────`);
  if (knob) console.log(`🎛   move: ${knob} → ${JSON.stringify(value)}`);

  console.log(`🔄  Rotating IPRoyal session...`);
  const ip = await rotateAndGetIP();
  // Re-attach proxy with the new session creds
  const { buildProxyBlock } = require('./generate');
  payload = { ...payload, proxy: buildProxyBlock(label) };

  console.log(`📡  Creating Dolphin profile...`);
  let profileId;
  try {
    profileId = await createProfile(payload);
    console.log(`     created profileId = ${profileId}`);
  } catch (e) {
    console.error(`💥  createProfile failed: ${e.message}`);
    appendHistory({ ts: new Date().toISOString(), label, knob, value, ip, error: `create: ${e.message}` });
    return { score: { total: -1, breakdown: {} }, error: e.message };
  }

  let result = null;
  try {
    console.log(`🚀  Starting profile in automation mode...`);
    const { port } = await startProfile(profileId);
    console.log(`     CDP port = ${port}`);

    await new Promise(r => setTimeout(r, 6000));                  // let browser settle

    result = await bench({
      cdpPort: port,
      profileId,
      label: `tuner-${label}`,
      visionConfig: { knob, value, ip, payloadSummary: { canvas: payload.canvas, webgl: payload.webgl, audio: payload.audio, webrtc: payload.webrtc, ports: payload.ports } },
    });
  } catch (e) {
    console.error(`💥  iteration failed: ${e.message}`);
    appendHistory({ ts: new Date().toISOString(), label, knob, value, ip, profileId, error: e.message });
    return { score: { total: -1, breakdown: {} }, error: e.message };
  } finally {
    try { await stopProfile(profileId); } catch {}
    try { await deleteProfile(profileId); } catch {}
  }

  // If the candidate scored above target, persist its payload to output/ so
  // downstream subprojects (Hotmail Multi Creator) can re-create the same
  // profile on demand. We delete the Dolphin profile (free tier caps at 20)
  // but keep the recipe — Hotmail just calls createProfile(payload).
  if (result.score.total >= TARGET_SCORE) {
    try {
      const file = persistGoodProfile({ dolphinProfileId: profileId, ip, score: result.score, payload });
      console.log(`⭐  Persisted good profile to ${file}`);
    } catch (e) {
      console.warn(`     ! failed to persist good profile: ${e.message}`);
    }
  }

  appendHistory({
    ts: new Date().toISOString(),
    label, knob, value, ip, profileId,
    score: result.score,
    probe: summarizeProbe(result.probe),
    extracted: {
      playgroundSignals: result.results?.fp_playground?.signals,
      playgroundPayload: result.results?.fp_playground?.payload,
      fingerprintComPayload: result.results?.fingerprint_com?.payload,
    },
  });

  return result;
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  console.log('🐬  Dolphin Anty fingerprint tuner');
  console.log(`    target: ≥${TARGET_SCORE}/100 for ${STREAK_TO_STOP} consecutive iters, max ${MAX_ITERATIONS} iters`);

  await cleanupStaleTunerProfiles();

  // Resume from prior best if present, else build baseline
  let bestRecord = loadBest();
  let best = bestRecord?.payload ? { payload: bestRecord.payload, score: bestRecord.score } : null;
  const triedMoves = [];                                          // (knob,value) pairs already attempted from current best

  if (!best) {
    console.log(`\n🌱  Building baseline candidate from Dolphin fingerprint API...`);
    const baseline = await buildBaseline({ name: freshName('tuner') });
    const baselineResult = await runOnce({ payload: baseline, label: 'baseline-0' });
    best = { payload: baseline, score: baselineResult.score };
    if (baselineResult.score.total >= 0) persistBest(baseline, baselineResult.score);
    console.log(`     baseline score = ${baselineResult.score.total}/100`);
  } else {
    console.log(`\n♻️   Resuming from saved best (score=${best.score.total}/100)`);
  }

  let streak = best.score.total >= TARGET_SCORE ? 1 : 0;

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    if (streak >= STREAK_TO_STOP) {
      console.log(`\n🏁  Reached target ${TARGET_SCORE}/100 with streak=${streak}. Stopping.`);
      break;
    }

    // Pick the next un-tried move from the current best
    const moves = [...candidateMoves(best.payload, triedMoves)];
    if (!moves.length) {
      console.log(`\n📭  Exhausted all knob mutations from current best (score=${best.score.total}). Stopping.`);
      break;
    }
    const next = moves[0];

    const candidate = mutate(best.payload, next.knob, next.value);
    candidate.name = freshName('tuner');
    triedMoves.push({ knob: next.knob, value: next.value });

    const result = await runOnce({ payload: candidate, label: `iter-${i}`, knob: next.knob, value: next.value });

    if (result.score.total > best.score.total) {
      console.log(`📈  NEW BEST: ${result.score.total}/100 (was ${best.score.total}). Promoting candidate.`);
      best = { payload: candidate, score: result.score };
      persistBest(candidate, result.score);
      triedMoves.length = 0;                                       // reset — explore from new best
      streak = result.score.total >= TARGET_SCORE ? streak + 1 : 0;
    } else if (result.score.total >= TARGET_SCORE) {
      streak += 1;
    } else {
      streak = 0;
    }

    console.log(`     score=${result.score.total}/100  best=${best.score.total}  streak=${streak}/${STREAK_TO_STOP}`);
  }

  console.log('\n══════════════════════════════════════════════════');
  console.log(`🏆  Final best score: ${best.score.total}/100`);
  console.log(`    breakdown: ${JSON.stringify(best.score.breakdown)}`);
  console.log(`    saved to: ${BEST_FILE}`);
  console.log('══════════════════════════════════════════════════');
}

main().catch(e => { console.error('\n💥', e?.stack || e?.message || e); process.exit(1); });
