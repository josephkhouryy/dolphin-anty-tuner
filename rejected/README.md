# rejected/

Two kinds of records live here:

### 1. Upstream artifacts the tuner consumed and threw out

Good IPs from `../Good IP Finder/output/` that didn't survive validation. One file per upstream artifact, shape:

```json
{
  "upstream_file": "good-ip-finder/output/abc.json",
  "ip": "1.2.3.4",
  "rejected_at": "2026-05-22T15:58:00Z",
  "reason": "score=72 below threshold of 90",
  "details": { ... }
}
```

Producers (Good IP Finder) read this periodically to learn which of their IPs failed downstream and adjust their picker. Currently empty for this kind because the chain isn't wired yet -- the tuner still calls IPRoyal directly via `iproyal.js`.

### 2. Our own past outputs retired under a tighter gate

When the publication bar tightens (e.g. when we add new judges), profiles that previously passed the old bar but weren't re-validated against the new one are moved out of `output/` and into here. The original JSON record stays untouched; a sidecar `<file>_retirement.json` next to it explains:

- which file was retired
- old gate vs new gate
- when, and by which session

Downstream consumers reading our `output/` will never see these files; they're kept for forensics and for use as a "best-effort fallback" if a consumer ever wants to handle the no-fresh-profiles case explicitly.
