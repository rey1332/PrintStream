import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const deploy = path.join(root, 'deploy');
const node = (args, env = {}) =>
  spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30_000 });

function tempEnv(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etna-env-'));
  const file = path.join(dir, 'etna.env');
  fs.writeFileSync(file, text);
  return file;
}

test('env-run: usage, a missing settings file, and no worker without WORKER_DATABASE_URL', () => {
  assert.equal(node(['scripts/server/env-run.mjs']).status, 2);
  assert.equal(node(['scripts/server/env-run.mjs', tempEnv(''), 'shell']).status, 2);
  assert.equal(node(['scripts/server/env-run.mjs', path.join(os.tmpdir(), 'no-such-etna.env'), 'app']).status, 2);
  const worker = node(['scripts/server/env-run.mjs', tempEnv('# no worker\n'), 'worker'], { WORKER_DATABASE_URL: '' });
  assert.equal(worker.status, 0);
  assert.match(worker.stderr, /WORKER_DATABASE_URL is not set/);
});

test('setup-local: --env-file needs a path and never overwrites an existing file', () => {
  const env = { MIGRATION_DATABASE_URL: 'postgres://etna_owner@127.0.0.1:1/etna' };
  const missing = node(['scripts/setup-local.mjs', '--env-file'], env);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--env-file needs a path/);
  const existing = tempEnv('MFA_ENCRYPTION_KEY=keep\n');
  const kept = node(['scripts/setup-local.mjs', '--env-file', existing], env);
  assert.equal(kept.status, 2);
  assert.match(kept.stderr, /etna\.env already exists/);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'MFA_ENCRYPTION_KEY=keep\n');
});

const deployFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? deployFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('deploy files: LF line endings, and the files they name exist', () => {
  const files = [...deployFiles(deploy), path.join(root, 'Dockerfile')];
  for (const file of files) assert.ok(!fs.readFileSync(file, 'utf8').includes('\r'), `${path.relative(root, file)} has CRLF`);

  const units = ['etna.service', 'etna-worker.service', 'etna-db-backup.service', 'etna-db-backup.timer'];
  const install = fs.readFileSync(path.join(deploy, 'linux', 'install.sh'), 'utf8');
  for (const unit of units) {
    assert.ok(fs.existsSync(path.join(deploy, 'linux', unit)), unit);
    assert.ok(install.includes(unit), `install.sh installs ${unit}`);
  }
  for (const unit of ['etna.service', 'etna-worker.service']) {
    const text = fs.readFileSync(path.join(deploy, 'linux', unit), 'utf8');
    assert.match(text, /^ExecStart=.*scripts\/server\/env-run\.mjs \/etc\/etna\/etna\.env (app|worker)$/m);
    assert.match(text, /^User=etna$/m);
    assert.match(text, /^ProtectSystem=strict$/m);
    assert.match(text, /^ReadWritePaths=\/var\/lib\/etna$/m);
  }
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'server', 'env-run.mjs')));
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'setup-local.mjs')));

  const compose = fs.readFileSync(path.join(deploy, 'docker', 'compose.yml'), 'utf8');
  assert.match(compose, /deploy\/docker\/setup\.sh/);
  assert.match(compose, /env-run\.mjs", "\/config\/etna\.env", "worker"/);
  assert.match(compose, /"127\.0\.0\.1:\$\{ETNA_PORT:-4028\}:4028"/, 'the app port is published on localhost only');
  // Compose checks ${VAR:?} in every service, profile or not: optional services must not require settings.
  for (const block of compose.split(/\n(?=  [a-z][\w-]*:\n)/).filter((b) => /^\s+profiles:/m.test(b)))
    assert.ok(!block.includes(':?'), `an optional service requires a setting:\n${block}`);
  assert.ok(fs.existsSync(path.join(deploy, 'docker', 'setup.sh')));
  assert.ok(fs.existsSync(path.join(deploy, 'docker', 'initdb', '01-etna-owner.sh')));
});

const bash = spawnSync('bash', ['--version']).status === 0;

test('deploy shell scripts parse', { skip: !bash && 'bash is not installed' }, () => {
  for (const file of deployFiles(deploy).filter((f) => f.endsWith('.sh'))) {
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(root, file)}: ${r.stderr}`);
  }
});
