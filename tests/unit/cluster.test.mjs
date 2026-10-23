import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TUNNEL_DROP_IN,
  checkCidr,
  clusterNodes,
  databaseIsLocal,
  doctorFindings,
  fstabLine,
  nfsExportLine,
  parseSharedData,
  upsertFstab,
  versionMismatch,
} from '../../scripts/server/lib/psctl-core.mjs';

// Several app servers (psctl cluster, install.sh --shared-data; docs/teknis/CLUSTER.md).

test('the database must be on its own server before others can join', () => {
  assert.equal(databaseIsLocal('postgres://etna_app@localhost:5432/etna'), true);
  assert.equal(databaseIsLocal('postgres://etna_app@127.0.0.1/etna'), true);
  assert.equal(databaseIsLocal('postgres://etna_app@db/etna?host=/var/run/postgresql'), true);
  assert.equal(databaseIsLocal('postgres://etna_app@10.0.0.20:5432/etna?sslmode=verify-full'), false);
});

test('the data folder is shared with the app servers network only, root squashed', () => {
  assert.equal(checkCidr('10.0.0.0/24'), null);
  assert.match(checkCidr('0.0.0.0/0'), /too wide/);
  assert.match(checkCidr('10.0.0.300/24'), /IPv4 range/);
  assert.match(checkCidr('*'), /IPv4 range/);
  assert.equal(
    nfsExportLine('/var/lib/etna', ['10.0.0.0/24', '10.0.1.0/24']),
    '/var/lib/etna 10.0.0.0/24(rw,sync,no_subtree_check,root_squash) 10.0.1.0/24(rw,sync,no_subtree_check,root_squash)\n'
  );
  assert.throws(() => nfsExportLine('/var/lib/etna', '10.0.0.0/24 *(rw)'), /IPv4 range/);
});

test('an extra server mounts it from fstab, never with nofail', () => {
  assert.deepEqual(parseSharedData('10.0.0.10:/var/lib/etna'), { host: '10.0.0.10', dir: '/var/lib/etna' });
  assert.throws(() => parseSharedData('10.0.0.10'), /host:\/path/);
  assert.throws(() => parseSharedData('a:/x; rm -rf /'), /host:\/path/);
  const line = fstabLine('app1.lan:/var/lib/etna', '/var/lib/etna');
  assert.equal(line, 'app1.lan:/var/lib/etna /var/lib/etna nfs4 rw,hard,noatime,_netdev 0 0\n');
  assert.doesNotMatch(line, /nofail/);
  const before = 'UUID=1 / ext4 defaults 0 1\nold:/x /var/lib/etna nfs4 rw 0 0\n';
  assert.equal(upsertFstab(before, line, '/var/lib/etna'), `UUID=1 / ext4 defaults 0 1\n${line}`);
});

test('nodes come from the workers’ heartbeats; a different build is flagged', () => {
  const now = new Date('2026-10-23T10:00:00Z');
  const rows = [
    { worker_id: 'app1:100', seen_at: '2026-10-23T09:00:00Z', version: '1.0.0+aaa', running: 0 },
    { worker_id: 'app1:200', seen_at: '2026-10-23T09:59:50Z', version: '1.0.1+bbb', running: 2 },
    { worker_id: 'app2:300', seen_at: '2026-10-23T09:59:40Z', version: '1.0.1+bbb', running: 0 },
    { worker_id: 'app3:400', seen_at: '2026-10-23T09:30:00Z', version: '1.0.0+aaa', running: 0 },
  ];
  const nodes = clusterNodes(rows, now);
  assert.deepEqual(nodes.map((n) => [n.host, n.version, n.alive, n.running]), [
    ['app1', '1.0.1+bbb', true, 2],
    ['app2', '1.0.1+bbb', true, 0],
    ['app3', '1.0.0+aaa', false, 0],
  ]);
  // A stopped server with an old version is not a mismatch; two live ones are.
  assert.equal(versionMismatch(nodes), false);
  assert.equal(versionMismatch([...nodes, { host: 'app4', version: '1.0.0+aaa', alive: true }]), true);
});

test('doctor fails when the shared data folder is not mounted', () => {
  const findings = (mounted) =>
    doctorFindings({ sharedData: { spec: '10.0.0.10:/var/lib/etna', mounted }, backup: { configured: true, newestAgeHours: 1, copyDir: '/x' } });
  assert.ok(findings(false).some((f) => f.level === 'fail' && /not mounted/.test(f.text)));
  assert.ok(findings(true).some((f) => f.level === 'ok' && /shared from/.test(f.text)));
});

test('the tunnel stops with the app; the services wait for the data folder', () => {
  assert.match(TUNNEL_DROP_IN, /BindsTo=etna\.service/);
  for (const unit of ['etna.service', 'etna-worker.service'])
    assert.match(fs.readFileSync(new URL(`../../deploy/linux/${unit}`, import.meta.url), 'utf8'), /RequiresMountsFor=\/var\/lib\/etna/);
  const install = fs.readFileSync(new URL('../../deploy/linux/install.sh', import.meta.url), 'utf8');
  assert.match(install, /--shared-data\) SHARED_DATA=/);
  assert.match(install, /export ETNA_BUILD_ID/);
});
