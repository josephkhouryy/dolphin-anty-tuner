/**
 * generate.js — Build candidate Dolphin Anty profile payloads.
 *
 * Two responsibilities:
 *   1. buildBaseline()  — pulls a fresh fingerprint from Dolphin's cloud API
 *                          (macOS by default, Chrome 147) and wraps it in a
 *                          profile payload ready for POST /browser_profiles.
 *                          Defaults to "manual" mode for every spoofable vector
 *                          so the Mac's real values don't leak through.
 *                          OS is controlled by `PROFILE_OS` env: 'macos' (default)
 *                          or 'windows'. macOS is the default because the bench
 *                          host IS a Mac -- spoofing Windows leaks the underlying
 *                          Mac WebGL/canvas pipeline and triggers fp.com's
 *                          `tampering=true` + `vm=true` signals.
 *   2. mutate(payload, knob, candidates) — returns a new payload with ONE vector
 *                          changed. Used by the hill-climbing tuner to walk the
 *                          configuration space.
 *
 * Knobs (and what they trade off):
 *   canvas:    real → noise → off       (noise usually best — matches real Chrome jitter)
 *   webgl:     real → noise → off
 *   audio:     real → noise → off
 *   clientRect:real → noise → off
 *   webrtc:    altered → real → disabled (altered = leak proxy IP; real = leak host IP — bad)
 *   timezone:  auto (derive from proxy) → manual
 *   locale:    auto → manual (en-US recommended for US proxy)
 *   geo:       auto → disabled (auto matches IP geolocation, lowest signal mismatch)
 *   mediaDevices: real → noise
 *   ports:     real → protect (closes the open-port leak that bot.sannysoft tests)
 *   doNotTrack: false / true
 *
 * Proxy plumbing: every payload includes the current IPRoyal session as
 * { type: 'http', host, port, login, password } so Dolphin's outbound traffic
 * actually goes through it.
 */
'use strict';
require('dotenv').config({ override: true });

const { getFingerprint } = require('./dolphin');
const { buildProxyUrl, getCurrentSessionId } = require('./iproyal');
const { randomBytes } = require('crypto');

// ─── Proxy block builder ──────────────────────────────────────────────────────

/**
 * Convert the current IPRoyal session into the proxy object Dolphin expects.
 * (Dolphin needs host/port/login/password as separate fields, not a URL.)
 */
function buildProxyBlock(sessionLabel) {
  const url = buildProxyUrl();                                  // uses current session ID
  const u = new URL(url);
  return {
    name: `iproyal-${sessionLabel || getCurrentSessionId() || 'session'}`,
    type: 'http',
    host: u.hostname,
    port: u.port,
    login: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    changeIpUrl: '',
  };
}

// ─── Baseline candidate ───────────────────────────────────────────────────────

// Default OS preset for new baselines. macOS is the default because the bench
// runner is a Mac -- spoofing Windows leaks the underlying Mac canvas/WebGL
// pipeline and triggers fp.com `tampering=true` + `vm=true`. Override per-run
// with PROFILE_OS=windows when a downstream platform actually requires Windows.
const PROFILE_OS = (process.env.PROFILE_OS || 'macos').toLowerCase();

function defaultPlatformNameFor(os) {
  if (os === 'macos') return 'MacIntel';
  if (os === 'linux') return 'Linux x86_64';
  return 'Win32';
}

function defaultCpuArchFor(os) {
  // Dolphin's macOS fingerprints typically report cpu.architecture='arm' on
  // M-series; fall through to whatever Dolphin gave us when present.
  if (os === 'macos') return 'arm';
  return 'x86';
}

function defaultOsVersionFor(os, fp) {
  if (fp?.os?.version) return fp.os.version;
  if (os === 'macos') return '10.15.7';
  return '10';
}

function defaultWebglVendorFor(os) {
  if (os === 'macos') return 'Google Inc. (Apple)';
  return 'Google Inc. (Intel)';
}

function defaultWebglRendererFor(os) {
  if (os === 'macos') return 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)';
  return 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
}

