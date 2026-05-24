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
      // browserleaks.com/webrtc explicitly prints the WebRTC verdict line
      // ("WebRTC Leak Test  ✔ No Leak" or "... ✖ Leaked"). Trust that
      // verdict first; only fall through to ICE-candidate IP scanning when
      // the line is missing.
      //
      // The page also lists the proxy IP twice ("Your Remote IP" and
      // "Public IP Address") and the old text-wide regex counted the same
      // IP twice and reported `multi_public_ip=2` as a leak. Anchor the
      // scrape to the SDP Log block instead -- ICE candidates only appear
      // inside the m=audio / a=candidate lines, never in the prose above.
      // Anchor below the "Your WebRTC IP" subheader so we don't read the
      // nav-menu link that also contains "WebRTC Leak Test".
      const resultStart = text.search(/Your\s+WebRTC\s+IP/i);
      const scanFrom = resultStart >= 0 ? text.slice(resultStart, resultStart + 800) : text;
      // Skip the leading "✔" / "✖" icon line; the verdict ("No Leak" /
      // "Leaked") is on the second line after the label.
      const leakStatus = (scanFrom.match(/WebRTC\s+Leak\s+Test\s*\n+[^\n]*\n+\s*([A-Za-z][^\n]+)/i)
        || scanFrom.match(/WebRTC\s+Leak\s+Test[^\n]*\n+\s*([A-Za-z][^\n]+)/i)
        || [])[1] || null;
      const leakSummary = leakStatus ? leakStatus.trim() : null;

      // Pull IPs ONLY from inside the SDP Log block (lines that start with
      // "candidate:..."). Anything outside is page chrome.
      const sdpStart = text.indexOf('SDP Log');
      const sdpBlock = sdpStart >= 0 ? text.slice(sdpStart, sdpStart + 4000) : '';
      const candidateIps = Array.from(sdpBlock.matchAll(/candidate:\d+\s+\d+\s+\w+\s+\d+\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g))
        .map(m => m[1]);
      // Dedupe -- the same IP appearing across host/srflx candidates is one IP.
      const ipv4s = Array.from(new Set(candidateIps));
      const localIps = ipv4s.filter(ip =>
        ip.startsWith('10.') ||
        ip.startsWith('192.168.') ||
        ip.startsWith('169.254.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      );
      const publicIps = ipv4s.filter(ip => !localIps.includes(ip));
      return { kind: 'webrtc', leakSummary, ipv4s, localIps, publicIps, sample: text.slice(0, 1200) };
    }

    if (id === 'webgl') {
      // browserleaks renders the unmasked-vendor/renderer rows as:
      //   "Unmasked Vendor\n!\nGoogle Inc. (AMD)"
      // where the "!" is a tooltip icon. The old regex grabbed "!" instead
      // of the real value. Skip any single-char "!" line, plus any line
      // that's purely whitespace, and grab the first non-trivial line after
      // the label. Also recognise "WebGL Vendor" / "WebGL Renderer".
      const grabAfter = (label) => {
        const re = new RegExp(label + '\\s*((?:\\n+[^\\n]*){0,6})', 'i');
        const m = text.match(re);
        if (!m) return null;
        const lines = m[1].split('\n').map(s => s.trim()).filter(s => s && s !== '!' && s !== '?' && s !== '✔' && s !== '✖');
        // First non-trivial line is the value; anything starting with
        // another label-looking row ends the field.
        const stop = /^(Unmasked|Vendor|Renderer|GL Version|Shading|WebGL|Antialias|Debug|HTTP)/i;
        for (const line of lines) {
          if (stop.test(line)) break;
          return line;
        }
        return null;
      };
      const vendor = grabAfter('Unmasked Vendor') || grabAfter('WebGL Vendor');
      const renderer = grabAfter('Unmasked Renderer') || grabAfter('WebGL Renderer');
      return { kind: 'webgl', vendor: vendor || null, renderer: renderer || null, sample: text.slice(0, 1200) };
    }

    if (id === 'canvas') {
      // Page format: "Canvas Fingerprint\nSignature\n<HEX>\nUniqueness\n<text>".
      // The old regex was `Signature\s*\n+\s*([A-Za-z0-9]+)` which also
      // matches the "Signature Stats" header further down (where the value
      // is the prose "It's very likely..."). Anchor to a hex-only token at
      // least 16 chars long to avoid prose. Same fix on Uniqueness -- it's
      // a line of prose ("99.99% (6 of 298939 user agents...)").
      const sigBlock = text.match(/Canvas Fingerprint\s*\n+\s*Signature\s*\n+\s*([0-9A-Fa-f]{16,})/);
      const hash = sigBlock ? sigBlock[1] : (text.match(/\bSignature\s*\n+\s*([0-9A-Fa-f]{16,})/) || [])[1] || null;
      const uniq = (text.match(/Uniqueness\s*\n+\s*([^\n]+)/i) || [])[1] || null;
      // Canvas page also outs the OS guess when running on a spoofed UA --
      // "It's very likely that your web browser is Chrome and your operating
      // system is <Mac|Windows|Linux>". This is the canvas-driven OS-leak
      // signal that fp.com translates into tampering=true. Surface it so the
      // judge can pass-or-fail on it directly.
      const osGuess = (text.match(/operating system is\s+([A-Za-z]+)/i) || [])[1] || null;
      const browserGuess = (text.match(/web browser is\s+([A-Za-z]+)/i) || [])[1] || null;
      return { kind: 'canvas', hash, uniqueness: uniq?.trim() || null, osGuess, browserGuess, sample: text.slice(0, 1200) };
    }

    if (id === 'fonts') {
      // Current page wording: "Report\n460 fonts and 306 unique metrics found"
      // Plus an old fallback that said "X fonts detected".
      const m = text.match(/(\d+)\s+fonts\s+and\s+\d+\s+unique\s+metrics\s+found/i)
            || text.match(/(\d+)\s+fonts\s+detected/i)
            || text.match(/Detected\s+Fonts[^\d]*(\d+)/i);
      const count = m ? Number(m[1]) : null;
      return { kind: 'fonts', count, sample: text.slice(0, 1200) };
    }

    return { kind: id, sample: text.slice(0, 1200) };
  }, id);
}

