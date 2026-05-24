// judges/fp-playground.js -- fingerprint.com playground judge.
//
// Verdict source:
//   - URL: https://demo.fingerprint.com/playground
//   - Parses the rendered "Suspect Score" + Smart Signals table.
//   - Also pulls the raw FP server-response JSON for cross-checking and the
//     anti_detect_browser flag, which the table doesn't surface.
//
// Pass criteria (strict gate):
//   - suspect_score === 0
//   - anti_detect_browser !== true
//   - No Smart Signal flagged true (bot, vpn, tampering, vm, incognito,
//     dev_tools, privacy, ip_blocklist, high_activity, proxy).
'use strict';

const URL = 'https://demo.fingerprint.com/playground';
const SIGNAL_KEYS = ['bot', 'vpn', 'tampering', 'vm', 'incognito', 'dev_tools', 'privacy', 'ip_blocklist', 'high_activity', 'proxy'];

async function extractFingerprintPayload(page) {
  return page.evaluate(() => {
    const looksLikeFpResponse = (o) => o && typeof o === 'object' && ('visitor_id' in o || 'identification' in o || 'suspect_score' in o || 'anti_detect_browser' in o);
    const blobs = Array.from(document.querySelectorAll('pre, code'))
      .map(el => (el.innerText || '').trim())
      .filter(t => t.length > 50 && t.includes('{'));
    for (const b of blobs) {
      try {
        const o = JSON.parse(b);
        if (looksLikeFpResponse(o)) return o;
      } catch {}
      try {
        const fn = new Function('return (' + b + ');');
        const o = fn();
        if (looksLikeFpResponse(o)) return o;
      } catch {}
      const out = {};
      const ss   = b.match(/suspect_score[^\d-]*(-?\d+(?:\.\d+)?)/);
      const adb  = b.match(/anti_detect_browser[^\w]*[:=]\s*(true|false)/);
      const tampering = b.match(/tampering[^\w]*[:=]\s*(true|false)/);
      const vm   = b.match(/virtual_machine[^\w]*[:=]\s*(true|false)/);
      const vpn  = b.match(/\bvpn[^\w]*[:=]\s*(true|false)/);
      const incog = b.match(/incognito[^\w]*[:=]\s*(true|false)/);
      const dev  = b.match(/developer_tools[^\w]*[:=]\s*(true|false)/);
      const proxy= b.match(/\bproxy[^\w_]*[:=]\s*(true|false)/);
      const priv = b.match(/privacy_settings[^\w]*[:=]\s*(true|false)/);
      const hi   = b.match(/high_activity_device[^\w]*[:=]\s*(true|false)/);
      if (ss)  out.suspect_score = Number(ss[1]);
      if (adb) out.anti_detect_browser = adb[1] === 'true';
      if (tampering) out.tampering = tampering[1] === 'true';
      if (vm)   out.virtual_machine = vm[1] === 'true';
      if (vpn)  out.vpn = vpn[1] === 'true';
      if (incog) out.incognito = incog[1] === 'true';
      if (dev)  out.developer_tools = dev[1] === 'true';
      if (proxy) out.proxy = proxy[1] === 'true';
      if (priv)  out.privacy_settings = priv[1] === 'true';
      if (hi)    out.high_activity_device = hi[1] === 'true';
      if (Object.keys(out).length) return out;
    }
    return null;
  });
}

async function extractPlaygroundSignals(page) {
  return page.evaluate(() => {
    const text = document.body.innerText || '';
    const lineAfter = (label) => {
      const re = new RegExp(label + '\\s*\\n+\\s*([^\\n]+)', 'i');
      const m = text.match(re);
      return m ? m[1].trim() : null;
    };
    const isPositive = (v) => v && /\bnot\s+detected\b|^false$/i.test(v);
    const isNegative = (v) => v && /\byes\b|\bdetected\b|^true$|using a vpn|tampering|virtual machine|is incognito/i.test(v);
    const sig = (label) => {
      const v = lineAfter(label);
      if (v == null) return { raw: null, flagged: null };
      if (isPositive(v)) return { raw: v, flagged: false };
      if (isNegative(v)) return { raw: v, flagged: true };
      return { raw: v, flagged: null };
    };
    const m = text.match(/Suspect Score\s*\n+\s*(-?\d+(?:\.\d+)?)/i);
    return {
      suspect_score: m ? Number(m[1]) : null,
      bot:          sig('Bot'),
      vpn:          sig('VPN'),
      tampering:    sig('Browser Tampering'),
      vm:           sig('Virtual Machine'),
      incognito:    sig('Incognito Mode'),
      dev_tools:    sig('Developer Tools'),
      privacy:      sig('Privacy Settings'),
      ip_blocklist: sig('IP Blocklist'),
      high_activity: sig('High-Activity Device'),
      visitor_id:   (text.match(/Visitor ID is\s*\n+\s*([A-Za-z0-9]+)/) || [])[1] || null,
    };
  });
}

function combineSignals(signals, payload) {
  const merged = {};
  for (const key of SIGNAL_KEYS) {
    let flagged = signals?.[key]?.flagged;
    if (flagged == null && payload) {
      const jsonKey = key === 'vm' ? 'virtual_machine'
        : key === 'dev_tools' ? 'developer_tools'
        : key === 'privacy' ? 'privacy_settings'
        : key === 'ip_blocklist' ? 'ip_blocklist'
        : key === 'high_activity' ? 'high_activity_device'
        : key;
      if (jsonKey in payload) flagged = !!payload[jsonKey];
    }
    merged[key] = flagged;
  }
  return merged;
}

async function judge({ ctx, screenshotsDir, timestamp, label, fs, path }) {
  const page = await ctx.newPage();
  const out = { id: 'fp_playground', url: URL };
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => /Suspect Score\s*\n+\s*\d/.test(document.body.innerText || ''),
      { timeout: 30000 }
    ).catch(() => {});
    await page.waitForTimeout(2000);

    const shot = path.join(screenshotsDir, `${timestamp}_${label}_fp_playground.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    out.screenshot = shot;

    const signals = await extractPlaygroundSignals(page);
    const payload = await extractFingerprintPayload(page);
    const merged_signals = combineSignals(signals, payload);
    const anti_detect_browser = payload?.anti_detect_browser ?? null;
    const flagged = Object.entries(merged_signals)
      .filter(([, v]) => v === true)
      .map(([k]) => k);

    const reasons = [];
    if (signals?.suspect_score !== 0) reasons.push(`suspect_score=${signals?.suspect_score ?? 'unknown'}`);
    if (anti_detect_browser === true) reasons.push('anti_detect_browser=true');
    for (const k of flagged) reasons.push(`signal:${k}`);

    out.raw = { signals, payload, merged_signals, anti_detect_browser };
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

module.exports = { judge, URL, SIGNAL_KEYS };
