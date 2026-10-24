import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminBase, routeAdmin } from '../../src/lib/adminPath.ts';

const SECRET = '/ops-7f3k9q2m';

test('without ETNA_ADMIN_PATH the panel stays at /admin', () => {
  assert.equal(adminBase(undefined), '/admin');
  assert.equal(adminBase('  '), '/admin');
  assert.equal(routeAdmin('/admin', '/admin'), null);
  assert.equal(routeAdmin('/admin/users', '/admin'), null);
});

test('an address is 8–64 lower-case letters, digits and dashes, not a route of the app', () => {
  assert.equal(adminBase('ops-7f3k9q2m'), SECRET);
  assert.equal(adminBase('/ops-7f3k9q2m/'), SECRET);
  for (const bad of ['short', 'OPS-7F3K9Q2M', 'ops_7f3k9q2m', 'ops/7f3k9q2m', 'reset-password', '-ops7f3k9q2m', 'x'.repeat(65)])
    assert.equal(adminBase(bad), null, bad);
});

test('with an address, /admin is hidden in every spelling and the address shows the panel', () => {
  for (const p of ['/admin', '/admin/', '/admin/users', '//admin/users', '/%61dmin', '/%61dmin/workspaces', '/ADMIN/users'])
    assert.deepEqual(routeAdmin(p, SECRET), { action: 'hide' }, p);
  assert.deepEqual(routeAdmin(SECRET, SECRET), { action: 'rewrite', to: '/admin' });
  assert.deepEqual(routeAdmin(`${SECRET}/users/42`, SECRET), { action: 'rewrite', to: '/admin/users/42' });
  // Other pages, and paths that only start alike, are left alone.
  for (const p of ['/erp', '/administrator', `${SECRET}x`, '/api/admin/platform/workspaces'])
    assert.equal(routeAdmin(p, SECRET), null, p);
});

test('an invalid address closes the panel: /admin is hidden and nothing shows it', () => {
  assert.deepEqual(routeAdmin('/admin/users', null), { action: 'hide' });
  assert.equal(routeAdmin('/short', null), null);
});
