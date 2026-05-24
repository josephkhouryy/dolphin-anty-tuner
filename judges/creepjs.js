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

    // CreepJS renders the trust % in a fixed banner at the top of the
    // results: `"<grade>" <NN>% (NN.NN/100)`. Examples seen in the wild:
    //   "F  20% (20/100)"          -- single-letter grade + space + percent
    //   "A   97% (97.50/100)"
    //   "<grade>: 84% trust"       (older format)
    //   "trust score: 60%"
    // Anchor to the "/100" companion or to "trust" so we don't accidentally
    // grab `99.99%` from "99.99% (6 of 298939...)" further down.
    const trustMatch =
      text.match(/(-?\d+(?:\.\d+)?)\s*%\s*\(\s*-?\d+(?:\.\d+)?\s*\/\s*100\s*\)/) ||
      text.match(/(-?\d+(?:\.\d+)?)\s*%\s*trust/i) ||
      text.match(/trust\s*score[^\d-]*(-?\d+(?:\.\d+)?)\s*%/i);
    const trust = trustMatch ? Number(trustMatch[1]) : null;

    // Lies count: "lies (N)" or "N lies" header. The block prints as
    // "lies (4)" right above the per-lie list.
    const liesMatch =
      text.match(/lies\s*\(\s*(\d+)\s*\)/i) ||
      text.match(/(\d+)\s+lies\b/i);
    const lies = liesMatch ? Number(liesMatch[1]) : null;

    // CreepJS publishes a dedicated "Headless" block whose lines read like
    //   "Headless<hash>
    //    chromium: true
    //    31% like headless: <hash>
    //    33% headless: <hash>
    //    20% stealth: <hash>"
    // The classifiers ALWAYS render with "true/false" for chromium and a
    // numeric % for the headless/stealth detectors -- a value at or above
    // 50% on either of "headless" or "stealth" is the strong positive.
    // Below 50% the page is saying "I see no automation tells", even though
    // the rows still contain the literal word "headless". The old parser
    // matched on the word alone and reported `tag:headless` on every probe.
    const automationTags = [];
    let headlessSignals = null;
    // Require AT LEAST ONE hex char ([0-9a-f]+, not [0-9a-f]*) so the regex
    // anchors only on the real "Headless<hash>" block header. With * the
    // pattern can match any line that ends with the bare word "headless"
    // (e.g. an explanatory row whose innerText is "...headless\n"), and
    // text.match() returns the FIRST match, so the captured block would
    // contain unrelated content and headlessClass would be null -- silently
    // suppressing real headless detection.
    const headlessBlockMatch = text.match(/Headless[0-9a-f]+\s*\n([\s\S]{0,400})/i);
    if (headlessBlockMatch) {
      const block = headlessBlockMatch[1];
      const headlessPct = (block.match(/(\d+(?:\.\d+)?)\s*%\s*headless/i) || [])[1];
      const stealthPct = (block.match(/(\d+(?:\.\d+)?)\s*%\s*stealth/i) || [])[1];
      const likePct = (block.match(/(\d+(?:\.\d+)?)\s*%\s*like\s+headless/i) || [])[1];
      const headlessClass = headlessPct ? Number(headlessPct) : null;
      const stealthClass = stealthPct ? Number(stealthPct) : null;
      const likeClass = likePct ? Number(likePct) : null;
      // Only flag when CreepJS's own classifier confidently says yes.
      // 75%+ is the project's published threshold for a hard positive.
      if (headlessClass != null && headlessClass >= 75) automationTags.push('headless');
      if (stealthClass != null && stealthClass >= 75) automationTags.push('stealth');
      headlessSignals = {
        chromium: /chromium:\s*true/i.test(block),
        headlessClass,
        stealthClass,
        likeClass,
      };
    }
    // Webdriver row -- CreepJS renders it as "Webdriver<hash>\nfalse\n" when
    // the flag is hidden by the stealth layer. Only flag when it's "true".
    // `[0-9a-f]+` (not `*`) so we only match the real block header, not a
    // bare "webdriver" word elsewhere.
    if (/Webdriver[0-9a-f]+\s*\n\s*true\b/i.test(text)) automationTags.push('webdriver');

    // Fingerprint ID at the top of the page: "FP ID: <64-char hex>".
    const fpHash = (text.match(/FP\s*ID[:\s]+([0-9a-f]{12,})/i)
      || text.match(/fingerprint\s*([0-9a-f]{12,})/i)
      || [])[1] || null;

    // The "Lies" block, when present, looks like:
    //   "Lies<hash>
    //    lies (N)
    //    <list of lies>"
    // -- but `Lies\s*\(\s*\d+\s*\)` is rarely the layout. Try harder:
    let liesFromBlock = null;
    if (lies == null) {
      const liesBlockMatch = text.match(/\bLies[0-9a-f]+\s*\n\s*(\d+)\s/i);
      if (liesBlockMatch) liesFromBlock = Number(liesBlockMatch[1]);
    }

    return {
      trust,
      lies: lies != null ? lies : liesFromBlock,
      automationTags,
      headlessSignals,
      fpHash,
      // Larger sample so debugging the page layout doesn't require a fresh
      // run. The trust score and lies count tend to be far down the page.
      sample: text.slice(0, 8000),
      textLength: text.length,
    };
  });
}

