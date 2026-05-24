// judges/creepjs.js -- CreepJS judge.
//
// Verdict source:
//   - URL: https://abrahamjuliot.github.io/creepjs/
//   - Renders a "trust score" % and a list of detected "lies" (inconsistencies
//     between declared specs and JS reality).
//   - Page takes ~15-25s to settle; we wait for the trust % to appear.
//
// Pass criteria (first-pass, will tune from experiment data):
//   - trust score >= 60% (community "good" threshold)
//   - lies count === 0
//   - No "automation" or "headless" tag in the displayed result
'use strict';

const URL = 'https://abrahamjuliot.github.io/creepjs/';
const TRUST_THRESHOLD = 60;

async function extractCreepjsVerdict(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    // Trust score appears as "60% trust" or "trust score X%" or "X.X% (Y)".
    const trustMatch =
      text.match(/(-?\d+(?:\.\d+)?)\s*%\s*trust/i) ||
      text.match(/trust\s*score[^\d-]*(-?\d+(?:\.\d+)?)\s*%/i) ||
      text.match(/(-?\d+(?:\.\d+)?)\s*%\s*\(\s*\d+\s*\)/);
    const trust = trustMatch ? Number(trustMatch[1]) : null;

    // Lies count: "lies (N)" or "N lies" header.
    const liesMatch =
      text.match(/lies\s*\(\s*(\d+)\s*\)/i) ||
      text.match(/(\d+)\s+lies/i);
    const lies = liesMatch ? Number(liesMatch[1]) : null;

    // Bot/automation/headless tags surfaced in the result block.
    // CreepJS prints each attribute as a labelled row even when the value is
    // negative ("Headless Browser: Not Detected"), so bare-keyword regexes
    // would flag every page. For each keyword we walk ALL occurrences in the
    // page text and inspect a 120-char window after each one (crossing
    // newlines, because innerText puts label and value on separate lines when
    // they live in different DOM cells). A tag is pushed when ANY occurrence
    // shows a positive-detection phrase AND no negation in the same span --
    // a single negative line elsewhere on the page shouldn't mask a real
    // positive verdict further down.
    const automationTags = [];
    const positiveNear = (kw) => {
      const re = new RegExp(`${kw}[\\s\\S]{0,120}`, 'gi');
      let m;
      while ((m = re.exec(text)) !== null) {
        const span = m[0];
        // `\bnot\b` (not bare `\bno\b`) -- "no" matches incidentally on text
        // like "No other automation flags" which sits well past the actual
        // verdict and would silently swallow a real detection. `\bnot\b` still
        // catches "not detected" / "not headless" without that false drop.
        if (/not\s+detected|\bfalse\b|\bnot\b|negative/i.test(span)) continue;
        if (/\btrue\b|\byes\b|\bdetected\b|positive/i.test(span)) return true;
      }
      return false;
    };
    if (positiveNear('headless')) automationTags.push('headless');
    if (positiveNear('automation')) automationTags.push('automation');
    if (positiveNear('webdriver')) automationTags.push('webdriver');
    if (positiveNear('puppet')) automationTags.push('puppeteer');
    if (positiveNear('playwright')) automationTags.push('playwright');

    // Fingerprint hash (informational).
    const fpHash = (text.match(/fingerprint\s*([0-9a-f]{12,})/i) || [])[1] || null;

    return { trust, lies, automationTags, fpHash, sample: text.slice(0, 1200) };
  });
}

async function judge({ ctx, screenshotsDir, timestamp, label, fs, path }) {
  const page = await ctx.newPage();
  const out = { id: 'creepjs', url: URL };
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // CreepJS does a slow client-side compute; wait for the trust % to render.
    await page.waitForFunction(
      () => /%\s*trust|trust\s*score[^\d]*\d|%\s*\(\s*\d/i.test(document.body.innerText || ''),
      { timeout: 45000 }
    ).catch(() => {});
    await page.waitForTimeout(3000);

    const shot = path.join(screenshotsDir, `${timestamp}_${label}_creepjs.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    out.screenshot = shot;

    const verdict = await extractCreepjsVerdict(page);
    const reasons = [];
    if (verdict.trust == null) reasons.push('trust=unknown');
    else if (verdict.trust < TRUST_THRESHOLD) reasons.push(`trust=${verdict.trust}<${TRUST_THRESHOLD}`);
    if (verdict.lies == null) reasons.push('lies=unknown');
    else if (verdict.lies > 0) reasons.push(`lies=${verdict.lies}`);
    for (const tag of verdict.automationTags) reasons.push(`tag:${tag}`);

    out.raw = verdict;
    out.pass = reasons.length === 0;
    out.reasons = reasons;
  } catch (e) {
    out.error = e.message;
    out.pass = false;
    out.reasons = [`error:${e.message}`];
  } finally {
    await page.close().catch(() => {});
  }
  return out;
}

module.exports = { judge, URL, TRUST_THRESHOLD };
