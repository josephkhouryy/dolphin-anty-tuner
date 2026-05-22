/**
 * launch-detached.js — Spawn tune.js as a fully detached child process.
 *
 * Windows OpenSSH kills the entire process tree of an SSH session when the
 * session closes, even children launched via `Start-Process` or `cmd /c start`.
 * Node's `child_process.spawn` with `detached: true` + `child.unref()` puts the
 * child in its own process group, surviving SSH disconnect.
 *
 * Usage (from inside this folder, over SSH):
 *   node launch-detached.js [maxIters]
 *
 * The launcher exits immediately after spawn; tune.js keeps running and writes
 * its logs to tune.log / tune.err synchronously via fs.appendFileSync inside
 * tune.js. Read those files to see progress.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const maxIters = process.argv[2] || '30';
const cwd = __dirname;

// fresh log files each launch
const logPath = path.join(cwd, 'tune.log');
const errPath = path.join(cwd, 'tune.err');
try { fs.unlinkSync(logPath); } catch {}
try { fs.unlinkSync(errPath); } catch {}
const out = fs.openSync(logPath, 'a');
const err = fs.openSync(errPath, 'a');

const child = spawn(process.execPath, [path.join(cwd, 'tune.js')], {
  cwd,
  detached: true,
  stdio: ['ignore', out, err],
  env: { ...process.env, TUNER_MAX_ITERATIONS: maxIters },
  windowsHide: true,
});

child.unref();
fs.writeFileSync(path.join(cwd, 'tune.pid'), String(child.pid));
console.log(`launched PID ${child.pid}, maxIters=${maxIters}, log=${logPath}`);
process.exit(0);
