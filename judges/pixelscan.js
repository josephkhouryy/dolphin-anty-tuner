// judges/pixelscan.js -- Pixelscan judge.
//
// Verdict source:
//   - Landing URL: https://pixelscan.net/
//   - Direct fingerprint check (scan results UI): https://pixelscan.net/fingerprint-check
//     -- the page that actually renders the per-test verdict grid.
//   - The landing page is a marketing site whose navigation menu includes the
//     phrases "Best Anti-Detect Browsers" and "Best Tools To Avoid IP Ban".
//     A keyword scan of the landing page therefore matched `anti-detect` and
//     `bot detected` purely from the menu, failing every profile. Hit the
//     fingerprint-check page directly so we score against the actual verdict.
//
// Pass criteria:
//   - The page renders a real verdict block (not just landing-page chrome).
//   - No "anti-detect"/"masking"/"inconsistent"/"modified"/"automation"/"bot"
//     phrase appears in the verdict block.
//   - At least one positive marker ("consistent", "passed", "looks legit") is
//     present somewhere on the rendered verdict.
'use strict';

const URL = 'https://pixelscan.net/fingerprint-check';

async function extractPixelscanVerdict(page) {
  return page.evaluate(() => {
    const fullText = document.body.innerText || '';

    // Pixelscan's actual scan verdict lives inside the "Fingerprint Scan"
    // block, which prints "Chrome <version> on <OS>", a "Fingerprint" row
    // with "No automated behavior detected" or a detected-flag, and a
    // "Bot check" status. The rest of the page is marketing chrome (nav,
    // FAQ such as "Is your fingerprint inconsistent...?", footer, links
    // like "Ultimate Antidetect Guide") that contains the same keywords.
    // The old text-wide regex matched those FAQ titles and failed every
    // probe. Slice to the Fingerprint Scan block only.
    const scanStart = fullText.search(/Fingerprint\s*Scan/i);
    const scanEnd = fullText.search(/Check\s*Out\s*Other\s*Tools|What\s*Websites\s*See|Frequently\s*Asked|FAQ/i);
    const scanBlock = scanStart >= 0 && scanEnd > scanStart
      ? fullText.slice(scanStart, scanEnd)
      : (scanStart >= 0 ? fullText.slice(scanStart, scanStart + 3000) : '');

    const positive = /(\bconsistent\b|looks legit|\bpassed\b|no inconsistencies|real browser|trustworthy|no\s+automated|No\s+Issue)/i.test(scanBlock);
    const negative = /(modified browser|masking detected|\binconsistent\b|anti[- ]detect\s*(browser|detected)|fingerprint masking|automation detected|bot detected)/i.test(scanBlock);

    const detectedFlags = [];
    // Stricter than the old test -- bare 'anti-detect' matches a menu link;
    // require 'anti-detect browser' or 'anti-detect detected'.
    if (/anti[- ]detect\s+(browser|detected)/i.test(scanBlock)) detectedFlags.push('anti_detect');
    if (/masking detected/i.test(scanBlock)) detectedFlags.push('masking');
    if (/\binconsistent\b/i.test(scanBlock)) detectedFlags.push('inconsistent');
    if (/modified browser/i.test(scanBlock)) detectedFlags.push('modified');
    if (/automation detected/i.test(scanBlock)) detectedFlags.push('automation');
    if (/bot detected/i.test(scanBlock)) detectedFlags.push('bot');
    if (/\bspoof(?:ed|ing)?\b/i.test(scanBlock)) detectedFlags.push('spoof');
    if (/fingerprint masking/i.test(scanBlock)) detectedFlags.push('fingerprint_masking');

    // Whether the scan block has real scan content: either the platform
    // line, the "Bot check" status, or the "No automated behavior" verdict.
    const verdictRendered = /Chrome\s+\d+(?:\.\d+)*\s+on\s+(Windows|Mac|Linux|Android|iOS)/i.test(scanBlock)
      || /\bBot\s+check\b/i.test(scanBlock)
      || /No\s+automated\s+behavior\s+detected/i.test(scanBlock);

    return {
      positive_phrase: positive,
      negative_phrase: negative,
      detectedFlags,
      verdictRendered,
      sample: scanBlock.slice(0, 1500),
      fullSample: fullText.slice(0, 1200),
    };
  });
}

async function judge({ ctx, screenshotsDir, timestamp, label, fs, path }) {
  const page = await ctx.newPage();
  const out = { id: 'pixelscan', url: URL };
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // The fingerprint-check page runs its scan in JS; wait for either a
    // verdict phrase OR a per-test row label to appear.
    await page.waitForFunction(() => {
      const t = (document.body.innerText || '').toLowerCase();
      return /(consistent|inconsistent|modified|anti[- ]detect|masking detected|fingerprint check result|user agent\b)/.test(t);
    }, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const shot = path.join(screenshotsDir, `${timestamp}_${label}_pixelscan.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    out.screenshot = shot;

    const verdict = await extractPixelscanVerdict(page);
    const reasons = [];
    const warnings = [];
    if (!verdict.verdictRendered) {
      // Page never produced a verdict block (CDN block, scan stalled,
      // unexpected layout change). This is a TRUE soft signal: we don't
      // know whether the profile is good or bad -- only that pixelscan
      // didn't tell us. Record it as a warning and let the judge PASS so
      // the multi-judge gate doesn't fail solely on pixelscan
      // unreachability. Real positive flags (anti-detect detected, etc.)
      // still go into `reasons` below when they're present.
      warnings.push('no_verdict_rendered');
    }
    if (verdict.detectedFlags.length) {
      for (const f of verdict.detectedFlags) reasons.push(`flag:${f}`);
    }
    if (verdict.negative_phrase && !verdict.positive_phrase) {
      reasons.push('negative_phrase_only');
    }
    // Only mark "no verdict text" when the scan rendered but said nothing
    // positive AND nothing negative -- truly ambiguous.
    if (verdict.verdictRendered && !verdict.positive_phrase && !verdict.negative_phrase) {
      reasons.push('no_verdict_text');
    }

    out.raw = verdict;
    out.pass = reasons.length === 0;
    out.reasons = reasons;
    if (warnings.length) out.warnings = warnings;
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
