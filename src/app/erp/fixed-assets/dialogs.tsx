'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  Dialog,
  DialogButtons,
  Field,
  FormError,
  errorKey,
  inputCls,
  todayIso,
} from '../components/moduleUi';
import {
  ASSET_CATEGORIES,
  financeService,
  type AssetCategory,
  type AssetFunding,
  type CashAccount,
  type DepreciationMethod,
  type FixedAsset,
  type ScheduleRow,
} from '../lib/financeService';

// Useful lives of the Indonesian tax groups (PMK 72/2023), as a starting
// point: the company may use its own for its commercial books.
const LIFE_PRESETS: { months: number; key: MessageKey }[] = [
  { months: 48, key: 'fa.life.g1' },
  { months: 96, key: 'fa.life.g2' },
  { months: 192, key: 'fa.life.g3' },
  { months: 240, key: 'fa.life.g4' },
  { months: 240, key: 'fa.life.building' },
];
const DEFAULT_LIFE: Record<AssetCategory, number> = {
  land: 600,
  building: 240,
  vehicle: 96,
  heavy_equipment: 96,
  machinery: 96,
  office: 48,
  other: 48,
};

const useCashAccounts = () => {
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  useEffect(() => {
    financeService
      .accounts()
      .then((list) => setAccounts(list.filter((a) => a.active)))
      .catch(() => setAccounts([]));
  }, []);
  return accounts;
};

