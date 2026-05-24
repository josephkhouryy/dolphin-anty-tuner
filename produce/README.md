# produce/

Continuous producer. The piece that makes "unlimited good profiles" actually happen.

Each iteration:
1. Rotate a fresh IP via `iproyal.js` (which consumes from `../Good IP Finder/output/` first, falls back to direct IPRoyal).
2. Build a fresh Dolphin profile from the cloud-provided fingerprint baseline.
3. Grade it against all 5 judges via `bench.js`.
4. If `pass_all` → save the recipe to `output/<id>__score<N>.json` + append a row to `output/index.jsonl`. Downstream subprojects (Hotmail, Twilio) tail that file.
5. Always delete the live Dolphin profile after grading (free tier caps at 20). Before delete, the never-delete-good-profile guard checks `../Hotmail Multi Creator/output/index.jsonl` and `../Twilio Multi Account Creator/output/index.jsonl` — if the ID is there, we skip the delete.
6. Append the per-attempt record to `experiments/<run-id>/log.jsonl` for later analysis.

The loop runs indefinitely (no cap, no "stop at 5"). It writes a `summary.md` to the same experiment dir every N attempts so a human reading the file can see live progress: total attempts, total hits, per-judge failure rates.

Trigger on the AWS Windows VM via `run-as-scheduled-task.ps1`, which launches it inside a Windows Scheduled Task so it survives SSH disconnect.

Env knobs (all optional):
- `PRODUCE_MAX_ATTEMPTS` — soft cap on iterations (default: unset, runs forever).
- `PRODUCE_SUMMARY_EVERY` — write a summary.md every N attempts (default 25).
- `BENCH_ALLOWED_LOCAL_IPS` / `BENCH_SKIP_LOCAL_IP_CHECK` — propagated to bench's browserleaks judge for the EC2 VPC WebRTC escape hatch.
