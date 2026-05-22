# Good Dolphin Anty Profile Finder -- STATUS

Updated by the worker session whenever the situation changes meaningfully (not on every iteration).

## Pool state
Empty. Best score so far across runs: 83/100 (suspect_score = 16), under the >=90 threshold needed to publish to output/. Closest signal still flagging: `virtual_machine: true` (FP.com detects EC2 hardware as a VM).

## Current run
A `DolphinAntyTuner` Scheduled Task is running on the EC2 VM (3.142.174.38) iterating up to 30 mutations from a fresh baseline. Output stream: `tune.log` on the VM. Wait task here on the Mac fires when status flips Running -> Ready.

## Known blockers / open problems
- **virtual_machine signal**: FP.com's VM detection trips on EC2 hardware (likely WebGL2Maximum constants or specific D3D11 vendor signature). May be irreducible from inside Dolphin's config knob set -- the spoofable surface might not cover the underlying virtualization tell.
- **bot detection**: One iteration showed FP.com flagging Playwright/CDP as `nodriver`. Sporadic so far -- worth a closer look if it stabilizes as a problem.
- **ip_blocklist**: IPRoyal IPs frequently flagged as "residential proxy provider". Once `Good IP Finder/output/` has fraud_score=0 IPs, switch to consuming from there.

## Chain wiring
This subproject currently calls IPRoyal directly via `iproyal.js`. The chain pattern (consume from `../Good IP Finder/output/`) is NOT yet wired -- the open strategic question in PROJECTS.md hasn't been resolved by Joe. Code is internally ready: `persistGoodProfile()` writes one file per artifact + a row in `output/index.jsonl` so downstream can tail.

## Code knobs available
canvas, webgl, audio, clientRect, mediaDevices (noise/real); webrtc (altered/real/disabled); ports (protect/real); doNotTrack (true/false). See `generate.js -> KNOBS`.
