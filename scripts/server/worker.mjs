#!/usr/bin/env node
// The Terminal worker: runs PrintStream's background jobs (dataset tables,
// imports, pipeline runs, schedules, maintenance). See src/server/terminal/worker.ts.
//
//   node scripts/server/worker.mjs                 (settings from the environment)
//   node scripts/server/worker.mjs --root <root>   (settings from <root>\config\etna.env)
//
// Needs WORKER_DATABASE_URL (the role etna_worker; written by the server manager and
// scripts/setup-local.mjs). On a server, run.mjs starts it beside the app.
// Exit code 3: this Node.js cannot run TypeScript (22.6 or newer is needed).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (!process.features.typescript) {
  if (major > 22 || (major === 22 && minor >= 6)) {
    // Older 22.x: type stripping behind a flag.
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: process.env,
    });
    process.exit(r.status ?? 1);
  }
  console.error(`[worker] Node.js ${process.version} cannot run the Terminal worker; install Node.js 22.18 or newer.`);
  process.exit(3);
}

const at = process.argv.indexOf('--root');
if (at > 0) {
  const { readEnvFile } = await import('./lib/envfile.mjs');
  const { paths } = await import('./lib/layout.mjs');
  const root = process.argv[at + 1];
  if (!root || !fs.existsSync(root)) {
    console.error('Usage: worker.mjs [--root <ETNA_DATA_ROOT>]');
    process.exit(2);
  }
  Object.assign(process.env, readEnvFile(paths(root).envFile));
}

// Next.js loads .env.local for the app; the worker does the same when run by hand.
const local = new URL('../../.env.local', import.meta.url);
if (at < 0 && fs.existsSync(local)) {
  const { readEnvFile } = await import('./lib/envfile.mjs');
  for (const [k, v] of Object.entries(readEnvFile(fileURLToPath(local)))) if (process.env[k] === undefined) process.env[k] = v;
}

const url = process.env.WORKER_DATABASE_URL;
if (!url) {
  console.error('[worker] WORKER_DATABASE_URL is not set (in .env.local: run scripts/setup-local.mjs; on a server: the server manager → Update).');
  process.exit(2);
}

register('./lib/ts-loader.mjs', import.meta.url);
const { runWorker } = await import(pathToFileURL(fileURLToPath(new URL('../../src/server/terminal/worker.ts', import.meta.url))).href);
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const { startAlerts } = await import(pathToFileURL(fileURLToPath(new URL('../../src/server/alerts-start.ts', import.meta.url))).href);
// Error alerts by e-mail (src/server/alerts.ts); off without recipients or SMTP.
startAlerts('worker');

const stamp = () => `[${new Date().toISOString()}]`;
// The worker's own trouble (its job loop, the database listener) is an error;
// a job that fails on its data is not (the job shows why).
const INFRASTRUCTURE = /^(loop|listen):/;

const worker = await runWorker({
  databaseUrl: url,
  workerId: `${os.hostname()}:${process.pid}`.slice(0, 100),
  version: String(pkg.version ?? ''),
  concurrency: Number(process.env.ETNA_WORKER_CONCURRENCY) || 2,
  log: (line) => (INFRASTRUCTURE.test(line) ? console.error : console.log)(`${stamp()} [worker] ${line}`),
});
console.log(`${stamp()} [worker] started`);

// Watchdog: the app answers /api/health (the worker runs beside it, so it
// notices when the app or its database does not). Three failed checks in a
// row are an error line, which error alerts e-mail.
const healthUrl = process.env.ETNA_HEALTH_URL || `http://127.0.0.1:${process.env.ETNA_PORT || 4028}/api/health`;
let failedChecks = 0;
const checkHealth = async () => {
  let reason = null;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) reason = `status ${response.status}`;
  } catch (error) {
    reason = error?.cause?.code || error?.name || 'unreachable';
  }
  if (reason === null) {
    if (failedChecks >= 3) console.log(`${stamp()} [health] the app answers again`);
    failedChecks = 0;
    return;
  }
  failedChecks += 1;
  if (failedChecks === 3 || failedChecks % 30 === 0)
    console.error(`${stamp()} [health] the app does not answer`, reason, `(${failedChecks} checks)`);
};
const watchdog = setInterval(checkHealth, 60_000);
watchdog.unref();

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(watchdog);
  console.log(`${stamp()} [worker] stopping`);
  await worker.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