function judgeWebRTC(data, expectedProxyIp, opts = {}) {
  if (!data) return ['webrtc:no_data'];
  const reasons = [];

  // Prefer the page's own verdict line ("WebRTC Leak Test  ✔ No Leak" /
  // "... ✖ Leaked"). A "No Leak" reading is authoritative -- skip the
  // ICE-IP scan in that case so we don't double-count.
  const lineLower = (data.leakSummary || '').toLowerCase();
  if (lineLower.includes('no leak')) return reasons;
  if (lineLower.includes('leaked') || lineLower.includes('leak detected')) {
    reasons.push(`webrtc:page_says_leaked`);
  }

  if (expectedProxyIp) {
    const leaks = (data.publicIps || []).filter(ip => ip !== expectedProxyIp);
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

function judgeCanvas(data, declaredOs) {
  if (!data) return ['canvas:no_data'];
  if (!data.hash) return ['canvas:no_hash'];
  // The canvas page prints its own OS/browser guess derived from rendering
  // signatures ("It's very likely that your web browser is Chrome and your
  // operating system is Mac"). When that guess disagrees with the declared
  // OS we're spoofing, fp.com flips `tampering=true`. Surface the mismatch
  // explicitly so the tuner sees it.
  if (declaredOs && data.osGuess) {
    const declared = declaredOs.toLowerCase();
    const guessed = data.osGuess.toLowerCase();
    const normDeclared = declared.includes('win') ? 'windows'
      : declared.includes('mac') ? 'mac'
      : declared.includes('linux') ? 'linux'
      : declared;
    const normGuessed = guessed.includes('win') ? 'windows'
      : guessed.includes('mac') ? 'mac'
      : guessed.includes('linux') ? 'linux'
      : guessed;
    if (normDeclared !== normGuessed) {
      return [`canvas:os_mismatch_declared=${normDeclared}_canvas_says=${normGuessed}`];
    }
  }
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
      else if (sub.id === 'canvas') reasons.push(...judgeCanvas(sout.data, declaredOs));
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
