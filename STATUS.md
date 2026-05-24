# Good Dolphin Anty Profile Finder -- STATUS

Updated by the worker session whenever the situation changes meaningfully (not on every iteration).

## Pool state
**1 artifact** -- `output/795884582__score086.json` (score 86, suspect_score 14, only `vm` flagged). This was published BEFORE the new strict gate (`suspect_score=0` + no `anti_detect_browser`). Under the new gate it would not qualify. Joe owes a decision: keep as fallback / move to `rejected/` / delete. Until Joe decides, leave it in `output/` with the index row recording its actual suspect_score so downstream consumers filter on their own gate.

## Chain wiring (in progress, 2026-05-22)
Joe greenlit three changes:
1. Consume fresh fraud_score=0 IPs from `../Good IP Finder/output/index.jsonl`, one per profile attempt; write only validated good profiles (suspect_score=0, no `anti_detect_browser`) to `output/` + `output/index.jsonl`, each annotated with the IP it was built from. IP tracking via local `data/consumed-ips.json` set (the upstream folder stays read-only).
2. Refactor the flat layout (`bench.js`, `generate.js`, `tune.js`, etc.) into the one-mini-folder-per-function shape from `CLAUDE.md`; mirror Hotmail Multi Creator's structure (each function in its own subfolder with a README, one top-level `index.js` that composes them).
3. Never-delete-good-profile guard: before deleting any `tuner-*`/`verify-*`/`explore-*` Dolphin profile, read `../Hotmail Multi Creator/output/index.jsonl` and `../Twilio Multi Account Creator/output/index.jsonl`; if the profile ID appears in either, skip.

## Threshold split
TARGET_SCORE=90 (loop's convergence stopping signal) -- not yet reached.
PUBLISH_THRESHOLD=80 (write to output/ at this score) -- lowered from 90 because the single-knob hill climb caps around 86 with only `vm` flagged. Downstream (Hotmail Multi Creator) tests whether 86 + vm is good enough for Microsoft -- if it gets rejected, we'll learn from `rejected/` and tighten.

## Next-run plan
Restart with the new code (PUBLISH_THRESHOLD support + index.jsonl writes). Same 30-iter budget. Each iteration that scores >=80 publishes to output/ -- building the pool while still trying to crack the 90 ceiling.

## Known blockers / open problems
- **virtual_machine signal**: FP.com's VM detection trips on EC2 hardware (likely WebGL2Maximum constants or specific D3D11 vendor signature). Likely irreducible from inside Dolphin's config knob set.
- **bot detection**: One earlier iteration flagged Playwright/CDP as `nodriver`. Sporadic; not a stable problem yet.
- **ip_blocklist**: IPRoyal IPs sometimes flagged "residential proxy provider". Once `../Good IP Finder/output/` has fraud_score=0 IPs, switch to consuming from there.

## Chain wiring
This subproject currently calls IPRoyal directly via `iproyal.js`. The chain pattern (consume from `../Good IP Finder/output/`) is NOT yet wired -- the open strategic question in PROJECTS.md hasn't been resolved by Joe. Code is internally ready: `persistGoodProfile()` writes one file per artifact + a row in `output/index.jsonl` so downstream can tail.

## Code knobs available
canvas, webgl, audio, clientRect, mediaDevices (noise/real); webrtc (altered/real/disabled); ports (protect/real); doNotTrack (true/false). See `generate.js -> KNOBS`.
