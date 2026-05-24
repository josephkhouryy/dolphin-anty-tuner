# lib/

Small shared helpers used by the rest of the project.

- `never-delete-guard.js` — reads downstream subprojects' `output/index.jsonl` (Hotmail Multi Creator, Twilio Multi Account Creator) and tells the caller whether a given Dolphin profile ID is already in use. Used by `produce/produce.js` and (will be wired into) `tune.js`'s cleanup paths so a profile that helped produce a Hotmail or Twilio gold cannot be accidentally deleted.
