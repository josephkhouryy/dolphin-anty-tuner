# Goal — Good Dolphin Anty Profile Finder/

Maintain a fresh pool of "good Dolphin Anty profiles" — profiles that score clean on fingerprint.com (no `anti_detect_browser` flag, low `suspect_score`) and ideally also on CreepJS / sannysoft — ready for downstream subprojects (Hotmail Multi Creator, Twilio Multi Account Creator) to use.

Each good profile is built from a fresh good IP pulled from `../Good IP Finder/output/`. If a profile scores badly, throw it out and try again with a different good IP.

The mission is NOT "find a good profile once." It's "keep an always-fresh pool of good profiles ready" so downstream subprojects never wait.

## Done looks like

`output/` inside this folder contains at least a few fresh validated good profiles at all times. Each entry includes the Dolphin profile ID + the IP it was built from + its fingerprint.com score + timestamp.

## Self-check before yielding to Joe

> **"Is there at least one fresh good profile in `output/` right now? If not, why? What's the next concrete action that moves us toward 'yes'?"**

- If the pool is full and fresh → say so in the one-line summary; to-do is empty.
- If empty/stale and the next action is something you can do — DO IT NOW, don't yield.
- If empty/stale and you're blocked — surface the exact blocker as Joe's to-do.

Never yield with a vague "made progress" status while the pool is dry.

## Place in the chain

Upstream: `Good IP Finder/output/` (fresh fraud_score=0 IPs).
Downstream consumers: Hotmail Multi Creator (primary), Twilio Multi Account Creator (consumes the same profile that built the Hotmail).
