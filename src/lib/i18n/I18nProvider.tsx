'use client';

import React, {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  use,
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isLocale,
  readStoredLocale,
  writeStoredLocale,
  type Locale,
} from './config';
import { setCurrentLocale, translate, type TranslateVars } from './translate';
import { localeReady } from '#i18n-source';
import type { MessageKey } from './messages';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatMoneyCompact,
  formatMonth,
  formatNumber,
  formatTime,
  isCurrencyCode,
} from './format';

// useLayoutEffect warns during server rendering; the locale is client-only.
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => boolean;
  currency: string | null;
  setCurrency: (currency: string | null) => void;
  t: (key: MessageKey, vars?: TranslateVars) => string;
  fmt: {
    number: (value: number, options?: Intl.NumberFormatOptions) => string;
    money: (value: number, options?: Intl.NumberFormatOptions) => string;
    moneyIn: (value: number, currency: string | null | undefined) => string;
    moneyCompact: (value: number) => string;
    date: (
      value: string | number | Date | null | undefined,
      options?: Intl.DateTimeFormatOptions
    ) => string;
    dateTime: (value: string | number | Date | null | undefined) => string;
    time: (value: string | number | Date | null | undefined) => string;
    month: (value: string | number | Date, withYear?: boolean) => string;
  };
}

const I18nContext = createContext<I18nValue | null>(null);

const CURRENCY_STORAGE_KEY = 'etna.currency';

function buildValue(
  locale: Locale,
  setLocale: (locale: Locale) => boolean,
  currency: string | null,
  setCurrency: (c: string | null) => void
): I18nValue {
  return {
    locale,
    setLocale,
    currency,
    setCurrency,
    t: (key, vars) => translate(locale, key, vars),
    fmt: {
      number: (value, options) => formatNumber(locale, value, options),
      money: (value, options) => formatMoney(locale, value, options, currency),
      moneyIn: (value, docCurrency) =>
        formatMoney(locale, value, undefined, docCurrency || currency),
      moneyCompact: (value) => formatMoneyCompact(locale, value, currency),
      date: (value, options) => formatDate(locale, value, options),
      dateTime: (value) => formatDateTime(locale, value),
      time: (value) => formatTime(locale, value),
      month: (value, withYear) => formatMonth(locale, value, withYear),
    },
  };
}

/**
 * Renders the page once its language's words are loaded (source.client.ts).
 * While the first page hydrates, React keeps the server's HTML on screen
 * until then; on the server the words are always there.
 */
function WhenLoaded({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const pending = localeReady(locale);
  if (pending) use(pending);
  return <>{children}</>;
}

export function I18nProvider({
  initialLocale = DEFAULT_LOCALE,
  children,
}: {
  /** The language the server renders in (the request's cookie). */
  initialLocale?: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  // tr() outside components follows the page (in the browser only: on the
  // server one module serves every request).
  if (typeof window !== 'undefined') setCurrentLocale(locale);
  const [currency, setCurrencyState] = useState<string | null>(null);

  useIsomorphicLayoutEffect(() => {
    try {
      const saved = window.localStorage.getItem(CURRENCY_STORAGE_KEY);
      if (isCurrencyCode(saved)) setCurrencyState(saved);
    } catch {
      // Storage unavailable: keep the default notation.
    }
  }, []);

  const setCurrency = useCallback((next: string | null) => {
    const value = isCurrencyCode(next) ? next : null;
    setCurrencyState(value);
    try {
      if (value) window.localStorage.setItem(CURRENCY_STORAGE_KEY, value);
      else window.localStorage.removeItem(CURRENCY_STORAGE_KEY);
    } catch {
      // Storage unavailable: the value still applies for this page view.
    }
  }, []);

  // A language is shown once its words are loaded: switching never blanks the page.
  const showLocale = useCallback((next: Locale) => {
    const pending = localeReady(next);
    if (!pending) return setLocaleState(next);
    pending.then(
      () => setLocaleState(next),
      () => document.documentElement.removeAttribute('data-locale-pending')
    );
  }, []);

  // The language saved in this browser, when the server rendered another one.
  useIsomorphicLayoutEffect(() => {
    const stored = readStoredLocale();
    if (stored !== initialLocale) showLocale(stored);
  }, [initialLocale, showLocale]);

  // Runs after the render in the saved locale is committed: reveal the page.
  useIsomorphicLayoutEffect(() => {
    setCurrentLocale(locale);
    document.documentElement.lang = locale;
    document.documentElement.removeAttribute('data-locale-pending');
  }, [locale]);

  // Keep other open tabs of this browser in sync.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY && isLocale(event.newValue)) showLocale(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [showLocale]);

  const setLocale = useCallback(
    (next: Locale) => {
      const stored = writeStoredLocale(next);
      showLocale(next);
      return stored;
    },
    [showLocale]
  );

  const value = useMemo(
    () => buildValue(locale, setLocale, currency, setCurrency),
    [locale, setLocale, currency, setCurrency]
  );
  return (
    <I18nContext.Provider value={value}>
      <Suspense fallback={null}>
        <WhenLoaded locale={locale}>{children}</WhenLoaded>
      </Suspense>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  // Outside the provider (should not happen) fall back to the default locale.
  return (
    context ??
    buildValue(
      DEFAULT_LOCALE,
      () => false,
      null,
      () => undefined
    )
  );
}
