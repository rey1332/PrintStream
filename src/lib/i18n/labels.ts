import { messages, type MessageKey } from './messages';
import type { TranslateVars } from './translate';

type T = (key: MessageKey, vars?: TranslateVars) => string;

export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(messages, key);
}

export function txCategoryLabel(category: string, t: T): string {
  const key = `txcat.${category}`;
  return hasMessage(key) ? t(key) : category;
}

const MOVEMENT_NOTES: { pattern: RegExp; key: MessageKey; names: string[] }[] = [
  { pattern: /^Opening stock \(product created\)$/, key: 'movement.opening', names: [] },
  { pattern: /^Manual stock edit on product record$/, key: 'movement.manualEdit', names: [] },
  {
    pattern: /^Auto: Sales Order delivered - SO#(.+)$/,
    key: 'movement.soDelivered',
    names: ['id'],
  },
  {
    pattern: /^Auto: Purchase Order received - PO#(.+)$/,
    key: 'movement.poReceived',
    names: ['id'],
  },
  { pattern: /^Delivery for SO#(.+)$/, key: 'movement.delivery', names: ['id'] },
  { pattern: /^Receipt for PO#(.+)$/, key: 'movement.receipt', names: ['id'] },
  { pattern: /^Reversal of receipt: (.*)$/, key: 'movement.reverseReceipt', names: ['reason'] },
  { pattern: /^Reversal of delivery: (.*)$/, key: 'movement.reverseDelivery', names: ['reason'] },
];

export function movementNoteLabel(note: string, t: T): string {
  for (const { pattern, key, names } of MOVEMENT_NOTES) {
    const match = note.match(pattern);
    if (match) {
      const vars: TranslateVars = {};
      names.forEach((name, i) => {
        vars[name] = match[i + 1];
      });
      return t(key, vars);
    }
  }
  return note;
}

export function statusLabel(status: string, t: T): string {
  const key = `status.${status}`;
  return hasMessage(key) ? t(key) : status;
}
