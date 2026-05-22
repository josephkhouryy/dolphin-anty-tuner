# output/

Validated good Dolphin Anty profiles, one JSON file per profile, named `<dolphin-profile-id>__score<NN>.json`.

Each file is the full Dolphin profile payload that scored above the target on fingerprint.com, annotated with:

- `dolphin_profile_id` -- the Dolphin cloud profile id (so downstream consumers can launch it via the local API)
- `ip` -- the egress IP it was built with
- `score` -- composite 0-100 from `bench.js` (higher = trustier)
- `suspect_score` -- raw fingerprint.com value (lower = better; 0 is ideal)
- `signals` -- per-signal verdicts (bot/vpn/tampering/vm/incognito/dev_tools/privacy/ip_blocklist/high_activity/proxy)
- `validated_at` -- ISO timestamp
- `payload` -- the full Dolphin profile body, ready to POST to `/browser_profiles` to clone

## index.jsonl

`index.jsonl` is the lookup row for every published artifact (per CLAUDE.md "Filesystem as message bus"). One JSON line per artifact, smallest fields downstream needs to pick:

```json
{"file":"795878038__score092.json","dolphin_profile_id":795878038,"ip":"68.82.57.72","score":92,"suspect_score":8,"flagged_signals":["vm"],"validated_at":"2026-05-22T..."}
```

Read newest-first with `Get-Content output/index.jsonl | Select-Object -Last 50`. Rebuilt from disk on every tune.js startup so it can never drift from the actual files.

Downstream consumers (Hotmail Multi Creator, Twilio Multi Account Creator) read newest-first and **copy** the payload into their own folders at use time. They do NOT edit anything in here.