/**
 * Build the most-trustworthy baseline we can: take Dolphin's curated fingerprint
 * (already coherent across UA / WebGL / fonts / etc.) and put every vector in
 * 'manual' mode with that data plugged in. Canvas/WebGL/audio default to 'noise'
 * which is the sweet spot — adds per-profile jitter without giving up real
 * Chrome-like values entirely.
 *
 * `os` arg overrides the module-level PROFILE_OS env when set. Pass 'macos' /
 * 'windows' / 'linux'.
 */
async function buildBaseline({ name = `tuner-${Date.now()}`, sessionLabel, os } = {}) {
  const targetOs = (os || PROFILE_OS || 'macos').toLowerCase();
  const fp = await getFingerprint({ platform: targetOs, browser_version: '147' });

  const screenResolution = `${fp.screen?.width || 1920}x${fp.screen?.height || 1080}`;

  // Force consistency between UA and cpuArchitecture. Dolphin's macOS UA is
  // "Intel Mac OS X 10_15_7" (Apple's UA reduction default for Chrome) but
  // Dolphin's fingerprint sometimes returns cpu.architecture='arm' on
  // M-series presets. Intel UA + arm cpu is a tell -- fp.com flags vm=true.
  // Pin to x86 when the UA explicitly says "Intel Mac".
  let cpuArch = fp.cpu?.architecture || defaultCpuArchFor(targetOs);
  if (/Intel Mac OS X/i.test(fp.userAgent || '')) cpuArch = 'x86';

  return {
    name,
    tags: ['tuner'],
    platform: targetOs,
    browserType: 'anty',
    mainWebsite: 'facebook',

    // ─── Identity ─────────────────────────────────────
    useragent: { mode: 'manual', value: fp.userAgent },
    platformName: fp.platform || defaultPlatformNameFor(targetOs),
    cpuArchitecture: cpuArch,
    osVersion: defaultOsVersionFor(targetOs, fp),
    vendor: fp.vendor || 'Google Inc.',
    vendorSub: fp.vendorSub ?? '',
    product: fp.product || 'Gecko',
    productSub: fp.productSub || '20030107',
    appCodeName: fp.appCodeName || 'Mozilla',
    doNotTrack: !!fp.donottrack,

    // ─── Spoofed-by-default vectors ───────────────────
    canvas:     { mode: 'noise' },                              // adds tiny pixel jitter; defeats cross-site canvas hashing
    webgl:      { mode: 'noise' },                              // jitters WebGL buffer reads
    webglInfo:  {
      mode: 'manual',
      vendor:   fp.webgl?.unmaskedVendor   || defaultWebglVendorFor(targetOs),
      renderer: fp.webgl?.unmaskedRenderer || defaultWebglRendererFor(targetOs),
      webgl2Maximum: fp.webgl2Maximum,                          // raw JSON string from Dolphin
    },
    audio:      { mode: 'noise' },
    clientRect: { mode: 'noise' },
    webgpu:     { mode: 'manual', webgpu: fp.webgpu },
    timezone:   { mode: 'auto',  value: null },                  // auto = derive from proxy IP — coherent geolocation
    locale:     { mode: 'auto',  value: null },
    geolocation:{ mode: 'auto',  latitude: null, longitude: null, accuracy: null },

    // ─── Hardware ─────────────────────────────────────
    cpu:    { mode: 'manual', value: fp.hardwareConcurrency || 8 },
    memory: { mode: 'manual', value: fp.deviceMemory || 8 },
    screen: { mode: 'manual', resolution: screenResolution },

    // ─── Network ──────────────────────────────────────
    // 'off' = WebRTC turned off entirely (Dolphin's valid values are
    // off/real/manual/altered/udpDisabled). Strongest setting against
    // local-IP / dual-IP leaks; 'altered' (proxy IP) still leaves an ICE
    // surface. browserleaks reports both modes as ✔ No Leak, but 'off'
    // also kills the "host candidate" line that some detectors flag.
    webrtc: { mode: 'off', ipAddress: null },
    connection: {
      downlink:      fp.connection?.downlink      ?? 10,
      effectiveType: fp.connection?.effectiveType ?? '4g',
      rtt:           fp.connection?.rtt           ?? 100,
      saveData:      !!fp.connection?.saveData,
    },
    ports: { mode: 'protect', blacklist: null },                 // closes the open-port leak

    // ─── Fonts ────────────────────────────────────────
    fonts: tryParseFonts(fp.fonts),

    // ─── Misc ─────────────────────────────────────────
    mediaDevices: { mode: 'noise', audioInputs: null, videoInputs: null, audioOutputs: null },
    args: [],

    // ─── Proxy ────────────────────────────────────────
    proxy: buildProxyBlock(sessionLabel),

    // Carry the raw fingerprint along so we can re-mutate without re-fetching
    _meta: { sourceFingerprint: fp, sessionLabel, os: targetOs },
  };
}

