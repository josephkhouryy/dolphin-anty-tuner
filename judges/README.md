# judges/

One file per third-party fingerprint/bot-detection site we score against.

Each file exports `judge({ ctx, screenshotsDir, timestamp, label, fs, path, expectedProxyIp, declaredOs })` and returns:

```
{
  id:          string         // judge id ('fp_playground', 'creepjs', ...)
  url:         string         // primary URL hit
  pass:        boolean        // did this judge clear?
  reasons:     string[]       // when pass=false: human-readable failure reasons
  raw:         object         // judge-specific extracted data
  screenshot?: string         // full-page screenshot path
  error?:      string         // exception message if the visit blew up
}
```

`bench.js` calls each judge in sequence inside the same Playwright `ctx`
(connected to the live Dolphin profile via CDP). `pass_all` in the final
record is the AND of every judge's `pass`.

Adding a new judge:
1. Drop `judges/<name>.js` with the contract above.
2. Add `{ id, mod }` to `JUDGES` in `bench.js`.
3. Document the pass criteria at the top of the new file.
