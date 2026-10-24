// Where translate() finds its words in the browser: the table of one
// language (src/lib/i18n/tables, made by scripts/i18n/tables.mjs), loaded
// when it is needed, instead of every message in three languages on every
// page. The server and tests use source.server.ts (package.json "imports").

import { isLocale, type Locale } from './config';
import type { Entry } from './messages';
import type * as Server from './source.server';

type Table = Record<string, string>;

const tables: Partial<Record<Locale, Table>> = {};
const loading: Partial<Record<Locale, Promise<void>>> = {};
// Messages added later (the admin panel's), in every language.
const extra: Record<string, Entry> = {};

export function column(locale: Locale): 'en' | 'id' | 'zh' {
  return locale === 'zh-CN' ? 'zh' : locale;
}

function load(locale: Locale): Promise<void> {
  const file =
    locale === 'id'
      ? import('./tables/id.json')
      : locale === 'zh-CN'
        ? import('./tables/zh-CN.json')
        : import('./tables/en.json');
  return file.then((m) => {
    tables[locale] = (m.default ?? m) as Table;
  });
}

/** A promise while a language's words are still loading, else null. */
export function localeReady(locale: Locale): Promise<void> | null {
  if (tables[locale]) return null;
  loading[locale] ??= load(locale).catch((error) => {
    delete loading[locale];
    throw error;
  });
  return loading[locale]!;
}

export function textFor(locale: Locale, key: string): string | undefined {
  const added = extra[key];
  if (added) return added[column(locale)] || added.en;
  return tables[locale]?.[key];
}

export function hasText(key: string): boolean {
  if (key in extra) return true;
  // Every table has every key (a missing translation is the English text).
  const any = Object.values(tables)[0];
  return any ? Object.prototype.hasOwnProperty.call(any, key) : false;
}

export function addEntries(entries: Record<string, Entry>): void {
  Object.assign(extra, entries);
}

// The page's language is known before React starts (the server wrote it on
// <html lang>): start loading its words at once, beside the page's scripts.
if (typeof document !== 'undefined') {
  const lang = document.documentElement.lang;
  void localeReady(isLocale(lang) ? lang : 'en')?.catch(() => {});
}

// Both sources offer the same functions.
const _same: typeof Server = { column, textFor, hasText, addEntries, localeReady };
void _same;
