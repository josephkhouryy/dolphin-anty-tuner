# Good Dolphin Anty Profile Finder -- STATUS

Updated by the worker session whenever the situation changes meaningfully (not on every iteration).

## Pool state
**1 artifact** -- `output/795884582__score086.json` (score 86, suspect_score 14, only `vm` flagged). First published profile. The `vm` signal looks irreducible from Dolphin's knob set on EC2 hardware; everything else (bot, vpn, tampering, ip_blocklist, incognito, dev_tools, privacy, high_activity) verifies clean.

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
