#!/usr/bin/env node
// Makes a deployment package on the development PC:
//
//   npm run package               build, then dist\ETNA-<version>-<stamp>\
//   npm run package -- --zip      the same, plus a .zip of it
//   npm run package -- --no-build package the existing .next build
//
// The package holds etna.bat and app\ (the built app, production
// node_modules, migrations, scripts, docs). Never .env.local, storage\,
// tests or the source of the pages. Copy the folder (or zip) to the server
// and double-click etna.bat; it installs Node.js and PostgreSQL when
// missing (from the internet, or from prereqs\ for an offline server).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listMigrations } from '../db/migrator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function sh(command, cwd) {
  console.log(`> ${command}`);
  const r = spawnSync(command, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`Failed: ${command}`);
    process.exit(1);
  }
}

if (!args.includes('--no-build')) sh('npm run build', root);
const buildIdFile = path.join(root, '.next', 'BUILD_ID');
if (!fs.existsSync(buildIdFile)) {
  console.error('No build found (.next\\BUILD_ID). Run without --no-build.');
  process.exit(1);
}

const builtAt = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${builtAt.getFullYear()}${pad(builtAt.getMonth() + 1)}${pad(builtAt.getDate())}-${pad(builtAt.getHours())}${pad(builtAt.getMinutes())}`;
const name = `ETNA-${pkg.version}-${stamp}`;
const out = path.join(root, 'dist', name);
const app = path.join(out, 'app');
if (fs.existsSync(out)) {
  console.error(`${out} already exists.`);
  process.exit(1);
}
fs.mkdirSync(app, { recursive: true });

const copy = (rel, filter) => {
  const src = path.join(root, rel);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(app, rel), { recursive: true, filter });
};
// The build without its cache and traces.
copy('.next', (src) => !/[\\/]\.next[\\/](cache|trace)([\\/]|$)/.test(src));
// src: the Terminal worker runs the server sources directly (scripts/server/worker.mjs).
for (const rel of ['public', 'db', 'scripts', 'src', 'docs', 'package.json', 'package-lock.json', 'next.config.mjs', 'image-hosts.config.mjs', '.env.example', 'LICENSE', 'README.md']) {
  copy(rel);
}
fs.copyFileSync(path.join(root, 'etna.bat'), path.join(out, 'etna.bat'));
// Optional offline installers for a server without internet (see prereqs\README.txt).
if (fs.existsSync(path.join(root, 'prereqs'))) fs.cpSync(path.join(root, 'prereqs'), path.join(out, 'prereqs'), { recursive: true });

// Production dependencies only, exactly as locked.
sh('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', app);

const manifest = {
  name: 'etna',
  version: pkg.version,
  buildId: fs.readFileSync(buildIdFile, 'utf8').trim(),
  builtAt: builtAt.toISOString(),
  node: process.version,
  migrations: listMigrations().length,
};
fs.writeFileSync(path.join(app, 'etna-package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

if (args.includes('--zip')) sh(`"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')}" -a -cf "${name}.zip" "${name}"`, path.join(root, 'dist'));

console.log(`\nPackage ready: ${out}`);
console.log('Copy it to the server and double-click etna.bat (it installs Node.js and PostgreSQL when missing).');
