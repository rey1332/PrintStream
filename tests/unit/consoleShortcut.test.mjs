// The in-app console's backtick shortcut (src/lib/console/shortcut.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConsoleShortcut, isTypingTarget, shouldToggleConsole } from '../../src/lib/console/shortcut.ts';

const key = (overrides = {}) => ({
  key: '`', code: 'Backquote', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  repeat: false, isComposing: false, keyCode: 192, ...overrides,
});
const el = (tagName, { editable = false, inConsole = false, editableAncestor = false } = {}) => ({
  tagName,
  isContentEditable: editable,
  closest: (selector) => {
    if (selector.includes('data-etna-console')) return inConsole ? {} : null;
    if (selector.includes('contenteditable')) return editableAncestor ? {} : null;
    return null;
  },
});

test('backtick on US and other layouts, physical Backquote key, AltGr', () => {
  assert.equal(isConsoleShortcut(key()), true);
  assert.equal(isConsoleShortcut(key({ code: 'Equal' })), true, '` produced by another key (e.g. some European layouts)');
  assert.equal(isConsoleShortcut(key({ key: '^' })), true, 'physical Backquote key typing another character');
  assert.equal(isConsoleShortcut(key({ key: 'Dead' })), true, 'dead key on the Backquote position');
  assert.equal(isConsoleShortcut(key({ key: '`', code: 'KeyE', ctrlKey: true, altKey: true, getModifierState: (k) => k === 'AltGraph' })), true);
});

test('not the shortcut: shifted (~), modifiers, repeat, IME composition, other keys', () => {
  assert.equal(isConsoleShortcut(key({ key: '~', shiftKey: true })), false);
  assert.equal(isConsoleShortcut(key({ ctrlKey: true })), false);
  assert.equal(isConsoleShortcut(key({ altKey: true })), false);
  assert.equal(isConsoleShortcut(key({ metaKey: true })), false);
  assert.equal(isConsoleShortcut(key({ repeat: true })), false);
  assert.equal(isConsoleShortcut(key({ isComposing: true })), false);
  assert.equal(isConsoleShortcut(key({ key: 'Process', keyCode: 229 })), false);
  assert.equal(isConsoleShortcut(key({ key: 'a', code: 'KeyA' })), false);
});

test('never while typing in a field; the console’s own input still closes it', () => {
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
    assert.equal(isTypingTarget(el(tag)), true, tag);
    assert.equal(shouldToggleConsole({ ...key(), target: el(tag) }), false, tag);
  }
  assert.equal(shouldToggleConsole({ ...key(), target: el('DIV', { editable: true }) }), false, 'contenteditable');
  assert.equal(shouldToggleConsole({ ...key(), target: el('SPAN', { editableAncestor: true }) }), false, 'inside contenteditable');
  assert.equal(shouldToggleConsole({ ...key(), target: el('BODY') }), true);
  assert.equal(shouldToggleConsole({ ...key(), target: el('BUTTON') }), true);
  assert.equal(shouldToggleConsole({ ...key(), target: null }), true);
  assert.equal(shouldToggleConsole({ ...key(), target: el('INPUT', { inConsole: true }) }), true, 'console input keeps its close behaviour');
});
