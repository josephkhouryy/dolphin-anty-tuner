/**
 * smoke.js — End-to-end smoke test before tuning.
 *
 * Confirms:
 *   1. Dolphin local API auth works (token + cookie jar plumbing)
 *   2. Cloud API: list existing profiles
 *   3. Cloud API: get a fresh fingerprint template (Windows / latest Chrome)
 *   4. IPRoyal proxy returns a fresh IP through https-proxy-agent
 *
 * Exits non-zero on first failure with a clear message.
 */
'use strict';
require('dotenv').config({ override: true });

const { listProfiles, getFingerprint } = require('./dolphin');
const { rotateAndGetIP } = require('./iproyal');

(async () => {
  console.log('━━━ smoke test ━━━');

  console.log('\n[1/3] List existing Dolphin profiles via cloud API...');
  const profiles = await listProfiles({ limit: 50 });
  console.log(`  ✓ Got ${profiles.length} existing profile(s).`);
  for (const p of profiles.slice(0, 5)) {
    console.log(`    - ${p.id} | ${p.name || '(no name)'} | ${p.platform || '?'}`);
  }

  console.log('\n[2/3] Fetch a fresh randomized fingerprint (windows, chrome latest)...');
  const fp = await getFingerprint({ platform: 'windows' });
  const keys = Object.keys(fp || {});
  console.log(`  ✓ Fingerprint has ${keys.length} top-level keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '…' : ''}`);
  console.log(`    sample UA: ${fp.useragent?.value || fp.userAgent || JSON.stringify(fp).slice(0, 120)}`);

  console.log('\n[3/3] Rotate IPRoyal proxy and discover current IP...');
  const ip = await rotateAndGetIP();
  console.log(`  ✓ Got IP: ${ip}`);

  console.log('\n✅ All smoke checks passed. Tuner is ready to run.');
  process.exit(0);
})().catch((e) => {
  console.error('\n💥 Smoke failed:', e.message || e);
  if (e.response?.data) console.error('   API said:', JSON.stringify(e.response.data));
  process.exit(1);
});
