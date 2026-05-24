// judges/sannysoft.js -- bot.sannysoft.com judge.
//
// Verdict source:
//   - URL: https://bot.sannysoft.com/
//   - Renders a table of classic bot-detection tests. Each row's <td> class is
//     either "passed" (green) or "failed" (red).
//
// Pass criteria:
//   - Zero "failed" rows.
//   - "WebDriver" test row must be green (otherwise the puppeteer/playwright
//     stealth layer leaked).
'use strict';

const URL = 'https://bot.sannysoft.com/';

async function extractSannysoftVerdict(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tr'));
    const results = rows.map(tr => {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (!cells.length) return null;
      const label = (cells[0]?.innerText || '').trim();
      const verdictCells = cells.slice(1).map(td => ({
        text: (td.innerText || '').trim(),
        className: td.className || '',
        failed: /\bfailed\b/i.test(td.className || ''),
        passed: /\bpassed\b/i.test(td.className || ''),
      }));
      const anyFailed = verdictCells.some(c => c.failed);
      const anyPassed = verdictCells.some(c => c.passed);
      return { label, verdictCells, anyFailed, anyPassed };
    }).filter(Boolean);

    const failedRows = results.filter(r => r.anyFailed).map(r => r.label);
    const webdriverRow = results.find(r => /webdriver/i.test(r.label));

    return {
      total: results.length,
      failedCount: failedRows.length,
      failedLabels: failedRows,
      webdriverFailed: webdriverRow ? webdriverRow.anyFailed : null,
    };
  });
}

async function judge({ ctx, screenshotsDir, timestamp, label, fs, path }) {
  const page = await ctx.newPage();
  const out = { id: 'sannysoft', url: URL };
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('table tr', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const shot = path.join(screenshotsDir, `${timestamp}_${label}_sannysoft.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    out.screenshot = shot;

    const verdict = await extractSannysoftVerdict(page);
    const reasons = [];
    if (verdict.total === 0) reasons.push('no_rows_parsed');
    if (verdict.webdriverFailed === true) reasons.push('webdriver_failed');
    else if (verdict.webdriverFailed === null && verdict.total > 0) reasons.push('webdriver_row_not_found');
    if (verdict.failedCount > 0) {
      for (const r of verdict.failedLabels.slice(0, 6)) reasons.push(`failed:${r}`);
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