export function AssetDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, fmt } = useI18n();
  const cashAccounts = useCashAccounts();
  const [name, setName] = useState('');
  const [assetNo, setAssetNo] = useState('');
  const [category, setCategory] = useState<AssetCategory>('heavy_equipment');
  const [date, setDate] = useState(todayIso());
  const [cost, setCost] = useState('');
  const [salvage, setSalvage] = useState('0');
  const [life, setLife] = useState(String(DEFAULT_LIFE.heavy_equipment));
  const [method, setMethod] = useState<DepreciationMethod>('straight_line');
  const [rate, setRate] = useState('');
  const [funding, setFunding] = useState<AssetFunding>('cash');
  const [cashAccountId, setCashAccountId] = useState('');
  const [start, setStart] = useState('');
  const [priorMonths, setPriorMonths] = useState('0');
  const [priorAccumulated, setPriorAccumulated] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!cashAccountId && cashAccounts.length) setCashAccountId(cashAccounts[0].id);
  }, [cashAccounts, cashAccountId]);

  function pickCategory(c: AssetCategory) {
    setCategory(c);
    setLife(String(DEFAULT_LIFE[c]));
    setMethod(c === 'land' ? 'none' : method === 'none' ? 'straight_line' : method);
  }

  const months = Number(life);
  const monthly = useMemo(() => {
    const base = Number(cost) - Number(salvage);
    if (!(base > 0) || !(months > 0) || method === 'none') return null;
    if (method === 'straight_line') return base / months;
    const r = Number(rate) || 2400 / months;
    return (Number(cost) * r) / 1200;
  }, [cost, salvage, months, method, rate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !date) return setError(t('fin.err.assetRequired'));
    if (!(Number(cost) > 0) || Number(salvage) < 0 || Number(salvage) >= Number(cost))
      return setError(t('fin.err.assetAmounts'));
    if (!(months >= 1 && months <= 600)) return setError(t('fin.err.life'));
    setBusy(true);
    setError('');
    try {
      await financeService.createAsset({
        name: name.trim(),
        asset_no: assetNo.trim(),
        category,
        acquisition_date: date,
        cost: Number(cost),
        salvage_value: Number(salvage) || 0,
        useful_life_months: months,
        method,
        declining_rate: method === 'declining_balance' && rate ? Number(rate) : null,
        depreciation_start: funding === 'opening' && start ? `${start}-01` : null,
        prior_months: funding === 'opening' ? Number(priorMonths) || 0 : 0,
        prior_accumulated: funding === 'opening' ? Number(priorAccumulated) || 0 : 0,
        funding,
        cash_account_id: funding === 'cash' ? cashAccountId || null : null,
      });
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t('fa.new')} onClose={onClose} onSubmit={submit} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('fa.name')} wide>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            autoFocus
            placeholder={t('fa.namePlaceholder')}
          />
        </Field>
        <Field label={t('fa.assetNo')}>
          <input
            className={inputCls}
            value={assetNo}
            onChange={(e) => setAssetNo(e.target.value)}
            maxLength={40}
          />
        </Field>
        <Field label={t('fa.category')}>
          <select
            className={inputCls}
            value={category}
            onChange={(e) => pickCategory(e.target.value as AssetCategory)}
          >
            {ASSET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`fa.cat.${c}` as MessageKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fa.acquired')}>
          <input
            type="date"
            className={inputCls}
            value={date}
            max={todayIso()}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label={t('fa.cost')}>
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className={inputCls}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </Field>
        <Field label={t('fa.salvage')} hint={t('fa.salvageHint')}>
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className={inputCls}
            value={salvage}
            onChange={(e) => setSalvage(e.target.value)}
          />
        </Field>
        <Field label={t('fa.method')}>
          <select
            className={inputCls}
            value={method}
            onChange={(e) => setMethod(e.target.value as DepreciationMethod)}
          >
            <option value="straight_line">{t('fa.method.straight_line')}</option>
            <option value="declining_balance">{t('fa.method.declining_balance')}</option>
            <option value="none">{t('fa.method.none')}</option>
          </select>
        </Field>
        {method !== 'none' && (
          <Field
            label={t('fa.life')}
            hint={monthly === null ? undefined : t('fa.monthly', { amount: fmt.money(monthly) })}
          >
            <div className="flex gap-2">
              <input
                type="number"
                min={1}
                max={600}
                className={inputCls}
                value={life}
                onChange={(e) => setLife(e.target.value)}
              />
              <select
                className={`${inputCls} w-auto`}
                value=""
                aria-label={t('fa.lifePreset')}
                onChange={(e) => e.target.value && setLife(e.target.value)}
              >
                <option value="">{t('fa.lifePreset')}</option>
                {LIFE_PRESETS.map((p) => (
                  <option key={p.key} value={p.months}>
                    {t(p.key)}
                  </option>
                ))}
              </select>
            </div>
          </Field>
        )}
        {method === 'declining_balance' && (
          <Field
            label={t('fa.rate')}
            hint={t('fa.rateHint', { rate: fmt.number(months > 0 ? 2400 / months : 0) })}
          >
            <input
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              className={inputCls}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
        )}
        <Field label={t('fa.funding')} wide>
          <select
            className={inputCls}
            value={funding}
            onChange={(e) => setFunding(e.target.value as AssetFunding)}
          >
            {(['cash', 'payable', 'opening', 'recorded'] as AssetFunding[]).map((f) => (
              <option key={f} value={f}>
                {t(`fa.funding.${f}` as MessageKey)}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[0.68rem] text-muted-foreground">
            {t(`fa.funding.${funding}Hint` as MessageKey)}
          </span>
        </Field>
        {funding === 'cash' && (
          <Field label={t('fa.paidFrom')} wide>
            <select
              className={inputCls}
              value={cashAccountId}
              onChange={(e) => setCashAccountId(e.target.value)}
            >
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {funding === 'opening' && method !== 'none' && (
          <>
            <Field label={t('fa.start')} hint={t('fa.startHint')}>
              <input
                type="month"
                className={inputCls}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label={t('fa.priorMonths')}>
              <input
                type="number"
                min={0}
                className={inputCls}
                value={priorMonths}
                onChange={(e) => setPriorMonths(e.target.value)}
              />
            </Field>
            <Field label={t('fa.priorAccumulated')} wide>
              <input
                type="number"
                min="0"
                step="0.01"
                className={inputCls}
                value={priorAccumulated}
                onChange={(e) => setPriorAccumulated(e.target.value)}
              />
            </Field>
          </>
        )}
      </div>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('common.save')} onCancel={onClose} />
    </Dialog>
  );
}

export function DepreciateDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (r: { assets: number; months: number; amount: number }) => void;
}) {
  const { t } = useI18n();
  const thisMonth = todayIso().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await financeService.depreciate(`${month}-01`));
    } catch (err) {
      setError(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t('fa.depreciate')} onClose={onClose} onSubmit={submit}>
      <p className="text-[0.75rem] text-muted-foreground">{t('fa.depreciateHint')}</p>
      <Field label={t('fa.through')}>
        <input
          type="month"
          className={inputCls}
          value={month}
          max={thisMonth}
          onChange={(e) => setMonth(e.target.value)}
        />
      </Field>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('fa.post')} onCancel={onClose} />
    </Dialog>
  );
}

