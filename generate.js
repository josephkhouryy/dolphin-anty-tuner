/**
 * generate.js — Build candidate Dolphin Anty profile payloads.
 *
 * Two responsibilities:
 *   1. buildBaseline()  — pulls a fresh fingerprint from Dolphin's cloud API
 *                          (Windows / Chrome 147) and wraps it in a profile payload
 *                          ready for POST /browser_profiles. Defaults to "manual"
 *                          mode for every spoofable vector so the Mac's real values
 *                          don't leak through.
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

/**
 * Build the most-trustworthy baseline we can: take Dolphin's curated fingerprint
 * (already coherent across UA / WebGL / fonts / etc.) and put every vector in
 * 'manual' mode with that data plugged in. Canvas/WebGL/audio default to 'noise'
 * which is the sweet spot — adds per-profile jitter without giving up real
 * Chrome-like values entirely.
 */
async function buildBaseline({ name = `tuner-${Date.now()}`, sessionLabel } = {}) {
  const fp = await getFingerprint({ platform: 'windows', browser_version: '147' });

  const screenResolution = `${fp.screen?.width || 1920}x${fp.screen?.height || 1080}`;

  return {
    name,
    tags: ['tuner'],
    platform: 'windows',
    browserType: 'anty',
    mainWebsite: 'facebook',

    // ─── Identity ─────────────────────────────────────
    useragent: { mode: 'manual', value: fp.userAgent },
    platformName: fp.platform || 'Win32',
    cpuArchitecture: fp.cpu?.architecture || 'x86',
    osVersion: fp.os?.version || '10',
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
      vendor:   fp.webgl?.unmaskedVendor   || 'Google Inc. (Intel)',
      renderer: fp.webgl?.unmaskedRenderer || 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
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
    webrtc: { mode: 'altered', ipAddress: null },                // altered = WebRTC reports proxy IP, NOT host
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
    _meta: { sourceFingerprint: fp, sessionLabel },
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
const KNOBS = {
  canvas:        ['noise', 'real'],
  webgl:         ['noise', 'real'],
  audio:         ['noise', 'real'],
  clientRect:    ['noise', 'real'],
  mediaDevices:  ['noise', 'real'],
  webrtc:        ['altered', 'real', 'disabled'],
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
