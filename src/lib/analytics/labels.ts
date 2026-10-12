// Display names and explanations for catalog entities and fields.

import { hasMessage } from '@/lib/i18n/labels';
import type { MessageKey } from '@/lib/i18n/messages';
import type { TranslateVars } from '@/lib/i18n/translate';
import { CATALOG, getField, type EntityKey, type FieldType } from './catalog';
import { QUERY_LIMITS, type QueryError } from './query';

type T = (key: MessageKey, vars?: TranslateVars) => string;

const humanize = (key: string) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const entityLabel = (entity: EntityKey, t: T) => t(`cat.entity.${entity}`);
export const entityDescription = (entity: EntityKey, t: T) => t(`cat.entity.${entity}.desc`);
export const moduleLabel = (entity: EntityKey, t: T) => t(`cat.module.${CATALOG[entity].module}`);
export const typeLabel = (type: FieldType, t: T) => t(`cat.type.${type}`);

export function fieldLabel(key: string, t: T): string {
  const k = `cat.f.${key}`;
  return hasMessage(k) ? t(k) : humanize(key);
}

export function fieldDescription(entity: EntityKey, key: string, t: T): string {
  for (const k of [`cat.fd.${entity}.${key}`, `cat.fd.${key}`]) if (hasMessage(k)) return t(k);
  return '';
}

export function relationLabel(key: string, t: T): string {
  const k = `cat.rel.${key}`;
  return hasMessage(k) ? t(k) : humanize(key);
}

export function columnLabel(name: string, t: T): string {
  const dot = name.indexOf('.');
  if (dot < 0) return fieldLabel(name, t);
  return `${relationLabel(name.slice(0, dot), t)} · ${fieldLabel(name.slice(dot + 1), t)}`;
}

export function queryErrorMessage(error: QueryError, t: T): string {
  return t(`cat.err.${error.code}`, {
    detail: error.detail ?? '',
    max: error.code === 'tooManyFields' ? QUERY_LIMITS.maxFields : QUERY_LIMITS.maxRows,
  });
}

export function fieldIsKnown(entity: EntityKey, key: string) {
  return Boolean(getField(entity, key));
}
