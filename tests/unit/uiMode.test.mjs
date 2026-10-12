// Interface version choice (src/lib/ui/mode.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UI,
  LAST_UI_KEY,
  UI_BOOT_SCRIPT,
  effectiveUi,
  readUiPreference,
  rememberLastUi,
  uiStorageKey,
  writeUiPreference,
} from '../../src/lib/ui/mode.ts';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

const blockedStorage = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};

test('the refined interface is the default', () => {
  assert.equal(DEFAULT_UI, 'refined');
});

test('legacy is shown only on desktop and only when chosen', () => {
  assert.equal(effectiveUi('legacy', true), 'legacy');
  assert.equal(effectiveUi('legacy', false), 'refined');
  assert.equal(effectiveUi('refined', true), 'refined');
  assert.equal(effectiveUi('refined', false), 'refined');
});

test('choices are stored per user and remembered as the last choice', () => {
  const storage = memoryStorage();
  assert.equal(readUiPreference('user-a', storage), null);
  assert.equal(writeUiPreference('user-a', 'legacy', storage), true);
  assert.equal(readUiPreference('user-a', storage), 'legacy');
  assert.equal(readUiPreference('user-b', storage), null, 'another user keeps the default');
  assert.equal(storage.map.get(uiStorageKey('user-a')), 'legacy');
  assert.equal(readUiPreference(null, storage), 'legacy', 'last choice before sign-in');
  rememberLastUi('refined', storage);
  assert.equal(readUiPreference(null, storage), 'refined');
  assert.equal(readUiPreference('user-a', storage), 'legacy', 'the hint does not change a saved choice');
});

test('unknown stored values and blocked storage fall back safely', () => {
  const storage = memoryStorage();
  storage.setItem(uiStorageKey('user-a'), 'fancy');
  storage.setItem(LAST_UI_KEY, '<script>');
  assert.equal(readUiPreference('user-a', storage), null);
  assert.equal(readUiPreference(null, storage), null);
  assert.equal(readUiPreference('user-a', blockedStorage), null);
  assert.equal(writeUiPreference('user-a', 'legacy', blockedStorage), false);
  assert.doesNotThrow(() => rememberLastUi('legacy', blockedStorage));
  assert.equal(writeUiPreference('user-a', 'legacy', null), false);
});

test('boot script picks legacy only on desktop and hides the page until the switch', () => {
  const run = ({ saved, desktop }) => {
    const attrs = new Map();
    const html = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
    const fn = new Function('document', 'window', 'localStorage', 'setTimeout', UI_BOOT_SCRIPT);
    fn({ documentElement: html }, { matchMedia: () => ({ matches: desktop }) }, { getItem: () => saved }, () => {});
    return attrs;
  };
  assert.equal(run({ saved: 'legacy', desktop: true }).get('data-ui'), 'legacy');
  assert.equal(run({ saved: 'legacy', desktop: true }).has('data-ui-pending'), true);
  assert.equal(run({ saved: 'legacy', desktop: false }).get('data-ui'), 'refined');
  assert.equal(run({ saved: null, desktop: true }).get('data-ui'), 'refined');
  assert.equal(run({ saved: null, desktop: true }).has('data-ui-pending'), false);
});
