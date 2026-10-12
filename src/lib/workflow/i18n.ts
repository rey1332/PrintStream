import { NODE_REGISTRY } from './registry';
import { hasMessage } from '@/lib/i18n/labels';
import type { MessageKey } from '@/lib/i18n/messages';
import type { TranslateVars } from '@/lib/i18n/translate';

type T = (key: MessageKey, vars?: TranslateVars) => string;

function lookup(key: string, t: T, fallback: string): string {
  return hasMessage(key) ? t(key) : fallback;
}

export function nodeTypeLabel(type: string, t: T): string {
  return lookup(`wf.node.${type}`, t, NODE_REGISTRY[type]?.label ?? type);
}

export function nodeTypeDescription(type: string, t: T): string {
  return lookup(`wf.desc.${type}`, t, NODE_REGISTRY[type]?.description ?? '');
}

export function nodeDisplayLabel(data: { type?: unknown; label?: unknown }, t: T): string {
  const type = String(data.type ?? '');
  const label = String(data.label ?? '');
  const def = NODE_REGISTRY[type];
  return def && label === def.label ? nodeTypeLabel(type, t) : label;
}

export function categoryLabel(id: string, t: T, fallback: string): string {
  return lookup(`wf.cat.${id}`, t, fallback);
}

export function pickerPlaceholder(type: string, t: T): string {
  return lookup(
    `wf.picker.${type}`,
    t,
    NODE_REGISTRY[type]?.picker?.placeholder ?? t('wf.allRecords')
  );
}

export function fieldLabel(key: string, t: T): string {
  return lookup(`wf.field.${key}`, t, key.replace(/([A-Z])/g, ' $1').trim());
}

export function optionLabel(value: string, t: T): string {
  return lookup(`wf.opt.${value}`, t, value);
}
