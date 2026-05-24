# produce/

Continuous producer. The piece that makes "unlimited good profiles" actually happen.

Each iteration:
1. Rotate a fresh IP via `iproyal.js` (which consumes from `../Good IP Finder/output/` first, falls back to direct IPRoyal).
2. Build a fresh Dolphin profile from the cloud-provided fingerprint baseline.
3. Grade it against all 5 judges via `bench.js`.
4. If the legacy 0-100 score (fp.com-derived) clears `PRODUCE_PUBLISH_THRESHOLD` (default 80) → save the recipe to `output/<id>__score<N>.json` + append a row to `output/index.jsonl`. Downstream subprojects (Hotmail, Twilio) tail that file. The `pass_all` (all 5 judges clean) flag is recorded in the artifact so downstream can prefer fully-clean profiles, but it is not the publish gate — the non-fp judges (CreepJS, Pixelscan, sannysoft, browserleaks) often fail for proxy-network reasons (`ERR_CONNECTION_CLOSED`) that don't reflect profile quality, and gating on `pass_all` dries up the pool.
5. Always delete the live Dolphin profile after grading (free tier caps at 20). Before delete, the never-delete-good-profile guard checks `../Hotmail Multi Creator/output/index.jsonl` and `../Twilio Multi Account Creator/output/index.jsonl` — if the ID is there, we skip the delete.
6. Append the per-attempt record to `experiments/<run-id>/log.jsonl` for later analysis. A meaningful event (`profile_published` / `iter_rejected` / `iter_error`) is also appended to the parent `events.jsonl` so the coordinator session can monitor pool growth without digging into the run dir.

The loop runs indefinitely (no cap, no "stop at 5"). It writes a `summary.md` to the same experiment dir every N attempts (and on every publish) so a human reading the file can see live progress: total attempts, total publishes, fully-clean rate, per-judge failure rates.

Trigger on the AWS Windows VM via `run-producer-as-scheduled-task.ps1` (NOT `run-as-scheduled-task.ps1`, which launches the legacy `tune.js` hill climber). It registers a Windows Scheduled Task so the producer survives SSH disconnect.

Env knobs (all optional):
- `PRODUCE_MAX_ATTEMPTS` — soft cap on iterations (default: unset, runs forever).
- `PRODUCE_SUMMARY_EVERY` — write a summary.md every N attempts (default 25).
- `PRODUCE_PUBLISH_THRESHOLD` — minimum legacy 0-100 score for publication (default 80).
- `PRODUCE_ERROR_BACKOFF_MS` — sleep between iterations when the previous one errored (default 5000).
- `BENCH_ALLOWED_LOCAL_IPS` / `BENCH_SKIP_LOCAL_IP_CHECK` — propagated to bench's browserleaks judge for the EC2 VPC WebRTC escape hatch.
