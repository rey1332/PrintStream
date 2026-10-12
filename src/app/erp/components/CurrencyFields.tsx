'use client';

import React, { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { CurrencyInfo } from '@/lib/currency/client';
import type { MessageKey } from '@/lib/i18n/messages';
import { useRateLookup, type DisplayConversion } from '../lib/useCurrency';

const COMMON = [
  'IDR',
  'USD',
  'EUR',
  'SGD',
  'MYR',
  'CNY',
  'JPY',
  'AUD',
  'GBP',
  'HKD',
  'THB',
  'PHP',
  'VND',
  'INR',
  'KRW',
];

export function CurrencySelect({
  id,
  value,
  base,
  currencies,
  onChange,
  className,
  style,
  disabled,
}: {
  id: string;
  value: string | null;
  base: string;
  currencies: CurrencyInfo[];
  onChange: (code: string | null) => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const common = COMMON.filter((c) => c !== base && currencies.some((x) => x.code === c));
  const others = currencies.filter((c) => c.code !== base && !common.includes(c.code));
  return (
    <select
      id={id}
      className={className}
      style={style}
      disabled={disabled}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{t('cur.baseOption', { code: base })}</option>
      <optgroup label={t('cur.common')}>
        {common.map((c) => (
          <option key={c} value={c}>
            {c} · {currencies.find((x) => x.code === c)?.name}
          </option>
        ))}
      </optgroup>
      <optgroup label={t('cur.all')}>
        {others.map((c) => (
          <option key={c.code} value={c.code}>
            {c.code} · {c.name}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

export interface RateChoice {
  mode: 'table' | 'manual';
  rate: string;
  valid: boolean;
}

export const EMPTY_RATE: RateChoice = { mode: 'table', rate: '', valid: false };

export function RateField({
  id,
  currency,
  base,
  date,
  value,
  onChange,
  inputClassName,
  inputStyle,
}: {
  id: string;
  currency: string | null;
  base: string;
  date: string;
  value: RateChoice;
  onChange: (value: RateChoice) => void;
  inputClassName?: string;
  inputStyle?: React.CSSProperties;
}) {
  const { t, fmt } = useI18n();
  const foreign = Boolean(currency && currency !== base);
  const { state, refresh } = useRateLookup(
    foreign ? currency : null,
    foreign ? base : null,
    foreign ? date || null : null
  );

  // Keep the parent's choice in step with the lookup.
  useEffect(() => {
    if (!foreign || value.mode === 'manual') return;
    if (state.status === 'ok') {
      if (value.rate !== state.lookup.rate || !value.valid)
        onChange({ mode: 'table', rate: state.lookup.rate!, valid: true });
    } else if (value.valid) {
      onChange({ mode: 'table', rate: '', valid: false });
    }
  }, [foreign, state, value, onChange]);

  if (!foreign || !currency) return null;
  const rateText = (r: string) => fmt.number(Number(r), { maximumFractionDigits: 8 });
  const sourceText = (source: string | null, provider: string | null) =>
    source === 'frankfurter'
      ? provider || 'Frankfurter'
      : source === 'manual'
        ? t('cur.source.manual')
        : (source ?? '');
  const manualValid = (text: string) =>
    /^\d{1,12}(\.\d{1,12})?$/.test(text.trim()) && Number(text) > 0;

  return (
    <div className="space-y-1.5" aria-live="polite">
      <label htmlFor={id} className="block text-[0.7rem] text-muted-foreground">
        {t('cur.rateLabel', { from: currency, to: base })}
      </label>
      {value.mode === 'table' ? (
        <div className="text-[0.75rem]">
          {state.status === 'loading' && (
            <p className="text-muted-foreground">{t('cur.rateLoading')}</p>
          )}
          {state.status === 'ok' && (
            <p className="text-foreground">
              <span className="font-medium tabular-nums">
                1 {currency} = {rateText(state.lookup.rate!)} {base}
              </span>
              <span className="block text-[0.68rem] text-muted-foreground">
                {t('cur.rateFrom', {
                  date: fmt.date(state.lookup.rateDate!),
                  source: sourceText(state.lookup.source, state.lookup.provider),
                })}
                {state.lookup.method === 'inverse' ? ` · ${t('cur.inverse')}` : ''}
                {state.lookup.fetched ? ` · ${t('cur.justFetched')}` : ''}
              </span>
            </p>
          )}
          {(state.status === 'missing' || state.status === 'error') && (
            <div
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
              role="alert"
            >
              <p>
                {state.status === 'missing' && state.lookup?.rate && state.lookup.stale
                  ? t('cur.rateStale', {
                      date: fmt.date(state.lookup.rateDate!),
                      from: currency,
                      to: base,
                    })
                  : t('cur.rateMissing', { from: currency, to: base, date: fmt.date(date) })}
              </p>
              {state.status === 'missing' && state.reason && (
                <p className="text-[0.68rem] mt-0.5">
                  {t(
                    `cur.fetchError.${state.reason === 'forbidden' || state.reason === 'disabled' || state.reason === 'notFound' ? state.reason : 'unavailable'}` as MessageKey
                  )}
                </p>
              )}
              <button
                type="button"
                onClick={refresh}
                className="mt-1 inline-flex items-center gap-1 text-[0.7rem] underline underline-offset-2"
              >
                <RefreshCw size={10} /> {t('cur.retry')}
              </button>
            </div>
          )}
          <button
            type="button"
            className="mt-1 text-[0.7rem] text-primary underline underline-offset-2"
            onClick={() =>
              onChange({
                mode: 'manual',
                rate: state.status === 'ok' ? state.lookup.rate! : '',
                valid: state.status === 'ok',
              })
            }
          >
            {t('cur.enterManually')}
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          <input
            id={id}
            inputMode="decimal"
            className={inputClassName}
            style={inputStyle}
            value={value.rate}
            placeholder={t('cur.ratePlaceholder', { from: currency, to: base })}
            onChange={(e) =>
              onChange({
                mode: 'manual',
                rate: e.target.value.replace(',', '.'),
                valid: manualValid(e.target.value.replace(',', '.')),
              })
            }
          />
          <p className="text-[0.68rem] text-muted-foreground">
            {t('cur.manualNote', { date: fmt.date(date) })}
          </p>
          <button
            type="button"
            className="text-[0.7rem] text-primary underline underline-offset-2"
            onClick={() => onChange({ ...EMPTY_RATE })}
          >
            {t('cur.useStored')}
          </button>
        </div>
      )}
    </div>
  );
}

export const rateForServer = (choice: RateChoice, currency: string | null): number | null =>
  currency && choice.mode === 'manual' ? Number(choice.rate) : null;

export function BaseEquivalent({
  base,
  currency,
  rate,
  rateDate,
  source,
}: {
  base: number;
  currency: string | null;
  rate: number;
  rateDate?: string | null;
  source?: string | null;
}) {
  const { t, fmt } = useI18n();
  if (!currency) return null;
  const sourceKey = (
    source === 'manual' || source === 'rate_table' || source === 'document'
      ? `cur.source.${source}`
      : 'cur.source.legacy'
  ) as MessageKey;
  return (
    <span
      className="block text-[0.65rem] font-normal text-muted-foreground"
      title={t('cur.equivalentTitle', {
        rate: fmt.number(rate, { maximumFractionDigits: 8 }),
        date: rateDate ? fmt.date(rateDate) : t('cur.dateUnknown'),
        source: t(sourceKey),
      })}
    >
      = {fmt.money(base)} ·{' '}
      {t('cur.atRate', { rate: fmt.number(rate, { maximumFractionDigits: 8 }) })}
    </span>
  );
}

export function ConvertedAmount({ conversion }: { conversion: DisplayConversion | null }) {
  const { t, fmt } = useI18n();
  if (!conversion || conversion.value == null || !conversion.rate) return null;
  const source =
    conversion.source === 'frankfurter'
      ? conversion.provider || 'Frankfurter'
      : conversion.source === 'manual'
        ? t('cur.source.manual')
        : (conversion.source ?? '');
  const basis = t('cur.display.basis', {
    rate: fmt.number(Number(conversion.rate), { maximumFractionDigits: 8 }),
    date: conversion.rateDate ? fmt.date(conversion.rateDate) : t('cur.dateUnknown'),
    source,
  });
  return (
    <p className="text-[0.68rem] text-muted-foreground leading-snug" title={basis}>
      {t('cur.display.converted', { amount: fmt.moneyIn(conversion.value, conversion.code) })}
      <span className="sr-only"> {basis}</span>
    </p>
  );
}

export function DisplayBasis({
  convert,
  display,
  base,
}: {
  convert: (amount: number) => DisplayConversion | null;
  display: string | null;
  base: string | null;
}) {
  const { t, fmt } = useI18n();
  if (!display || !base) return null;
  const c = convert(0);
  if (!c) return null;
  if (!c.rate)
    return (
      <p className="text-[0.7rem] text-amber-700 dark:text-amber-400">
        {t('cur.display.noRate', { from: base, to: display })}
      </p>
    );
  const source =
    c.source === 'frankfurter'
      ? c.provider || 'Frankfurter'
      : c.source === 'manual'
        ? t('cur.source.manual')
        : (c.source ?? '');
  return (
    <p className="text-[0.7rem] text-muted-foreground">
      ≈ {display}: 1 {base} = {fmt.number(Number(c.rate), { maximumFractionDigits: 8 })} {display} ·{' '}
      {c.rateDate ? fmt.date(c.rateDate) : t('cur.dateUnknown')} · {source}
    </p>
  );
}