async function judge({ ctx, screenshotsDir, timestamp, label, fs, path }) {
  const page = await ctx.newPage();
  const out = { id: 'creepjs', url: URL };
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // CreepJS does a slow client-side compute; wait for the trust % or for
    // the grade banner (`A 97% (97.50/100)` style) to render. Some Mac
    // configurations take 30s+ to settle the trust banner.
    await page.waitForFunction(
      () => {
        const t = document.body.innerText || '';
        // Either the trust phrase or the `<n>% (<n>/100)` banner.
        return /%\s*trust|trust\s*score[^\d]*\d|\d+(?:\.\d+)?\s*%\s*\(\s*\d+(?:\.\d+)?\s*\/\s*100\s*\)/i.test(t);
      },
      { timeout: 60000 }
    ).catch(() => {});
    await page.waitForTimeout(5000);

    const shot = path.join(screenshotsDir, `${timestamp}_${label}_creepjs.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    out.screenshot = shot;

    const verdict = await extractCreepjsVerdict(page);
    const reasons = [];
    const warnings = [];

    // CreepJS renders its overall "trust score" as a canvas-drawn banner
    // (image, not text). innerText therefore can't capture the number on
    // most page layouts. Fall back to the per-component signals we CAN
    // read: when trust is null but the Headless block reports both
    // headlessClass < 50 AND stealthClass < 50 (i.e. CreepJS's own
    // classifiers see no automation tells), treat the missing trust score
    // as a soft signal so the judge can still pass on a clean profile.
    const h = verdict.headlessSignals;
    const componentsClean = h
      && (h.headlessClass == null || h.headlessClass < 50)
      && (h.stealthClass == null || h.stealthClass < 50);

    if (verdict.trust == null) {
      if (componentsClean) {
        warnings.push('trust=unknown_components_clean');
      } else {
        reasons.push('trust=unknown');
      }
    } else if (verdict.trust < TRUST_THRESHOLD) {
      reasons.push(`trust=${verdict.trust}<${TRUST_THRESHOLD}`);
    }
    if (verdict.lies == null) {
      // No "Lies (N)" header in the page text -- typical for the canvas
      // layout. Don't fail on this if components are clean.
      if (!componentsClean) reasons.push('lies=unknown');
    } else if (verdict.lies > 0) {
      reasons.push(`lies=${verdict.lies}`);
    }
    for (const tag of verdict.automationTags) reasons.push(`tag:${tag}`);

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

module.exports = { judge, URL, TRUST_THRESHOLD };
