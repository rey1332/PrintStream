// Where translate() finds its words, on the server and in tests: every
// message in every language (src/lib/i18n/messages). The browser gets
// source.client.ts instead (package.json "imports", "#i18n-source"), which
// loads one language at a time. Both export the same functions.

import type { Locale } from './config';
import { messages, type Entry } from './messages';

const all = messages as Record<string, Entry | undefined>;

export function column(locale: Locale): 'en' | 'id' | 'zh' {
  return locale === 'zh-CN' ? 'zh' : locale;
}

/** The text of a message in a language (English when it has no translation). */
export function textFor(locale: Locale, key: string): string | undefined {
  const entry = all[key];
  return entry ? entry[column(locale)] || entry.en : undefined;
}

export function hasText(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(all, key);
}

/** Messages loaded later (the admin panel's). */
export function addEntries(entries: Record<string, Entry>): void {
  Object.assign(all, entries);
}

/** A promise while a language's words are still loading, else null (always null here). */
export function localeReady(_locale: Locale): Promise<void> | null {
  return null;
}
