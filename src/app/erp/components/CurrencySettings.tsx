'use client';

import React, { useEffect, useState } from 'react';
import { Coins, Loader2, Lock, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { translateServerMessage } from '@/lib/i18n/translate';
import {
  CurrencyApiError,
  currencyApi,
  type CurrencyPreview,
  type RateRow,
} from '@/lib/currency/client';
import { useCurrencySettings, useDisplayCurrencyPreference } from '../lib/useCurrency';
import { CurrencySelect } from './CurrencyFields';

const card = 'rounded-xl border border-border overflow-hidden bg-card';
const input =
  'rounded-md border border-border bg-background px-2 py-1.5 text-[0.8rem] text-foreground max-lg:min-h-11';
const button =
  'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[0.75rem] font-medium text-foreground hover:bg-[var(--surface-3)] disabled:opacity-50 max-lg:min-h-11';
const primary =
  'inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[0.75rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11';

function errorText(e: unknown, t: ReturnType<typeof useI18n>['t']): string {
  if (e instanceof CurrencyApiError) {
    if (e.message && e.message !== e.code) return translateServerMessage(e.message);
    const key = `cur.err.${e.code}`;
    return t(
      ([
        'forbidden',
        'invalid',
        'provider_disabled',
        'provider_unavailable',
        'provider_notFound',
        'provider_invalidResponse',
      ].includes(e.code)
        ? key
        : 'cur.err.failed') as MessageKey
    );
  }
  return t('cur.err.failed');
}

function BaseCurrencyCard() {
  const { t, fmt, setCurrency } = useI18n();
  const { settings, reload, workspaceId } = useCurrencySettings();
  const [preview, setPreview] = useState<CurrencyPreview | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!settings) return <Loader2 size={14} className="animate-spin text-muted-foreground" />;
  const target = choice ?? settings.baseCurrency;

  const loadPreview = async () => {
    setBusy(true);
    setError('');
    try {
      const p = await currencyApi.preview(workspaceId);
      setPreview(p);
      setChoice(p.baseCurrency);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const p = await currencyApi.confirm(workspaceId, target, preview.baseRows);
      setPreview(p);
      setAgreed(false);
      toast.success(t('cur.base.confirmedToast', { code: target }));
      setCurrency(target);
      reload();
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const status = settings.confirmedAt
    ? settings.locked
      ? t('cur.base.statusLocked')
      : t('cur.base.statusConfirmed')
    : t('cur.base.statusUnconfirmed');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[1.1rem] font-semibold text-foreground tabular-nums">
          {settings.baseCurrency}
        </span>
        <span className="text-[0.75rem] text-muted-foreground">
          {settings.currencies.find((c) => c.code === settings.baseCurrency)?.name}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.68rem] font-medium ${settings.confirmedAt ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'}`}
        >
          {settings.locked && <Lock size={10} />} {status}
        </span>
      </div>
      <p className="text-[0.75rem] text-muted-foreground">{t('cur.base.description')}</p>
      {!settings.canChangeBase && (
        <p className="text-[0.75rem] text-muted-foreground">{t('cur.base.ownerOnly')}</p>
      )}

      {settings.canChangeBase && !settings.confirmedAt && (
        <div className="space-y-3">
          {!preview && (
            <button type="button" className={button} onClick={loadPreview} disabled={busy}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : null} {t('cur.base.review')}
            </button>
          )}
          {preview && (
            <div className="space-y-3">
              <p className="text-[0.75rem] text-foreground">
                {preview.status === 'noRecords'
                  ? t('cur.base.noRecords')
                  : preview.status === 'unambiguous'
                    ? t('cur.base.unambiguous', { code: preview.baseCurrency })
                    : t('cur.base.needsDecision', { code: preview.baseCurrency })}
              </p>
              {preview.baseCurrencyIsDefault && preview.status !== 'noRecords' && (
                <p className="text-[0.72rem] text-amber-700 dark:text-amber-400">
                  {t('cur.base.isDefault', { code: preview.baseCurrency })}
                </p>
              )}
              {preview.tables.length > 0 && (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-[0.72rem]">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="px-2 py-1.5 font-medium">{t('cur.pv.table')}</th>
                        <th className="px-2 py-1.5 font-medium text-right">
                          {t('cur.pv.baseRows')}
                        </th>
                        <th className="px-2 py-1.5 font-medium text-right">
                          {t('cur.pv.uncertain')}
                        </th>
                        <th className="px-2 py-1.5 font-medium text-right">{t('cur.pv.sum')}</th>
                        <th className="px-2 py-1.5 font-medium">{t('cur.pv.dates')}</th>
                        <th className="px-2 py-1.5 font-medium text-right">
                          {t('cur.pv.foreign')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.tables.map((row) => (
                        <tr key={row.table} className="border-b border-border last:border-b-0">
                          <td className="px-2 py-1.5 text-foreground">
                            {t(`cur.pv.t.${row.table}` as MessageKey)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {fmt.number(row.baseRows)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {fmt.number(row.baseRows - row.baseRowsCertain)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {['journalEntries', 'products'].includes(row.table)
                              ? '—'
                              : fmt.number(Number(row.baseSum), { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-2 py-1.5 text-muted-foreground">
                            {row.firstDate
                              ? `${fmt.date(row.firstDate)} – ${fmt.date(row.lastDate)}`
                              : '—'}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {row.foreignRows
                              ? `${fmt.number(row.foreignRows)} (${row.foreignCurrencies.join(', ')})`
                              : '0'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[0.7rem] text-muted-foreground">
                {t('cur.base.nothingRewritten')}
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-[0.72rem] text-muted-foreground">
                  {preview.status === 'noRecords'
                    ? t('cur.base.choose')
                    : t('cur.base.amountsAreIn')}
                  <select
                    className={`${input} block mt-1`}
                    value={target}
                    onChange={(e) => {
                      setChoice(e.target.value);
                      setAgreed(false);
                    }}
                  >
                    {settings.currencies
                      .filter((c) => c.minorUnits <= 2)
                      .map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code} · {c.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              {target !== preview.baseCurrency && preview.foreignDocuments > 0 && (
                <p className="text-[0.72rem] text-red-600 dark:text-red-400">
                  {t('cur.base.foreignBlock', {
                    count: fmt.number(preview.foreignDocuments),
                    code: preview.baseCurrency,
                  })}
                </p>
              )}
              <label className="flex items-start gap-2 text-[0.75rem] text-foreground">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  {preview.status === 'noRecords'
                    ? t('cur.base.agreeEmpty', { code: target })
                    : t('cur.base.agree', { code: target, count: fmt.number(preview.baseRows) })}
                </span>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={primary}
                  disabled={!agreed || busy}
                  onClick={confirm}
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}{' '}
                  {t('cur.base.confirm', { code: target })}
                </button>
                <button type="button" className={button} onClick={loadPreview} disabled={busy}>
                  <RefreshCw size={12} /> {t('cur.base.refresh')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {settings.confirmedAt && (
        <p className="text-[0.72rem] text-muted-foreground">
          {t('cur.base.confirmedAt', { date: fmt.dateTime(settings.confirmedAt) })}
        </p>
      )}
      {error && (
        <p className="text-[0.75rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function DisplayCurrencyCard() {
  const { t } = useI18n();
  const { settings } = useCurrencySettings();
  const [display, setDisplay] = useDisplayCurrencyPreference();
  if (!settings) return null;
  return (
    <div className="space-y-2">
      <label htmlFor="display-currency" className="block text-[0.75rem] text-muted-foreground">
        {t('cur.display.description')}
      </label>
      <CurrencySelect
        id="display-currency"
        className={input}
        value={display && display !== settings.baseCurrency ? display : null}
        base={settings.baseCurrency}
        currencies={settings.currencies}
        onChange={(code) => setDisplay(code)}
      />
      <p className="text-[0.7rem] text-muted-foreground">{t('cur.display.note')}</p>
    </div>
  );
}

function RatesCard() {
  const { t, fmt } = useI18n();
  const { settings, workspaceId } = useCurrencySettings();
  const [rates, setRates] = useState<RateRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [manual, setManual] = useState({ from: '', rate: '', date: today, note: '' });
  const [fetchInput, setFetchInput] = useState({ base: '', quotes: '', date: today });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    currencyApi
      .rates(workspaceId)
      .then((r) => active && setRates(r))
      .catch((e) => active && setError(errorText(e, t)));
    return () => {
      active = false;
    };
  }, [workspaceId, version, t]);

  if (!settings) return null;
  const base = settings.baseCurrency;

  const addManual = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await currencyApi.addRate(workspaceId, {
        from: manual.from,
        to: base,
        rate: manual.rate.replace(',', '.'),
        date: manual.date,
        note: manual.note,
      });
      toast.success(t('cur.rates.added'));
      setManual({ ...manual, rate: '', note: '' });
      setVersion((v) => v + 1);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const fetchNow = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const quotes = fetchInput.quotes
        .split(/[\s,]+/)
        .map((q) => q.trim().toUpperCase())
        .filter(Boolean);
      const from = fetchInput.base || base;
      const result = await currencyApi.fetch(workspaceId, {
        base: from,
        quotes: quotes.length ? quotes : [base],
        date: fetchInput.date,
      });
      toast.success(
        t('cur.rates.fetched', {
          stored: fmt.number(result.stored),
          fetched: fmt.number(result.fetched),
        })
      );
      setVersion((v) => v + 1);
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[0.75rem] text-muted-foreground">
        {settings.provider.enabled
          ? t('cur.rates.provider', {
              name: settings.provider.name,
              providers: settings.provider.providers ?? t('cur.rates.blend'),
              days: fmt.number(settings.maxRateAgeDays),
            })
          : t('cur.rates.providerOff')}
      </p>

      {settings.canManageRates && (
        <form
          onSubmit={addManual}
          className="flex flex-wrap items-end gap-2"
          aria-label={t('cur.rates.addTitle')}
        >
          <label className="text-[0.72rem] text-muted-foreground">
            {t('cur.rates.currency')}
            <select
              className={`${input} block mt-1`}
              required
              value={manual.from}
              onChange={(e) => setManual({ ...manual, from: e.target.value })}
            >
              <option value="">—</option>
              {settings.currencies
                .filter((c) => c.code !== base)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
            </select>
          </label>
          <label className="text-[0.72rem] text-muted-foreground">
            {t('cur.rates.rateIn', { base })}
            <input
              className={`${input} block mt-1 w-40`}
              inputMode="decimal"
              required
              value={manual.rate}
              onChange={(e) => setManual({ ...manual, rate: e.target.value })}
              placeholder="16250.5"
            />
          </label>
          <label className="text-[0.72rem] text-muted-foreground">
            {t('cur.rates.date')}
            <input
              type="date"
              className={`${input} block mt-1`}
              required
              max={today}
              value={manual.date}
              onChange={(e) => setManual({ ...manual, date: e.target.value })}
            />
          </label>
          <label className="text-[0.72rem] text-muted-foreground">
            {t('cur.rates.note')}
            <input
              className={`${input} block mt-1 w-48`}
              maxLength={300}
              value={manual.note}
              onChange={(e) => setManual({ ...manual, note: e.target.value })}
              placeholder={t('cur.rates.notePlaceholder')}
            />
          </label>
          <button type="submit" className={primary} disabled={busy}>
            {t('cur.rates.add')}
          </button>
        </form>
      )}

      {settings.canFetchRates && settings.provider.enabled && (
        <form
          onSubmit={fetchNow}
          className="flex flex-wrap items-end gap-2"
          aria-label={t('cur.rates.fetchTitle')}
        >
          <label className="text-[0.72rem] text-muted-foreground">
            {t('cur.rates.fetchFrom')}
            <select
              className={`${input} block mt-1`}
              required
              value={fetchInput.base}
              onChange={(e) => setFetchInput({ ...fetchInput, base: e.target.value })}
            >
              <option value="">—</option>
              {settings.currencies
                .filter((c) => c.code !== base)
                .map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code}
                  </option>
                ))}
            </select>
          </label>
          <span className="pb-2 text-[0.75rem] text-muted-foreground">→ {base}</span>
          <label className="text-[0.72rem] text-muted-foreground">
            {t('cur.rates.date')}
            <input
              type="date"
              className={`${input} block mt-1`}
              required
              max={today}
              value={fetchInput.date}
              onChange={(e) => setFetchInput({ ...fetchInput, date: e.target.value })}
            />
          </label>
          <button type="submit" className={button} disabled={busy || !fetchInput.base}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}{' '}
            {t('cur.rates.fetch', { name: settings.provider.name })}
          </button>
        </form>
      )}

      {error && (
        <p className="text-[0.75rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {!rates && !error && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
      {rates && rates.length === 0 && (
        <p className="text-[0.75rem] text-muted-foreground">{t('cur.rates.none')}</p>
      )}
      {rates && rates.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-[0.72rem]">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">{t('cur.rates.pair')}</th>
                <th className="px-2 py-1.5 font-medium text-right">{t('cur.rates.rate')}</th>
                <th className="px-2 py-1.5 font-medium">{t('cur.rates.date')}</th>
                <th className="px-2 py-1.5 font-medium">{t('cur.rates.source')}</th>
                <th className="px-2 py-1.5 font-medium">{t('cur.rates.recorded')}</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-b-0">
                  <td className="px-2 py-1.5 text-foreground whitespace-nowrap">
                    1 {r.from} → {r.to}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {fmt.number(Number(r.rate), { maximumFractionDigits: 8 })}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{fmt.date(r.effectiveDate)}</td>
                  <td className="px-2 py-1.5">
                    {r.source === 'manual' ? t('cur.source.manual') : r.provider}
                    {r.note ? <span className="text-muted-foreground"> — {r.note}</span> : null}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">
                    {fmt.dateTime(r.source === 'manual' ? r.createdAt : r.retrievedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[0.7rem] text-muted-foreground">{t('cur.rates.history')}</p>
    </div>
  );
}

export function CurrencySettingsPanel() {
  const { t } = useI18n();
  const { error } = useCurrencySettings();
  return (
    <section id="currencies" className={card} aria-labelledby="currency-settings-title">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Coins size={14} className="text-muted-foreground" />
        <h2 id="currency-settings-title" className="text-[0.85rem] font-semibold text-foreground">
          {t('cur.title')}
        </h2>
      </div>
      {error ? (
        <p className="px-5 py-4 text-[0.75rem] text-muted-foreground">
          {t(error.code === 'forbidden' ? 'cur.err.forbidden' : 'cur.err.unavailable')}
        </p>
      ) : (
        <div className="divide-y divide-border">
          <div className="px-5 py-4 space-y-2">
            <h3 className="text-[0.78rem] font-semibold text-foreground">{t('cur.base.title')}</h3>
            <BaseCurrencyCard />
          </div>
          <div className="px-5 py-4 space-y-2">
            <h3 className="text-[0.78rem] font-semibold text-foreground">
              {t('cur.display.title')}
            </h3>
            <DisplayCurrencyCard />
          </div>
          <div className="px-5 py-4 space-y-2">
            <h3 className="text-[0.78rem] font-semibold text-foreground">{t('cur.rates.title')}</h3>
            <RatesCard />
          </div>
        </div>
      )}
    </section>
  );
}
