// lib/never-delete-guard.js -- guard so we never delete a Dolphin profile
// that a downstream subproject is already using.
//
// Joe's rule (2026-05-22): any Dolphin profile that has been used by a
// downstream subproject to produce gold (a Hotmail account, a Twilio trial,
// etc.) MUST NEVER be deleted. These profiles are precious -- low fingerprint
// score AND already accepted by Microsoft / Twilio -- and we want to reuse
// them for other services later.
//
// The guard reads downstream subprojects' output ledgers (per the
// filesystem-as-message-bus pattern in CLAUDE.md) and returns whether a given
// profile ID appears in any of them. Callers (tune.js cleanup,
// experiment/loop runners, the new continuous producer) MUST call this before
// any deleteProfile().
'use strict';

const fs = require('fs');
const path = require('path');

// Downstream output ledgers we check. Each is a JSONL file where each row
// includes a `dolphin_profile_id` field. Paths are relative to the project
// root (the parent dir of this file's grand-parent).
const SUBPROJECT_ROOT = path.resolve(__dirname, '..');
const DOLPHIN_ANTY_ROOT = path.resolve(SUBPROJECT_ROOT, '..');
const DOWNSTREAM_LEDGERS = [
  path.join(DOLPHIN_ANTY_ROOT, 'Hotmail Multi Creator', 'output', 'index.jsonl'),
  path.join(DOLPHIN_ANTY_ROOT, 'Twilio Multi Account Creator', 'output', 'index.jsonl'),
];

// Module-level mtime cache. A continuous producer calls the guard once per
// iteration, so we cache each ledger's parsed id set and skip the re-read
// when the file hasn't changed since last call. Cache key is (path, mtimeMs);
// any write by downstream bumps mtime and we re-read. This is safer than a
// TTL cache because it never serves stale data after a real downstream write.
const ledgerCache = new Map(); // path -> { mtimeMs, ids }

/**
 * Read one ledger and return the set of dolphin_profile_id values in it.
 * Missing file returns an empty set (downstream just hasn't produced anything
 * yet). Malformed rows are skipped silently -- we'd rather miss one row than
 * abort the whole guard. Result is cached by file mtime.
 */
function readLedgerProfileIds(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return new Set();
  let stat;
  try {
    stat = fs.statSync(ledgerPath);
  } catch (e) {
    console.warn(`[guard] could not stat ${ledgerPath}: ${e.message}`);
    return new Set();
  }
  const cached = ledgerCache.get(ledgerPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.ids;

  const ids = new Set();
  let content;
  try {
    content = fs.readFileSync(ledgerPath, 'utf8');
  } catch (e) {
    console.warn(`[guard] could not read ${ledgerPath}: ${e.message}`);
    return ids;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      // Accept both string and number IDs -- downstream subprojects may differ
      // in how they serialize the field. Comparison sites use the same
      // String() coercion before lookup.
      if (row && row.dolphin_profile_id != null) {
        ids.add(String(row.dolphin_profile_id));
      }
    } catch {
      // Skip malformed lines.
    }
  }
  ledgerCache.set(ledgerPath, { mtimeMs: stat.mtimeMs, ids });
  return ids;
}

/**
 * Returns `{ used: boolean, where: string|null }` for a given Dolphin profile
 * ID. `where` is the relative path of the ledger that contains it (for
 * logging) when used=true.
 */
function isProfileUsedDownstream(profileId) {
  if (profileId == null) return { used: false, where: null };
  const key = String(profileId);
  for (const ledger of DOWNSTREAM_LEDGERS) {
    const ids = readLedgerProfileIds(ledger);
    if (ids.has(key)) {
      return { used: true, where: path.relative(DOLPHIN_ANTY_ROOT, ledger) };
    }
  }
  return { used: false, where: null };
}

/**
 * Convenience wrapper that throws when the caller would otherwise delete a
 * protected profile. Callers can use this OR isProfileUsedDownstream + their
 * own branching; the throw shape is meant for accidental misuse paths where
 * the calling code forgot to check.
 */
function assertSafeToDelete(profileId) {
  const { used, where } = isProfileUsedDownstream(profileId);
  if (used) {
    throw new Error(`refused to delete profile ${profileId}: in use by ${where}`);
  }
}

module.exports = {
  isProfileUsedDownstream,
  assertSafeToDelete,
  DOWNSTREAM_LEDGERS,
};
