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

    // Pixelscan's marketing chrome (header nav, footer, FAQ, recommendation
    // lists, sales callouts) all carry phrases that a naive keyword scan
    // misreads as failure verdicts. Strip the chrome blocks before scanning
    // by extracting only the section between the page's title and the
    // footer/FAQ anchors. We also drop any line that contains a known
    // marketing CTA so menu items can't bleed in.
    const titleIdx = fullText.search(/Fingerprint\s*Check|Browser\s*Fingerprint/i);
    const footerIdx = fullText.search(/Frequently\s*Asked|FAQ|Pixelscan\s*Partners|Special\s*Offers|Best\s*Anti[- ]?Detect|Best\s*Proxies/i);
    const sliceStart = titleIdx >= 0 ? titleIdx : 0;
    const sliceEnd = footerIdx > sliceStart ? footerIdx : fullText.length;
    const verdictBlock = fullText.slice(sliceStart, sliceEnd);

    // Strip lines that are obviously menu items / CTAs.
    const verdictClean = verdictBlock
      .split('\n')
      .filter(line => !/^(See|Get|Best|Top|Stay|Try|Buy|Save|\$|Discover|Resources|Tools|Products|Company|Special|RECOMMENDED|TOOLS|GUIDES|RESOURCES|COMPANY|CHECKERS|PARTNERS|BEST)/i.test(line.trim()))
      .filter(line => !/multilogin|nodemaven|kameleo|gologin|adspower|dolphin|antidetect browser|proxy provider|residential prox|partner/i.test(line))
      .join('\n');

    const positive = /(\bconsistent\b|looks legit|\bpassed\b|no inconsistencies|real browser|trustworthy)/i.test(verdictClean);
    const negative = /(modified browser|masking detected|\binconsistent\b|anti[- ]detect|fingerprint masking|automation detected|bot detected|\bspoof)/i.test(verdictClean);

    const detectedFlags = [];
    if (/anti[- ]detect/i.test(verdictClean)) detectedFlags.push('anti_detect');
    if (/masking detected/i.test(verdictClean)) detectedFlags.push('masking');
    if (/\binconsistent\b/i.test(verdictClean)) detectedFlags.push('inconsistent');
    if (/modified browser/i.test(verdictClean)) detectedFlags.push('modified');
    if (/automation detected/i.test(verdictClean)) detectedFlags.push('automation');
    if (/bot detected/i.test(verdictClean)) detectedFlags.push('bot');
    if (/\bspoof/i.test(verdictClean)) detectedFlags.push('spoof');
    if (/fingerprint masking/i.test(verdictClean)) detectedFlags.push('fingerprint_masking');

    // Whether the verdict block actually has scan results -- if it doesn't
    // contain any of the expected per-test labels, the page never ran the
    // scan (CDN block, paywall, redirect to landing page).
    const verdictRendered = /\b(IP Address|User Agent|Timezone|WebGL|Canvas|WebRTC|Fonts|Languages|Screen|Audio Context)\b/i.test(verdictClean);

    return {
      positive_phrase: positive,
      negative_phrase: negative,
      detectedFlags,
      verdictRendered,
      sample: verdictClean.slice(0, 1200),
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
    if (!verdict.verdictRendered) {
      // Page never produced a verdict block. Don't fabricate a `flag:` from
      // marketing chrome -- surface it as a soft signal instead so the
      // tuner sees "page never loaded" rather than "definitely anti-detect".
      reasons.push('no_verdict_rendered');
    } else {
      if (verdict.detectedFlags.length) {
        for (const f of verdict.detectedFlags) reasons.push(`flag:${f}`);
      }
      if (verdict.negative_phrase && !verdict.positive_phrase) {
        reasons.push('negative_phrase_only');
      }
      if (!verdict.positive_phrase && !verdict.negative_phrase) {
        reasons.push('no_verdict_text');
      }
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
