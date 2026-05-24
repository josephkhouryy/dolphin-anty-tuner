// judges/pixelscan.js -- Pixelscan judge.
//
// Verdict source:
//   - URL: https://pixelscan.net/
//   - Explicitly built to flag anti-detect browsers via spec-vs-measurement diffs.
//   - Renders an overall verdict line ("Your browser fingerprint is consistent" /
//     "...looks like a modified browser") plus a per-test grid.
//
// Pass criteria (first-pass):
//   - Overall verdict text matches a "consistent / passed" phrase.
//   - No "anti-detect" / "masking detected" / "automation" tag in text.
//   - No per-test row flagged "failed" or "modified".
'use strict';

const URL = 'https://pixelscan.net/';

async function extractPixelscanVerdict(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';

    // Anchor "consistent" and "passed" with \b so they don't match inside
    // "inconsistent" or substrings -- otherwise a failing page sets
    // positive_phrase=true and confuses any consumer reading raw flags.
    const positive = /(\bconsistent\b|looks legit|\bpassed\b|no inconsistencies|real browser)/i.test(text);
    const negative = /(modified browser|masking detected|inconsistent|anti[- ]detect|spoof|fingerprint masking|automation detected|bot detected)/i.test(text);

    const detectedFlags = [];
    if (/anti[- ]detect/i.test(text)) detectedFlags.push('anti_detect');
    if (/masking detected/i.test(text)) detectedFlags.push('masking');
    if (/inconsistent/i.test(text)) detectedFlags.push('inconsistent');
    if (/modified browser/i.test(text)) detectedFlags.push('modified');
    if (/automation detected/i.test(text)) detectedFlags.push('automation');
    if (/bot detected/i.test(text)) detectedFlags.push('bot');
    if (/\bspoof/i.test(text)) detectedFlags.push('spoof');
    if (/fingerprint masking/i.test(text)) detectedFlags.push('fingerprint_masking');

    return {
      positive_phrase: positive,
      negative_phrase: negative,
      detectedFlags,
      sample: text.slice(0, 1200),
    };
  });
}

async function judge({ ctx, screenshotsDir, timestamp, label, fs, path }) {
  const page = await ctx.newPage();
  const out = { id: 'pixelscan', url: URL };
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Pixelscan runs an on-load test; wait for verdict text.
    await page.waitForFunction(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return /(consistent|inconsistent|modified|anti[- ]detect|masking detected)/.test(t);
    }, { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const shot = path.join(screenshotsDir, `${timestamp}_${label}_pixelscan.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    out.screenshot = shot;

    const verdict = await extractPixelscanVerdict(page);
    const reasons = [];
    if (verdict.detectedFlags.length) {
      for (const f of verdict.detectedFlags) reasons.push(`flag:${f}`);
    }
    if (verdict.negative_phrase && !verdict.positive_phrase) {
      reasons.push('negative_phrase_only');
    }
    if (!verdict.positive_phrase && !verdict.negative_phrase) {
      reasons.push('no_verdict_text');
    }

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

module.exports = { judge, URL };