function tryParseFonts(fontsField) {
  if (!fontsField) return undefined;
  if (Array.isArray(fontsField)) return fontsField;
  if (typeof fontsField === 'string') {
    try { return JSON.parse(fontsField); } catch { return undefined; }
  }
  return undefined;
}

// ─── Mutation knobs ───────────────────────────────────────────────────────────

// Dolphin's validator rejects "off" for canvas/webgl/audio/clientRect — only "noise"/"real" are accepted.
// For webrtc the valid values per Dolphin's validator (E_VALIDATION on bad input)
// are: off, real, manual, altered, udpDisabled. 'disabled' is NOT accepted.
const KNOBS = {
  canvas:        ['noise', 'real'],
  webgl:         ['noise', 'real'],
  audio:         ['noise', 'real'],
  clientRect:    ['noise', 'real'],
  mediaDevices:  ['noise', 'real'],
  webrtc:        ['off', 'altered', 'udpDisabled', 'real'],
  ports:         ['protect', 'real'],
  doNotTrack:    [false, true],
};

/**
 * Return a new payload with `knob` set to `value`. Does not mutate input.
 * Unknown knobs throw — keeps the tuner honest about which dials it's turning.
 */
function mutate(base, knob, value) {
  if (!(knob in KNOBS)) throw new Error(`Unknown knob: ${knob}`);
  const next = structuredClone(base);
  switch (knob) {
    case 'canvas':       next.canvas       = { mode: value }; break;
    case 'webgl':        next.webgl        = { mode: value }; break;
    case 'audio':        next.audio        = { mode: value }; break;
    case 'clientRect':   next.clientRect   = { mode: value }; break;
    case 'mediaDevices': next.mediaDevices = { ...next.mediaDevices, mode: value }; break;
    case 'webrtc':       next.webrtc       = { mode: value, ipAddress: null }; break;
    case 'ports':        next.ports        = { mode: value, blacklist: null }; break;
    case 'doNotTrack':   next.doNotTrack   = value; break;
  }
  return next;
}

/** Enumerate every (knob, value) pair we haven't tried yet in `history`. */
function* candidateMoves(base, history) {
  const tried = new Set(history.map(h => `${h.knob}=${JSON.stringify(h.value)}`));
  for (const [knob, values] of Object.entries(KNOBS)) {
    const current = readKnob(base, knob);
    for (const v of values) {
      if (JSON.stringify(v) === JSON.stringify(current)) continue;
      if (tried.has(`${knob}=${JSON.stringify(v)}`))      continue;
      yield { knob, value: v };
    }
  }
}

function readKnob(p, knob) {
  switch (knob) {
    case 'canvas':       return p.canvas?.mode;
    case 'webgl':        return p.webgl?.mode;
    case 'audio':        return p.audio?.mode;
    case 'clientRect':   return p.clientRect?.mode;
    case 'mediaDevices': return p.mediaDevices?.mode;
    case 'webrtc':       return p.webrtc?.mode;
    case 'ports':        return p.ports?.mode;
    case 'doNotTrack':   return p.doNotTrack;
  }
}

function freshName(prefix = 'tuner') {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
}

module.exports = { buildBaseline, mutate, candidateMoves, readKnob, buildProxyBlock, freshName, KNOBS };
