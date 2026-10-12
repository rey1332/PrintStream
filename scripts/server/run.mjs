#!/usr/bin/env node
// Runs ETNA on an installed server (started at boot by the scheduled task
// \ETNA\Server, as the account etna-svc):
//
//   node <root>\app\current\scripts\server\run.mjs --root <root>
//
// Loads the settings from <root>\config\etna.env (they stay out of the app
// folder, so an update can replace it), starts the app on 127.0.0.1:4028 only
// (Cloudflare Tunnel or a reverse proxy in front) and the TERMINAL worker
// (scripts/server/worker.mjs, when WORKER_DATABASE_URL is set), restarts each
// 10 seconds after it stops, and writes <root>\logs\server-YYYYMMDD.log
// (kept 30 days).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile } from './lib/envfile.mjs';
import { APP_PORT, paths } from './lib/layout.mjs';

const at = process.argv.indexOf('--root');
const root = at > 0 ? process.argv[at + 1] : null;
if (!root || !fs.existsSync(root)) {
  console.error('Usage: run.mjs --root <ETNA_DATA_ROOT>');
  process.exit(2);
}
const p = paths(root);
fs.mkdirSync(p.logs, { recursive: true });

const KEEP_DAYS = 30;
const pad = (n) => String(n).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};

let logDay = '';
let log = null;
function logStream() {
  if (logDay !== today()) {
    log?.end();
    logDay = today();
    log = fs.createWriteStream(path.join(p.logs, `server-${logDay}.log`), { flags: 'a' });
    prune();
  }
  return log;
}
function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of fs.readdirSync(p.logs)) {
    if (!/^server-\d{8}\.log$/.test(name)) continue;
    const file = path.join(p.logs, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file);
    } catch {
      // Still open or gone.
    }
  }
}
const note = (text) => logStream().write(`[${new Date().toISOString()}] ${text}\n`);

fs.writeFileSync(p.pidFile, String(process.pid));

const children = new Map();
let stopping = false;

function supervise(name, args, wanted) {
  const settings = readEnvFile(p.envFile);
  if (!wanted(settings)) {
    note(`${name}: not configured, not started`);
    return;
  }
  const app = p.current;
  note(`starting ${name} from ${fs.realpathSync(app)}`);
  const child = spawn(process.execPath, args(app), {
    cwd: app,
    env: { ...process.env, ...settings, NODE_ENV: 'production' },
    windowsHide: true,
  });
  children.set(name, child);
  child.stdout.on('data', (chunk) => logStream().write(chunk));
  child.stderr.on('data', (chunk) => logStream().write(chunk));
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    // Exit 3: this Node.js cannot run the worker; try again in an hour (after an update).
    const wait = code === 3 ? 3_600_000 : 10_000;
    note(`${name} stopped (exit ${code ?? signal}), starting again in ${wait / 1000} seconds`);
    setTimeout(() => supervise(name, args, wanted), wait);
  });
}

function start() {
  supervise(
    'ETNA',
    (app) => [path.join(app, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-H', '127.0.0.1', '-p', String(APP_PORT)],
    () => true
  );
  supervise('worker', (app) => [path.join(app, 'scripts', 'server', 'worker.mjs')], (settings) => !!settings.WORKER_DATABASE_URL);
}

function shutdown() {
  stopping = true;
  note('stopping');
  for (const child of children.values()) child.kill();
  fs.rmSync(p.pidFile, { force: true });
  // The worker finishes or hands back its jobs within 30 seconds.
  setTimeout(() => process.exit(0), children.size > 1 ? 35_000 : 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
