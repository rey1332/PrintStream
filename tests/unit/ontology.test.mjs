import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeLike, idPrefixRange, parseQuery } from '../../src/lib/ontology/query.ts';
import { ONTOLOGY, ONTOLOGY_TYPES, ROLE_SEARCH_PRESETS, recordHref, recordReference } from '../../src/lib/ontology/registry.ts';
import { WORKSPACE_ROLES } from '../../src/app/erp/lib/erpRules.ts';

test('words become escaped LIKE patterns; every word must match', () => {
  assert.deepEqual(parseQuery('  acme   baja ').patterns, ['%acme%', '%baja%']);
  assert.equal(escapeLike('50%_off\\'), '50\\%\\_off\\\\');
  assert.deepEqual(parseQuery('100% sure').patterns, ['%100\\%%', '%sure%']);
  assert.equal(parseQuery('a b c d e f g').patterns.length, 5, 'at most five words');
});

test('references become id ranges; entry numbers become numbers', () => {
  assert.deepEqual(idPrefixRange('9ff35caf'), {
    from: '9ff35caf-0000-0000-0000-000000000000', to: '9ff35caf-ffff-ffff-ffff-ffffffffffff',
  });
  assert.deepEqual(parseQuery('PO-9FF35CAF').idRange, idPrefixRange('9ff35caf'));
  assert.deepEqual(parseQuery('9ff35caf-ab4a').idRange, idPrefixRange('9ff35cafab4a'));
  assert.equal(parseQuery('acme').idRange, null);
  assert.equal(parseQuery('JE-42').number, 42);
  assert.equal(parseQuery('#7').number, 7);
  assert.equal(parseQuery('acme').number, null);
  assert.equal(idPrefixRange('xyz1'), null);
});

test('references and links use the record, never guess', () => {
  const id = '9ff35caf-ab4a-4514-b5b8-0856e786cd05';
  assert.equal(recordReference('purchaseOrder', id), 'PO-9FF35CAF');
  assert.equal(recordReference('journalEntry', id, { entryNo: 42 }), 'JE-42');
  assert.equal(recordReference('glAccount', id, { code: '1100' }), '1100');
  assert.equal(recordHref('purchaseOrder', id), `/erp/purchase-orders?focus=${id}`);
  assert.equal(recordHref('goodsReceipt', 'r1', { orderRef: id }), `/erp/purchase-orders?focus=${id}`);
  assert.equal(recordHref('journalEntry', id, { entryDate: '2026-03-02' }), `/erp/accounting?entry=${id}&date=2026-03-02`);
  assert.equal(recordHref('glAccount', id), `/erp/accounting?account=${id}`);
});

test('every relationship points at a known type and every role has a preset', () => {
  for (const type of ONTOLOGY_TYPES) {
    for (const rel of ONTOLOGY[type].relations) assert.ok(ONTOLOGY_TYPES.includes(rel.target), `${type}.${rel.key}`);
  }
  for (const role of WORKSPACE_ROLES) {
    assert.ok(ROLE_SEARCH_PRESETS[role].length > 0, role);
    assert.ok(ROLE_SEARCH_PRESETS[role].every((t) => ONTOLOGY_TYPES.includes(t)), role);
  }
});