export function DisposeDialog({
  asset,
  onClose,
  onDone,
}: {
  asset: FixedAsset;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, fmt } = useI18n();
  const cashAccounts = useCashAccounts();
  const [date, setDate] = useState(todayIso());
  const [proceeds, setProceeds] = useState('0');
  const [cashAccountId, setCashAccountId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!cashAccountId && cashAccounts.length) setCashAccountId(cashAccounts[0].id);
  }, [cashAccounts, cashAccountId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (Number(proceeds) < 0) return setError(t('fin.err.amount'));
    setBusy(true);
    setError('');
    try {
      await financeService.dispose(
        asset.id,
        date,
        Number(proceeds) || 0,
        cashAccountId || null,
        note
      );
      onDone();
    } catch (err) {
      setError(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t('fa.disposeTitle', { name: asset.name })} onClose={onClose} onSubmit={submit}>
      <p className="text-[0.75rem] text-muted-foreground">
        {t('fa.disposeHint', { book: fmt.money(asset.bookValue) })}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('fin.col.date')}>
          <input
            type="date"
            className={inputCls}
            value={date}
            min={asset.acquisitionDate}
            max={todayIso()}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label={t('fa.proceeds')}>
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            className={inputCls}
            value={proceeds}
            onChange={(e) => setProceeds(e.target.value)}
          />
        </Field>
        {Number(proceeds) > 0 && (
          <Field label={t('fa.receivedIn')} wide>
            <select
              className={inputCls}
              value={cashAccountId}
              onChange={(e) => setCashAccountId(e.target.value)}
            >
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('fa.note')} wide>
          <input
            className={inputCls}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
          />
        </Field>
      </div>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('fa.dispose')} onCancel={onClose} />
    </Dialog>
  );
}

export function ScheduleDialog({ asset, onClose }: { asset: FixedAsset; onClose: () => void }) {
  const { t, fmt } = useI18n();
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    financeService
      .schedule(asset.id)
      .then(setRows)
      .catch((err) => setError(t(errorKey(err, 'fin.err.failed'))));
  }, [asset.id, t]);

  return (
    <Dialog
      title={t('fa.scheduleTitle', { name: asset.name })}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        onClose();
      }}
      wide
    >
      {rows === null && !error && (
        <p className="text-[0.75rem] text-muted-foreground">{t('common.loading')}</p>
      )}
      {rows?.length === 0 && (
        <p className="text-[0.75rem] text-muted-foreground">{t('fa.noSchedule')}</p>
      )}
      {!!rows?.length && (
        <div className="max-h-[60dvh] overflow-auto rounded-lg border border-border">
          <table className="w-full text-[0.75rem]">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">{t('fa.col.month')}</th>
                <th className="px-3 py-1.5 text-right font-medium">{t('fa.col.depreciation')}</th>
                <th className="px-3 py-1.5 text-right font-medium">{t('fa.col.accumulated')}</th>
                <th className="px-3 py-1.5 text-right font-medium">{t('fa.col.book')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.period}
                  className={`border-t border-border ${r.posted ? '' : 'text-muted-foreground'}`}
                >
                  <td className="px-3 py-1.5">
                    {fmt.month(r.period, true)}
                    {r.posted && (
                      <span className="ml-1 text-[0.65rem] text-emerald-600 dark:text-emerald-400">
                        ✓
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt.money(r.amount)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {fmt.money(r.accumulated)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmt.money(r.bookValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormError text={error} />
      <div className="flex justify-end">
        <button type="submit" className="rounded-lg border border-border px-4 py-2 text-[0.8rem]">
          {t('common.close')}
        </button>
      </div>
    </Dialog>
  );
}
