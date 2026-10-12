'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CurrencyApiError,
  DISPLAY_CURRENCY_EVENT,
  convertAmount,
  currencyApi,
  readDisplayCurrency,
  storeDisplayCurrency,
  type CurrencySettings,
  type RateLookup,
} from '@/lib/currency/client';
import { useWorkspace } from './WorkspaceContext';

export function useCurrencyWorkspace(): string | null {
  const { enabled, active } = useWorkspace();
  return enabled ? (active?.id ?? null) : null;
}

const settingsCache = new Map<string, Promise<CurrencySettings>>();

export function useCurrencySettings() {
  const ws = useCurrencyWorkspace();
  const key = ws ?? 'personal';
  const [settings, setSettings] = useState<CurrencySettings | null>(null);
  const [error, setError] = useState<CurrencyApiError | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    let pending = settingsCache.get(key);
    if (!pending || version > 0) {
      pending = currencyApi.settings(ws);
      settingsCache.set(key, pending);
      pending.catch(() => settingsCache.delete(key));
    }
    pending
      .then((s) => active && setSettings(s))
      .catch(
        (e) =>
          active && setError(e instanceof CurrencyApiError ? e : new CurrencyApiError('failed'))
      );
    return () => {
      active = false;
    };
  }, [key, ws, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { settings, error, reload, workspaceId: ws };
}

export type RateState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; lookup: RateLookup }
  | { status: 'missing'; lookup: RateLookup | null; reason: string | null }
  | { status: 'error'; message: string };

export function useRateLookup(from: string | null, to: string | null, date: string | null) {
  const ws = useCurrencyWorkspace();
  const [state, setState] = useState<RateState>({ status: 'idle' });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!from || !to || !date || from === to) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    currencyApi
      .lookup(ws, { from, to, date, fetch: true }, controller.signal)
      .then((lookup) => {
        if (lookup.rate && !lookup.stale) setState({ status: 'ok', lookup });
        else setState({ status: 'missing', lookup, reason: lookup.fetchError });
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', message: e instanceof CurrencyApiError ? e.code : 'failed' });
      });
    return () => controller.abort();
  }, [ws, from, to, date, version]);

  return { state, refresh: useCallback(() => setVersion((v) => v + 1), []) };
}

export function useDisplayCurrencyPreference(): [string | null, (code: string | null) => void] {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setCode(readDisplayCurrency());
    read();
    window.addEventListener(DISPLAY_CURRENCY_EVENT, read);
    window.addEventListener('storage', read);
    return () => {
      window.removeEventListener(DISPLAY_CURRENCY_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, []);
  return [code, storeDisplayCurrency];
}

export interface DisplayConversion {
  value: number | null;
  code: string;
  rate: string | null;
  rateDate: string | null;
  source: string | null;
  provider: string | null;
}

export function useDisplayConversion() {
  const { settings } = useCurrencySettings();
  const [display] = useDisplayCurrencyPreference();
  const base = settings?.baseCurrency ?? null;
  const active = Boolean(display && base && display !== base);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const { state } = useRateLookup(
    active ? base : null,
    active ? display : null,
    active ? today : null
  );
  const minor = settings?.currencies.find((c) => c.code === display)?.minorUnits ?? 2;

  const convert = useCallback(
    (amount: number): DisplayConversion | null => {
      if (!active || !display) return null;
      const lookup = state.status === 'ok' ? state.lookup : null;
      return {
        value: lookup?.rate ? convertAmount(amount, lookup.rate, minor) : null,
        code: display,
        rate: lookup?.rate ?? null,
        rateDate: lookup?.rateDate ?? null,
        source: lookup?.source ?? null,
        provider: lookup?.provider ?? null,
      };
    },
    [active, display, state, minor]
  );

  return { convert, display: active ? display : null, base, loading: state.status === 'loading' };
}
