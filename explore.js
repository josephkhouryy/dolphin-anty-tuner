/**
 * explore.js — One-shot probe to learn the actual DOM of detection sites.
 *
 * Creates a baseline Dolphin profile, navigates each detection URL, waits long
 * enough for async fingerprinting to complete, then dumps:
 *   - full innerText (truncated to 30k chars)
 *   - innerText of likely-result containers (probed via a list of selectors)
 *
 * Output: data/explore-<ts>.json
 *
 * Use this whenever a detection site changes its layout — once it works, port
 * the selectors back into bench.js.
 */
'use strict';
require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startProfile, stopProfile, createProfile, deleteProfile } = require('./dolphin');
const { buildBaseline, freshName, buildProxyBlock } = require('./generate');
const { rotateAndGetIP } = require('./iproyal');

const SITES = [
  { id: 'creepjs',          url: 'https://abrahamjuliot.github.io/creepjs/', waitMs: 40000 },
  { id: 'fingerprint_demo', url: 'https://fingerprint.com/demo/',            waitMs: 25000 },
  { id: 'fp_playground',    url: 'https://demo.fingerprint.com/playground',  waitMs: 25000 },
  { id: 'pixelscan',        url: 'https://pixelscan.net/',                   waitMs: 25000 },
  { id: 'browserleaks',     url: 'https://browserleaks.com/javascript',      waitMs: 12000 },
  { id: 'sannysoft',        url: 'https://bot.sannysoft.com/',               waitMs: 8000  },
  { id: 'amiunique',        url: 'https://amiunique.org/fingerprint',        waitMs: 22000 },
];

// Selector candidates we want to peek into per site
const SELECTORS = {
  creepjs:          ['#fingerprint-data', '#fingerprint', '#trust-score', '.trust-score', '.score', 'header', '.fp', 'main', 'body > div'],
  fingerprint_demo: ['[data-testid="visitorId"]', '[class*="visitorId"]', '[class*="signal"]', '[class*="risk"]', 'pre', 'code'],
  fp_playground:    ['[data-testid="visitorId"]', '[class*="visitorId"]', '[class*="signal"]', '[class*="risk"]', 'pre', 'code'],
  pixelscan:        ['[class*="consist"]', '[class*="mask"]', '[class*="result"]', '[class*="verdict"]', 'main'],
  browserleaks:     ['table', '#js-info', '#bot-detection'],
  sannysoft:        ['table', '.passed', '.failed'],
  amiunique:        ['[id*="fingerprint"]', 'h1', 'h2', '.score', '[class*="unique"]'],
};

async function main() {
  const sessionLabel = `explore-${Date.now()}`;
  console.log('🔄 Rotating proxy...');
  await rotateAndGetIP();
  const baseline = await buildBaseline({ name: freshName('explore'), sessionLabel });

  console.log('📡 Creating exploration profile...');
  const profileId = await createProfile(baseline);
  console.log(`   profileId = ${profileId}`);

  const dump = { ts: new Date().toISOString(), profileId, sites: {} };
  try {
    console.log('🚀 Starting...');
    const { port } = await startProfile(profileId);
    await new Promise(r => setTimeout(r, 6000));

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0] || (await browser.newContext());

    for (const site of SITES) {
      console.log(`\n📍 ${site.id} → ${site.url}`);
      const page = await ctx.newPage();
      try {
        await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(site.waitMs);
        const text = await page.evaluate(() => document.body.innerText || '');
        const html = await page.evaluate(() => document.body.outerHTML?.slice(0, 50000) || '');
        const selectorHits = {};
        for (const sel of (SELECTORS[site.id] || [])) {
          try {
            const matches = await page.$$eval(sel, els => els.slice(0, 3).map(e => (e.innerText || '').slice(0, 600)));
            if (matches.length) selectorHits[sel] = matches;
          } catch {}
        }
        dump.sites[site.id] = {
          url: site.url,
          title: await page.title(),
          text: text.slice(0, 30000),
          textLen: text.length,
          selectorHits,
          htmlExcerpt: html.slice(0, 5000),
        };
        console.log(`   ✓ ${text.length} chars; ${Object.keys(selectorHits).length} selector hits`);
      } catch (e) {
        console.warn(`   ✗ ${site.id}: ${e.message}`);
        dump.sites[site.id] = { url: site.url, error: e.message };
      } finally {
        await page.close().catch(() => {});
      }
    }

    await browser.close().catch(() => {});
  } finally {
    try { await stopProfile(profileId); } catch {}
    try { await deleteProfile(profileId); } catch {}
  }

  const outFile = path.join(__dirname, 'data', `explore-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dump, null, 2));
  console.log(`\n💾 Dump saved to ${outFile}`);
}

main().catch(e => { console.error('\n💥', e?.stack || e?.message || e); process.exit(1); });
