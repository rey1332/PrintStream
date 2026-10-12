'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
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

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
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

  useIsomorphicLayoutEffect(() => {
    const stored = readStoredLocale();
    setCurrentLocale(stored);
    if (stored !== DEFAULT_LOCALE) setLocaleState(stored);
  }, []);

  // Runs after the render in the saved locale is committed: reveal the page.
  useIsomorphicLayoutEffect(() => {
    setCurrentLocale(locale);
    document.documentElement.lang = locale;
    document.documentElement.removeAttribute('data-locale-pending');
  }, [locale]);

  // Keep other open tabs of this browser in sync.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY && isLocale(event.newValue))
        setLocaleState(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    const stored = writeStoredLocale(next);
    setCurrentLocale(next);
    setLocaleState(next);
    return stored;
  }, []);

  const value = useMemo(
    () => buildValue(locale, setLocale, currency, setCurrency),
    [locale, setLocale, currency, setCurrency]
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
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
