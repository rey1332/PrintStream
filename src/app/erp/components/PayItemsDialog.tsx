'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { HrError, hrService, type PayItem, type PayItemKind } from '../lib/hrService';

const inputCls =
  'rounded-lg border border-border bg-card px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

// Common Indonesian payroll items (percentages as usually set; change them per employee).
// JKK depends on the company's risk group (0.24 / 0.54 / 0.89 / 1.27 / 1.74%):
// quarrying is in the highest group, so 1.74% is suggested; confirm it with BPJS.
// PPh 21 is not offered: ETNA does not calculate it (TER) yet, and a 0% line
// would look as if it did.
const PRESETS: Omit<PayItem, 'id'>[] = [
  { kind: 'deduction', name: 'BPJS Kesehatan', method: 'percent', amount: 1 },
  { kind: 'deduction', name: 'BPJS JHT', method: 'percent', amount: 2 },
  { kind: 'deduction', name: 'BPJS JP', method: 'percent', amount: 1 },
  { kind: 'employer', name: 'BPJS Kesehatan', method: 'percent', amount: 4 },
  { kind: 'employer', name: 'BPJS JHT', method: 'percent', amount: 3.7 },
  { kind: 'employer', name: 'BPJS JP', method: 'percent', amount: 2 },
  { kind: 'employer', name: 'BPJS JKK', method: 'percent', amount: 1.74 },
  { kind: 'employer', name: 'BPJS JKM', method: 'percent', amount: 0.3 },
];

const KINDS: PayItemKind[] = ['allowance', 'deduction', 'employer'];

export function PayItemsDialog({
  employeeId,
  employeeName,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  onClose: () => void;
}) {
  const { t, fmt } = useI18n();
  const [items, setItems] = useState<PayItem[]>([]);
  const [quota, setQuota] = useState('');
  const [draft, setDraft] = useState<Omit<PayItem, 'id'>>({
    kind: 'allowance',
    name: '',
    method: 'fixed',
    amount: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const errorText = useCallback(
    (err: unknown) => t(err instanceof HrError ? err.key : 'hr.err.failed'),
    [t]
  );

  const load = useCallback(async () => {
    try {
      const [list, balances] = await Promise.all([
        hrService.payItems(employeeId),
        hrService.leaveBalances(new Date().getFullYear()),
      ]);
      setItems(list);
      const mine = balances.find((b) => b.employeeId === employeeId);
      if (mine) setQuota(String(mine.quota));
    } catch (err) {
      setError(errorText(err));
    }
  }, [employeeId, errorText]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(item: Omit<PayItem, 'id'>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await hrService.savePayItem(employeeId, null, item);
      setDraft({ kind: item.kind, name: '', method: item.method, amount: 0 });
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function update(item: PayItem, amount: number) {
    if (amount === item.amount) return;
    try {
      await hrService.savePayItem(employeeId, item.id, { ...item, amount });
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function remove(item: PayItem) {
    try {
      await hrService.deletePayItem(item.id);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function saveQuota() {
    const days = Number(quota);
    try {
      await hrService.setLeaveQuota(employeeId, Number.isFinite(days) ? Math.round(days) : -1);
      toast.success(t('hr.leave.quotaSaved'));
    } catch (err) {
      setError(errorText(err));
    }
  }

  const exists = (p: Omit<PayItem, 'id'>) =>
    items.some((i) => i.kind === p.kind && i.name.toLowerCase() === p.name.toLowerCase());

  return (
    <div
      className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-items-title"
        className="max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-card p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 id="pay-items-title" className="text-[1rem] font-semibold text-foreground">
            {t('hr.items.title', { name: employeeName })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-[0.75rem] text-muted-foreground">{t('hr.items.hint')}</p>
        <p
          role="note"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[0.75rem] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
        >
          {t('hr.taxWarning')}
        </p>

        {KINDS.map((kind) => {
          const list = items.filter((i) => i.kind === kind);
          return (
            <section key={kind} className="space-y-1.5">
              <h3 className="text-[0.78rem] font-semibold text-foreground">
                {t(`hr.items.kind.${kind}` as MessageKey)}
              </h3>
              {list.length === 0 ? (
                <p className="text-[0.75rem] text-muted-foreground">{t('hr.items.empty')}</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {list.map((item) => (
                    <li key={item.id} className="flex items-center gap-2 px-3 py-1.5 text-[0.8rem]">
                      <span className="flex-1 text-foreground">{item.name}</span>
                      <input
                        type="number"
                        min={0}
                        max={item.method === 'percent' ? 100 : undefined}
                        step="any"
                        defaultValue={item.amount}
                        aria-label={`${item.name} ${t('hr.items.amount')}`}
                        onBlur={(e) => void update(item, Number(e.target.value))}
                        className={`${inputCls} w-28 text-right`}
                      />
                      <span className="w-8 text-[0.75rem] text-muted-foreground">
                        {item.method === 'percent' ? '%' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => void remove(item)}
                        aria-label={`${t('common.delete')}: ${item.name}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-red-600 max-lg:h-11 max-lg:w-11"
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add(draft);
          }}
          className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
        >
          <select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as PayItemKind })}
            aria-label={t('hr.leave.type')}
            className={inputCls}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`hr.items.kind.${k}` as MessageKey)}
              </option>
            ))}
          </select>
          <input
            required
            maxLength={80}
            placeholder={t('hr.items.name')}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={`${inputCls} flex-1 min-w-[8rem]`}
          />
          <select
            value={draft.method}
            onChange={(e) => setDraft({ ...draft, method: e.target.value as PayItem['method'] })}
            aria-label={t('hr.items.amount')}
            className={inputCls}
          >
            <option value="fixed">{t('hr.items.method.fixed')}</option>
            <option value="percent">{t('hr.items.method.percent')}</option>
          </select>
          <input
            type="number"
            min={0}
            step="any"
            required
            value={draft.amount}
            onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })}
            aria-label={t('hr.items.amount')}
            className={`${inputCls} w-28 text-right`}
          />
          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
            {t('hr.items.add')}
          </button>
        </form>

        <div className="space-y-1.5">
          <p className="text-[0.72rem] font-semibold text-muted-foreground">
            {t('hr.items.presets')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.filter((p) => !exists(p)).map((p) => (
              <button
                key={`${p.kind}-${p.name}`}
                type="button"
                disabled={busy}
                onClick={() => void add(p)}
                className="rounded-full border border-border px-2.5 py-1 text-[0.72rem] text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11"
              >
                {p.name} · {fmt.number(p.amount)}% · {t(`hr.items.kind.${p.kind}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="block">
            <span className="mb-1 block text-[0.72rem] text-muted-foreground">
              {t('hr.leave.quotaLabel')}
            </span>
            <input
              type="number"
              min={0}
              max={366}
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
              className={`${inputCls} w-28 text-right`}
            />
          </label>
          <button
            type="button"
            onClick={() => void saveQuota()}
            className="rounded-lg border border-border px-3 py-2 text-[0.8rem] text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11"
          >
            {t('common.save')}
          </button>
        </div>

        {error && (
          <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
