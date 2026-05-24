// judges/browserleaks.js -- browserleaks.com composite judge.
//
// Verdict source: four sub-pages, each surfacing one fingerprint dimension.
//   - /webrtc -- real-IP leak detection (the most actionable signal)
//   - /webgl  -- vendor/renderer match against declared platform
//   - /canvas -- canvas fingerprint hash + uniqueness rank
//   - /fonts  -- font count consistent with declared OS
//
// Pass criteria (first-pass):
//   - WebRTC: no IP printed that is NOT the declared proxy IP. (Caller passes
//     the expected proxy IP via the runtime `expectedProxyIp` option.)
//   - WebGL: vendor !== 'WebKit' (Mac leak) AND renderer !~ /swiftshader/i
//     (headless tell) AND vendor !~ /apple/i when declared OS is Windows.
//   - Canvas: a hash is present (no error).
//   - Fonts: count is between 10 and 600 (sanity range).
'use strict';

const SUBPAGES = [
  { id: 'webrtc',  url: 'https://browserleaks.com/webrtc'  },
  { id: 'webgl',   url: 'https://browserleaks.com/webgl'   },
  { id: 'canvas',  url: 'https://browserleaks.com/canvas'  },
  { id: 'fonts',   url: 'https://browserleaks.com/fonts'   },
];

async function extractSubpageData(page, id) {
  return page.evaluate((id) => {
    const text = document.body.innerText || '';

    if (id === 'webrtc') {
      const ipv4s = Array.from(text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)).map(m => m[0])
        .filter(ip => !ip.startsWith('0.') && !ip.startsWith('127.') && !ip.startsWith('255.'));
      const localIps = ipv4s.filter(ip =>
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        ip.startsWith('169.254.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      );
      const publicIps = ipv4s.filter(ip => !localIps.includes(ip));
      return { kind: 'webrtc', ipv4s, localIps, publicIps, sample: text.slice(0, 1200) };
    }

    if (id === 'webgl') {
      const vendor = (text.match(/Unmasked Vendor\s*\n+\s*([^\n]+)/i) || text.match(/Vendor\s*\n+\s*([^\n]+)/i) || [])[1] || null;
      const renderer = (text.match(/Unmasked Renderer\s*\n+\s*([^\n]+)/i) || text.match(/Renderer\s*\n+\s*([^\n]+)/i) || [])[1] || null;
      return { kind: 'webgl', vendor: vendor?.trim() || null, renderer: renderer?.trim() || null, sample: text.slice(0, 1200) };
    }

    if (id === 'canvas') {
      const hash = (text.match(/Signature\s*\n+\s*([A-Za-z0-9]+)/i) || text.match(/Hash\s*\n+\s*([A-Za-z0-9]+)/i) || [])[1] || null;
      const uniq = (text.match(/Uniqueness[^\n]*\n+\s*([^\n]+)/i) || [])[1] || null;
      return { kind: 'canvas', hash, uniqueness: uniq?.trim() || null, sample: text.slice(0, 1200) };
    }

    if (id === 'fonts') {
      const count = (text.match(/(\d+)\s+fonts\s+detected/i) || text.match(/Detected\s+Fonts[^\d]*(\d+)/i) || [])[1];
      return { kind: 'fonts', count: count ? Number(count) : null, sample: text.slice(0, 1200) };
    }

    return { kind: id, sample: text.slice(0, 1200) };
  }, id);
}

function judgeWebRTC(data, expectedProxyIp, opts = {}) {
  if (!data) return ['webrtc:no_data'];
  const reasons = [];
  if (expectedProxyIp) {
    const leaks = data.publicIps.filter(ip => ip !== expectedProxyIp);
    if (leaks.length) reasons.push(`webrtc:leak=${leaks.slice(0, 3).join(',')}`);
  } else {
    if ((data.publicIps || []).length > 1) reasons.push(`webrtc:multi_public_ip=${data.publicIps.length}`);
  }
  // The bench machine (EC2) always exposes its own VPC private IP via ICE
  // candidates -- the caller can pass `allowedLocalIps` (explicit list) or
  // `skipLocalIpCheck=true` to suppress that always-on noise. Without either,
  // any private-range leak still counts as a real signal (e.g. someone running
  // bench from a residential router).
  if (opts.skipLocalIpCheck) return reasons;
  const allowedLocal = new Set(opts.allowedLocalIps || []);
  const surprising = (data.localIps || []).filter(ip => !allowedLocal.has(ip));
  if (surprising.length) reasons.push(`webrtc:local_leak=${surprising.slice(0, 2).join(',')}`);
  return reasons;
}

function judgeWebGL(data, declaredOs) {
  if (!data) return ['webgl:no_data'];
  const reasons = [];
  const v = (data.vendor || '').toLowerCase();
  const r = (data.renderer || '').toLowerCase();
  if (v.includes('webkit')) reasons.push('webgl:vendor_webkit');
  if (r.includes('swiftshader')) reasons.push('webgl:renderer_swiftshader');
  if (declaredOs && /windows/i.test(declaredOs) && /apple/i.test(v)) reasons.push('webgl:apple_vendor_on_windows');
  if (declaredOs && /windows/i.test(declaredOs) && /metal/i.test(r)) reasons.push('webgl:metal_renderer_on_windows');
  if (!data.vendor && !data.renderer) reasons.push('webgl:both_missing');
  return reasons;
}

function judgeCanvas(data) {
  if (!data) return ['canvas:no_data'];
  if (!data.hash) return ['canvas:no_hash'];
  return [];
}

function judgeFonts(data) {
  if (!data) return ['fonts:no_data'];
  if (data.count == null) return ['fonts:count_unknown'];
  if (data.count < 10) return [`fonts:count_too_low=${data.count}`];
  if (data.count > 600) return [`fonts:count_too_high=${data.count}`];
  return [];
}

async function judge({
  ctx, screenshotsDir, timestamp, label, fs, path,
  expectedProxyIp = null,
  declaredOs = null,
  allowedLocalIps = null,
  skipLocalIpCheck = false,
}) {
  const out = { id: 'browserleaks', subpages: {} };
  const reasons = [];
  const webrtcOpts = { allowedLocalIps, skipLocalIpCheck };

  for (const sub of SUBPAGES) {
    const page = await ctx.newPage();
    const sout = { url: sub.url };
    try {
      await page.goto(sub.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      const shot = path.join(screenshotsDir, `${timestamp}_${label}_browserleaks_${sub.id}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      sout.screenshot = shot;
      sout.data = await extractSubpageData(page, sub.id);
      if (sub.id === 'webrtc') reasons.push(...judgeWebRTC(sout.data, expectedProxyIp, webrtcOpts));
      else if (sub.id === 'webgl') reasons.push(...judgeWebGL(sout.data, declaredOs));
      else if (sub.id === 'canvas') reasons.push(...judgeCanvas(sout.data));
      else if (sub.id === 'fonts') reasons.push(...judgeFonts(sout.data));
    } catch (e) {
      sout.error = e.message;
      reasons.push(`${sub.id}:error=${e.message.slice(0, 80)}`);
    } finally {
      await page.close().catch(() => {});
    }
    out.subpages[sub.id] = sout;
  }

  out.pass = reasons.length === 0;
  out.reasons = reasons;
  return out;
}

module.exports = { judge, SUBPAGES };
