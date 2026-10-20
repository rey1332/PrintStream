#!/usr/bin/env node
// Starts the app or the Terminal worker with the settings of an etna.env file,
// read exactly as the server manager reads them (scripts/server/lib/envfile.mjs: values
// are never quoted, expanded or escaped). Used on Linux by the systemd units
// (deploy/linux) and the container (Dockerfile):
//
//   node scripts/server/env-run.mjs <env file> app      next start on ETNA_HOST:ETNA_PORT
//   node scripts/server/env-run.mjs <env file> worker   scripts/server/worker.mjs
//
// The settings file wins over the environment, except ETNA_HOST and ETNA_PORT
// (where to listen: 127.0.0.1:4028 unless the environment says otherwise).
// Stops the child on SIGTERM/SIGINT and exits with its exit code.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './lib/envfile.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const [envFile, what] = process.argv.slice(2);
if (!envFile || !['app', 'worker'].includes(what)) {
  console.error('Usage: env-run.mjs <env file> app|worker');
  process.exit(2);
}
if (!fs.existsSync(envFile)) {
  console.error(`[etna] ${envFile} does not exist (run the installer first).`);
  process.exit(2);
}

const settings = readEnvFile(envFile);
const env = { ...process.env, ...settings, NODE_ENV: 'production' };
for (const key of ['ETNA_HOST', 'ETNA_PORT']) if (process.env[key]) env[key] = process.env[key];

const args =
  what === 'app'
    ? [
        path.join(app, 'node_modules', 'next', 'dist', 'bin', 'next'),
        'start',
        '-H',
        env.ETNA_HOST || '127.0.0.1',
        '-p',
        env.ETNA_PORT || '4028',
      ]
    : [path.join(app, 'scripts', 'server', 'worker.mjs')];

if (what === 'worker' && !env.WORKER_DATABASE_URL) {
  console.error('[etna] WORKER_DATABASE_URL is not set: the Terminal worker is not started.');
  // Not a failure to restart over: the worker is optional.
  process.exit(0);
}

const child = spawn(process.execPath, args, { cwd: app, env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
