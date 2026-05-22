# rejected/

Upstream artifacts (good IPs from `../Good IP Finder/output/`) that the tuner consumed and threw out, plus the reason.

Each file is `<upstream-artifact-id>.json` with shape:

```json
{
  "upstream_file": "good-ip-finder/output/abc.json",
  "ip": "1.2.3.4",
  "rejected_at": "2026-05-22T15:58:00Z",
  "reason": "score=72 below threshold of 90",
  "details": { ... }   // optional: probe + signals
}
```

Producers (Good IP Finder) read this folder periodically to learn which of their IPs failed downstream and adjust their picker.

Currently empty because the chain isn't wired yet -- the tuner still calls IPRoyal directly via `iproyal.js`. Will populate as soon as the chain switchover lands.
