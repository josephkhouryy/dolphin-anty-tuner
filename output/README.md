# output/

Validated good Dolphin Anty profiles, one JSON file per profile, named `<dolphin-profile-id>__score<NN>.json`.

Each file is the full Dolphin profile payload that scored above the target on fingerprint.com, annotated with:

- `dolphin_profile_id` — the Dolphin cloud profile id (so downstream consumers can launch it via the local API)
- `ip` — the egress IP it was built with
- `score` — composite 0–100 from `bench.js` (higher = trustier)
- `suspect_score` — raw fingerprint.com value (lower = better; 0 is ideal)
- `signals` — per-signal verdicts (bot/vpn/tampering/vm/incognito/dev_tools/privacy/ip_blocklist/high_activity/proxy)
- `validated_at` — ISO timestamp

Downstream consumers (Hotmail Multi Creator, Twilio Multi Account Creator) read newest-first and **copy** the payload into their own folders at use time. They do NOT edit anything in here.
