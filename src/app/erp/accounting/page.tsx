'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Landmark, Loader2, Plus, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  ACCOUNT_TYPES,
  accountingService,
  statements,
  type AccountType,
  type AccountingSettings,
  type GlAccount,
  type JournalEntry,
  type TrialBalanceRow,
} from '../lib/accountingService';
import { ReasonDialog } from '../components/ReasonDialog';
import { useQueryParam } from '../lib/useFocusedRecord';
import { useCurrencySettings } from '../lib/useCurrency';

type Tab = 'reports' | 'journal' | 'accounts' | 'settings';
type T = ReturnType<typeof useI18n>['t'];

const CURRENCIES = [
  'IDR',
  'USD',
  'SGD',
  'MYR',
  'EUR',
  'GBP',
  'AUD',
  'JPY',
  'CNY',
  'HKD',
  'THB',
  'PHP',
  'VND',
  'INR',
];
const JOURNAL_PAGE = 25;

const card = 'rounded-xl border border-border bg-card';
const inputCls =
  'rounded-lg border border-border bg-input px-2.5 py-1.5 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';
const th = 'px-3 py-2 text-left text-[0.7rem] font-medium text-muted-foreground whitespace-nowrap';
const td = 'px-3 py-2 text-[0.78rem] text-foreground';

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function presetRange(preset: 'month' | 'quarter' | 'year' | 'all'): { from: string; to: string } {
  const now = new Date();
  const to = iso(now);
  if (preset === 'all') return { from: '', to };
  if (preset === 'year') return { from: iso(new Date(now.getFullYear(), 0, 1)), to };
  if (preset === 'quarter')
    return { from: iso(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)), to };
  return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to };
}

function accountName(a: { name: string; systemKey: string | null }, t: T): string {
  const key = a.systemKey ? `acc.sys.${a.systemKey}` : '';
  return key && hasMessage(key) ? t(key as MessageKey) : a.name;
}

function sourceLabel(sourceType: string, t: T): string {
  const key = `acc.src.${sourceType}`;
  return hasMessage(key) ? t(key as MessageKey) : sourceType;
}

// ─── Reports ────────────────────────────────────────────────────────────────

function Reports({ onViewAccount }: { onViewAccount: (accountId: string) => void }) {
  const { t, fmt } = useI18n();
  const [range, setRange] = useState(presetRange('year'));
  const [period, setPeriod] = useState<TrialBalanceRow[] | null>(null);
  const [cumulative, setCumulative] = useState<TrialBalanceRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setError('');
    setPeriod(null);
    Promise.all([
      accountingService.trialBalance(range.from || null, range.to || null),
      accountingService.trialBalance(null, range.to || null),
    ])
      .then(([p, c]) => {
        if (active) {
          setPeriod(p);
          setCumulative(c);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [range]);

  const s = useMemo(
    () => (period && cumulative ? statements(period, cumulative) : null),
    [period, cumulative]
  );
  const withBalance = (rows: TrialBalanceRow[] | null, type: AccountType) =>
    (rows ?? []).filter((r) => r.type === type && r.balance !== 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[0.72rem] text-muted-foreground">
          {t('acc.from')}
          <input
            type="date"
            className={`${inputCls} block mt-1`}
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </label>
        <label className="text-[0.72rem] text-muted-foreground">
          {t('acc.to')}
          <input
            type="date"
            className={`${inputCls} block mt-1`}
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </label>
        {(['month', 'quarter', 'year', 'all'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setRange(presetRange(p))}
            className="px-2.5 py-1.5 rounded-lg border border-border text-[0.72rem] text-muted-foreground hover:text-foreground"
          >
            {t(`acc.preset.${p}`)}
          </button>
        ))}
      </div>
      <p className="text-[0.7rem] text-muted-foreground">{t('acc.notice')}</p>
      {error && <p className="text-[0.78rem] text-red-600 dark:text-red-400">{error}</p>}
      {!s && !error && <Loader2 size={16} className="animate-spin text-muted-foreground" />}

      {s && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className={`${card} p-4 space-y-2`}>
            <h2 className="text-[0.9rem] font-semibold text-foreground">{t('acc.pl.title')}</h2>
            {(['income', 'expense'] as const).map((type) => (
              <div key={type}>
                <p className="text-[0.68rem] uppercase tracking-wider text-muted-foreground mt-2">
                  {t(type === 'income' ? 'acc.pl.income' : 'acc.pl.expenses')}
                </p>
                {withBalance(period, type).map((r) => (
                  <div key={r.accountId} className="flex justify-between text-[0.78rem] py-0.5">
                    <span className="text-foreground">
                      {r.code} · {accountName(r, t)}
                    </span>
                    <span className="tabular-nums">{fmt.money(r.balance)}</span>
                  </div>
                ))}
                <div className="flex justify-between text-[0.78rem] font-semibold border-t border-border mt-1 pt-1">
                  <span>{t('acc.tb.total')}</span>
                  <span className="tabular-nums">
                    {fmt.money(type === 'income' ? s.income : s.expenses)}
                  </span>
                </div>
              </div>
            ))}
            <div
              className={`flex justify-between text-[0.9rem] font-bold border-t-2 border-border pt-2 ${s.netIncome < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}
            >
              <span>{t('acc.pl.net')}</span>
              <span className="tabular-nums">{fmt.money(s.netIncome)}</span>
            </div>
          </section>

          <section className={`${card} p-4 space-y-2`}>
            <h2 className="text-[0.9rem] font-semibold text-foreground">
              {t('acc.bs.title', { date: fmt.date(range.to) })}
            </h2>
            {(['asset', 'liability', 'equity'] as const).map((type) => (
              <div key={type}>
                <p className="text-[0.68rem] uppercase tracking-wider text-muted-foreground mt-2">
                  {t(
                    type === 'asset'
                      ? 'acc.bs.assets'
                      : type === 'liability'
                        ? 'acc.bs.liabilities'
                        : 'acc.bs.equity'
                  )}
                </p>
                {withBalance(cumulative, type).map((r) => (
                  <div key={r.accountId} className="flex justify-between text-[0.78rem] py-0.5">
                    <span className="text-foreground">
                      {r.code} · {accountName(r, t)}
                    </span>
                    <span className="tabular-nums">{fmt.money(r.balance)}</span>
                  </div>
                ))}
                {type === 'equity' && (
                  <div className="flex justify-between text-[0.78rem] py-0.5">
                    <span className="text-foreground">{t('acc.bs.earnings')}</span>
                    <span className="tabular-nums">{fmt.money(s.earningsToDate)}</span>
                  </div>
                )}
              </div>
            ))}
            <div className="flex justify-between text-[0.8rem] font-semibold border-t-2 border-border pt-2">
              <span>{t('acc.bs.assets')}</span>
              <span className="tabular-nums">{fmt.money(s.assets)}</span>
            </div>
            <div className="flex justify-between text-[0.8rem] font-semibold">
              <span>{t('acc.bs.totalLe')}</span>
              <span className="tabular-nums">
                {fmt.money(s.liabilities + s.equity + s.earningsToDate)}
              </span>
            </div>
            <p
              className={`text-[0.7rem] ${s.difference === 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
            >
              {s.difference === 0
                ? t('acc.bs.balanced')
                : t('acc.bs.unbalanced', { amount: fmt.money(s.difference) })}
            </p>
          </section>
        </div>
      )}

      {period && (
        <section className={`${card} overflow-hidden`}>
          <h2 className="px-4 pt-4 text-[0.9rem] font-semibold text-foreground">
            {t('acc.tb.title')}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full mt-2">
              <thead className="border-b border-border">
                <tr>
                  <th className={th}>{t('acc.tb.code')}</th>
                  <th className={th}>{t('acc.tb.account')}</th>
                  <th className={th}>{t('acc.tb.type')}</th>
                  <th className={`${th} text-right`}>{t('acc.tb.debit')}</th>
                  <th className={`${th} text-right`}>{t('acc.tb.credit')}</th>
                  <th className={`${th} text-right`}>{t('acc.tb.balance')}</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody>
                {period
                  .filter((r) => r.debit || r.credit)
                  .map((r) => (
                    <tr key={r.accountId} className="border-b border-border last:border-b-0">
                      <td className={`${td} tabular-nums`}>{r.code}</td>
                      <td className={td}>{accountName(r, t)}</td>
                      <td className={`${td} text-muted-foreground`}>{t(`acc.type.${r.type}`)}</td>
                      <td className={`${td} text-right tabular-nums`}>{fmt.money(r.debit)}</td>
                      <td className={`${td} text-right tabular-nums`}>{fmt.money(r.credit)}</td>
                      <td className={`${td} text-right tabular-nums font-medium`}>
                        {fmt.money(r.balance)}
                      </td>
                      <td className={td}>
                        <button
                          type="button"
                          onClick={() => onViewAccount(r.accountId)}
                          className="text-[0.7rem] text-muted-foreground hover:text-foreground underline underline-offset-2"
                        >
                          {t('acc.tb.view')}
                        </button>
                      </td>
                    </tr>
                  ))}
                <tr className="border-t-2 border-border font-semibold">
                  <td className={td} colSpan={3}>
                    {t('acc.tb.total')}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {fmt.money(period.reduce((a, r) => a + r.debit, 0))}
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {fmt.money(period.reduce((a, r) => a + r.credit, 0))}
                  </td>
                  <td className={td} colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Journal ────────────────────────────────────────────────────────────────

interface DraftLine {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}
const emptyLine = (): DraftLine => ({ accountId: '', debit: '', credit: '', memo: '' });

function NewEntryForm({ accounts, onPosted }: { accounts: GlAccount[]; onPosted: () => void }) {
  const { t, fmt } = useI18n();
  const [date, setDate] = useState(iso(new Date()));
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const num = (v: string) => (v.trim() === '' ? 0 : Number(v));
  const debit = lines.reduce((s, l) => s + num(l.debit), 0);
  const credit = lines.reduce((s, l) => s + num(l.credit), 0);
  const diff = Math.round((debit - credit) * 100) / 100;
  const valid =
    debit > 0 &&
    diff === 0 &&
    lines.every((l) => !l.accountId || num(l.debit) > 0 !== num(l.credit) > 0);
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setError(t('acc.j.mustBalance'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await accountingService.postJournal(
        date,
        memo,
        lines
          .filter((l) => l.accountId)
          .map((l) => ({
            accountId: l.accountId,
            debit: num(l.debit),
            credit: num(l.credit),
            memo: l.memo,
          }))
      );
      toast.success(t('acc.j.posted'));
      setMemo('');
      setLines([emptyLine(), emptyLine()]);
      onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('erp.error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={`${card} p-4 space-y-3`}>
      <h3 className="text-[0.85rem] font-semibold text-foreground">{t('acc.j.new')}</h3>
      <div className="flex flex-wrap gap-2">
        <label className="text-[0.72rem] text-muted-foreground">
          {t('acc.j.date')}
          <input
            type="date"
            required
            className={`${inputCls} block mt-1`}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label className="text-[0.72rem] text-muted-foreground flex-1 min-w-[220px]">
          {t('acc.j.memo')}
          <input
            required
            minLength={3}
            maxLength={500}
            className={`${inputCls} block mt-1 w-full`}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </label>
      </div>
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <select
              aria-label={t('acc.tb.account')}
              className={`${inputCls} col-span-12 sm:col-span-4`}
              value={l.accountId}
              onChange={(e) => setLine(i, { accountId: e.target.value })}
            >
              <option value="">{t('acc.j.selectAccount')}</option>
              {accounts
                .filter((a) => a.active)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {accountName(a, t)}
                  </option>
                ))}
            </select>
            <input
              aria-label={t('acc.tb.debit')}
              placeholder={t('acc.tb.debit')}
              inputMode="decimal"
              className={`${inputCls} col-span-4 sm:col-span-2 text-right`}
              value={l.debit}
              onChange={(e) =>
                setLine(i, { debit: e.target.value.replace(/[^\d.]/g, ''), credit: '' })
              }
            />
            <input
              aria-label={t('acc.tb.credit')}
              placeholder={t('acc.tb.credit')}
              inputMode="decimal"
              className={`${inputCls} col-span-4 sm:col-span-2 text-right`}
              value={l.credit}
              onChange={(e) =>
                setLine(i, { credit: e.target.value.replace(/[^\d.]/g, ''), debit: '' })
              }
            />
            <input
              aria-label={t('acc.j.lineMemo')}
              placeholder={t('acc.j.lineMemo')}
              maxLength={300}
              className={`${inputCls} col-span-3 sm:col-span-3`}
              value={l.memo}
              onChange={(e) => setLine(i, { memo: e.target.value })}
            />
            <button
              type="button"
              disabled={lines.length <= 2}
              onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
              className="col-span-1 p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
              aria-label={t('acc.j.removeLine')}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          disabled={lines.length >= 50}
          onClick={() => setLines((ls) => [...ls, emptyLine()])}
          className="flex items-center gap-1 text-[0.75rem] text-muted-foreground hover:text-foreground"
        >
          <Plus size={12} /> {t('acc.j.addLine')}
        </button>
        <p className="text-[0.75rem] tabular-nums text-muted-foreground">
          {t('acc.tb.debit')} {fmt.money(debit)} · {t('acc.tb.credit')} {fmt.money(credit)} ·{' '}
          <span
            className={
              diff === 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'
            }
          >
            {t('acc.j.difference')} {fmt.money(diff)}
          </span>
        </p>
      </div>
      {error && (
        <p className="text-[0.75rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || !valid}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
      >
        {busy && <Loader2 size={12} className="animate-spin" />}
        {t('acc.j.post')}
      </button>
    </form>
  );
}

function Journal({
  settings,
  accounts,
  accountFilter,
  setAccountFilter,
  focus,
}: {
  settings: AccountingSettings;
  accounts: GlAccount[];
  accountFilter: string;
  setAccountFilter: (id: string) => void;
  focus?: { entryId: string; date: string } | null;
}) {
  const { t, fmt } = useI18n();
  const [range, setRange] = useState(() =>
    focus ? { from: focus.date, to: focus.date } : presetRange('year')
  );
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; entries: JournalEntry[] } | null>(null);
  const [error, setError] = useState('');
  const [reversing, setReversing] = useState<JournalEntry | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => setPage(0), [range, accountFilter]);
  useEffect(() => {
    let active = true;
    setError('');
    accountingService
      .journal({
        from: range.from || null,
        to: range.to || null,
        accountId: accountFilter || null,
        limit: JOURNAL_PAGE,
        offset: page * JOURNAL_PAGE,
      })
      .then((d) => active && setData(d))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [range, accountFilter, page, reload]);

  const pages = data ? Math.max(1, Math.ceil(data.total / JOURNAL_PAGE)) : 1;

  const focusShown = Boolean(focus && data?.entries.some((e) => e.id === focus.entryId));
  useEffect(() => {
    if (!focusShown || !focus) return;
    document
      .querySelector(`[data-record-id="${CSS.escape(focus.entryId)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusShown, focus?.entryId]);

  return (
    <div className="space-y-4">
      {settings.canPost ? (
        <NewEntryForm accounts={accounts} onPosted={() => setReload((n) => n + 1)} />
      ) : (
        <p className="text-[0.75rem] text-muted-foreground">{t('acc.j.noPermission')}</p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[0.72rem] text-muted-foreground">
          {t('acc.from')}
          <input
            type="date"
            className={`${inputCls} block mt-1`}
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          />
        </label>
        <label className="text-[0.72rem] text-muted-foreground">
          {t('acc.to')}
          <input
            type="date"
            className={`${inputCls} block mt-1`}
            value={range.to}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          />
        </label>
        <label className="text-[0.72rem] text-muted-foreground">
          {t('acc.j.filterAccount')}
          <select
            className={`${inputCls} block mt-1`}
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
          >
            <option value="">{t('acc.j.allAccounts')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {accountName(a, t)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="text-[0.78rem] text-red-600 dark:text-red-400">{error}</p>}
      {!data && !error && <Loader2 size={16} className="animate-spin text-muted-foreground" />}
      {data && data.entries.length === 0 && (
        <p className="text-[0.8rem] text-muted-foreground">{t('acc.j.empty')}</p>
      )}
      <div className="space-y-2">
        {data?.entries.map((e) => (
          <article
            key={e.id}
            data-record-id={e.id}
            data-focused={focus?.entryId === e.id ? 'true' : undefined}
            className={`${card} p-3`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[0.8rem] text-foreground">
                <span className="font-semibold tabular-nums">#{e.entryNo}</span> ·{' '}
                {fmt.date(e.date)} · {e.memo}
              </p>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded-full text-[0.62rem] bg-[var(--surface-3)] text-muted-foreground">
                  {sourceLabel(e.sourceType, t)}
                </span>
                {e.reversed && (
                  <span className="px-2 py-0.5 rounded-full text-[0.62rem] bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    {t('acc.j.reversed')}
                  </span>
                )}
                {settings.canPost && e.sourceType === 'manual' && !e.reversed && (
                  <button
                    type="button"
                    onClick={() => setReversing(e)}
                    className="flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
                  >
                    <Undo2 size={11} /> {t('acc.j.reverse')}
                  </button>
                )}
              </div>
            </div>
            <table className="w-full mt-2">
              <tbody>
                {e.lines.map((l, i) => (
                  <tr key={i} className="text-[0.75rem]">
                    <td className={`py-0.5 ${l.credit > 0 ? 'pl-6' : ''} text-foreground`}>
                      {l.code} ·{' '}
                      {accountName(
                        {
                          name: l.name,
                          systemKey: accounts.find((a) => a.id === l.accountId)?.systemKey ?? null,
                        },
                        t
                      )}
                      {l.memo && <span className="text-muted-foreground"> — {l.memo}</span>}
                    </td>
                    <td className="py-0.5 text-right tabular-nums w-32">
                      {l.debit ? fmt.money(l.debit) : ''}
                    </td>
                    <td className="py-0.5 text-right tabular-nums w-32">
                      {l.credit ? fmt.money(l.credit) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        ))}
      </div>
      {data && data.total > JOURNAL_PAGE && (
        <nav className="flex items-center justify-between" aria-label={t('common.pagination')}>
          <p className="text-[0.72rem] text-muted-foreground">
            {t('common.showingRange', {
              from: fmt.number(page * JOURNAL_PAGE + 1),
              to: fmt.number(Math.min(data.total, (page + 1) * JOURNAL_PAGE)),
              total: fmt.number(data.total),
            })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="px-2.5 py-1 rounded-md border border-border text-[0.72rem] disabled:opacity-40"
            >
              {t('common.previousPage')}
            </button>
            <button
              type="button"
              disabled={page >= pages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="px-2.5 py-1 rounded-md border border-border text-[0.72rem] disabled:opacity-40"
            >
              {t('common.nextPage')}
            </button>
          </div>
        </nav>
      )}
      {reversing && (
        <ReasonDialog
          title={t('acc.j.reverseTitle', { no: reversing.entryNo })}
          description={t('acc.j.reverseBody')}
          confirmLabel={t('acc.j.reverse')}
          onClose={() => setReversing(null)}
          onConfirm={async (reason) => {
            await accountingService.reverseJournal(reversing.id, reason);
            toast.success(t('acc.j.reversedOk'));
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

// ─── Chart of accounts ──────────────────────────────────────────────────────

function Accounts({
  settings,
  accounts,
  onChanged,
}: {
  settings: AccountingSettings;
  accounts: GlAccount[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<AccountType>('expense');
  const [error, setError] = useState('');

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await accountingService.createAccount(code.trim(), name.trim(), type);
      toast.success(t('acc.a.created'));
      setCode('');
      setName('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('erp.error.generic'));
    }
  };

  const toggle = async (a: GlAccount) => {
    try {
      await accountingService.setAccountActive(a.id, !a.active);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('erp.error.generic'));
    }
  };

  return (
    <div className="space-y-4">
      {settings.canPost && (
        <form onSubmit={add} className={`${card} p-4 flex flex-wrap items-end gap-2`}>
          <label className="text-[0.72rem] text-muted-foreground">
            {t('acc.a.code')}
            <input
              required
              pattern="[0-9A-Za-z.\-]{1,20}"
              maxLength={20}
              className={`${inputCls} block mt-1 w-24`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <label className="text-[0.72rem] text-muted-foreground flex-1 min-w-[180px]">
            {t('acc.a.name')}
            <input
              required
              maxLength={120}
              className={`${inputCls} block mt-1 w-full`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="text-[0.72rem] text-muted-foreground">
            {t('acc.a.type')}
            <select
              className={`${inputCls} block mt-1`}
              value={type}
              onChange={(e) => setType(e.target.value as AccountType)}
            >
              {ACCOUNT_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {t(`acc.type.${ty}`)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="flex items-center gap-1 px-3 py-2 rounded-lg text-[0.78rem] font-medium bg-primary text-primary-foreground"
          >
            <Plus size={12} /> {t('acc.a.add')}
          </button>
          {error && (
            <p className="w-full text-[0.75rem] text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full">
          <thead className="border-b border-border">
            <tr>
              <th className={th}>{t('acc.a.code')}</th>
              <th className={th}>{t('acc.a.name')}</th>
              <th className={th}>{t('acc.a.type')}</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr
                key={a.id}
                className={`border-b border-border last:border-b-0 ${a.active ? '' : 'opacity-60'}`}
              >
                <td className={`${td} tabular-nums`}>{a.code}</td>
                <td className={td}>
                  {accountName(a, t)}
                  {a.systemKey && (
                    <span className="ml-2 text-[0.65rem] text-muted-foreground">
                      {t('acc.a.system')}
                    </span>
                  )}
                </td>
                <td className={`${td} text-muted-foreground`}>{t(`acc.type.${a.type}`)}</td>
                <td className={`${td} text-right`}>
                  {settings.canPost && !a.systemKey ? (
                    <button
                      type="button"
                      onClick={() => toggle(a)}
                      className="text-[0.7rem] text-muted-foreground hover:text-foreground underline underline-offset-2"
                    >
                      {a.active ? t('acc.a.deactivate') : t('acc.a.activate')}
                    </button>
                  ) : (
                    <span className="text-[0.7rem] text-muted-foreground">
                      {a.active ? t('acc.a.active') : t('acc.a.inactive')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

function SettingsTab({ settings, onSaved }: { settings: AccountingSettings; onSaved: () => void }) {
  const { t, fmt, setCurrency } = useI18n();
  const { settings: currencySettings } = useCurrencySettings();
  const baseEditable = Boolean(currencySettings?.canChangeBase && !currencySettings.locked);
  const [currency, setCurrencyValue] = useState(settings.baseCurrency);
  const [lockDate, setLockDate] = useState(settings.lockDate ?? '');
  const [taxRate, setTaxRate] = useState(String(settings.salesTaxRate));
  const [purchaseRate, setPurchaseRate] = useState(String(settings.purchaseTaxRate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const options = CURRENCIES.includes(settings.baseCurrency)
    ? CURRENCIES
    : [settings.baseCurrency, ...CURRENCIES];

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await accountingService.saveSettings(currency, lockDate || null, Number(taxRate) || 0);
      if ((Number(purchaseRate) || 0) !== settings.purchaseTaxRate)
        await accountingService.savePurchaseTaxRate(Number(purchaseRate) || 0);
      setCurrency(currency);
      toast.success(t('acc.s.saved'));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('erp.error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className={`${card} p-5 space-y-4 max-w-xl`}>
      <fieldset disabled={!settings.canManage || busy} className="space-y-4">
        <div>
          <label htmlFor="acc-currency" className="block text-[0.8rem] font-medium text-foreground">
            {t('acc.s.currency')}
          </label>
          <select
            id="acc-currency"
            className={`${inputCls} mt-1`}
            value={currency}
            disabled={!baseEditable}
            onChange={(e) => setCurrencyValue(e.target.value)}
          >
            {options.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <p className="text-[0.72rem] text-muted-foreground mt-1">
            {t('acc.s.currencyDesc')}{' '}
            <a
              href="/erp/settings#currencies"
              className="text-primary underline underline-offset-2"
            >
              {t('acc.s.currencyManaged')}
            </a>
          </p>
        </div>
        <div>
          <label htmlFor="acc-tax" className="block text-[0.8rem] font-medium text-foreground">
            {t('tax.defaultRate')}
          </label>
          <input
            id="acc-tax"
            type="number"
            min={0}
            max={100}
            step="0.01"
            className={`${inputCls} mt-1 w-28`}
            value={taxRate}
            onChange={(e) => setTaxRate(e.target.value)}
          />
          <p className="text-[0.72rem] text-muted-foreground mt-1">{t('tax.defaultRateDesc')}</p>
        </div>
        <div>
          <label htmlFor="acc-ptax" className="block text-[0.8rem] font-medium text-foreground">
            {t('tax.purchaseRate')}
          </label>
          <input
            id="acc-ptax"
            type="number"
            min={0}
            max={100}
            step="0.01"
            className={`${inputCls} mt-1 w-28`}
            value={purchaseRate}
            onChange={(e) => setPurchaseRate(e.target.value)}
          />
          <p className="text-[0.72rem] text-muted-foreground mt-1">{t('tax.purchaseRateDesc')}</p>
        </div>
        <div>
          <label htmlFor="acc-lock" className="block text-[0.8rem] font-medium text-foreground">
            {t('acc.s.lockDate')}
          </label>
          <input
            id="acc-lock"
            type="date"
            max={iso(new Date())}
            className={`${inputCls} mt-1`}
            value={lockDate}
            onChange={(e) => setLockDate(e.target.value)}
          />
          <p className="text-[0.72rem] text-muted-foreground mt-1">
            {settings.lockDate ? fmt.date(settings.lockDate) : t('acc.s.notLocked')} —{' '}
            {t('acc.s.lockDesc')}
          </p>
        </div>
      </fieldset>
      {!settings.canManage && (
        <p className="text-[0.72rem] text-muted-foreground">{t('acc.s.noPermission')}</p>
      )}
      {error && (
        <p className="text-[0.75rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {settings.canManage && (
        <button
          type="submit"
          disabled={busy}
          className="px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
        >
          {t('acc.s.save')}
        </button>
      )}
    </form>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function AccountingPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('reports');
  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [error, setError] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const linkedAccount = useQueryParam('account');
  const linkedEntry = useQueryParam('entry');
  const linkedDate = useQueryParam('date');
  const focus =
    linkedEntry && linkedDate && /^\d{4}-\d{2}-\d{2}$/.test(linkedDate)
      ? { entryId: linkedEntry, date: linkedDate }
      : null;
  useEffect(() => {
    if (linkedAccount) setAccountFilter(linkedAccount);
    if (linkedAccount || focus) setTab('journal');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedAccount, linkedEntry, linkedDate]);

  const load = useCallback(async () => {
    try {
      const s = await accountingService.settings();
      setSettings(s);
      setAccounts(await accountingService.accounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : t('erp.error.generic'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const tabs: Tab[] = ['reports', 'journal', 'accounts', 'settings'];

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <Landmark size={20} className="text-foreground mt-1" />
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('acc.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground">{t('acc.subtitle')}</p>
        </div>
      </div>
      <div className="flex gap-1 border-b border-border max-lg:flex-wrap" role="tablist">
        {tabs.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`px-3 py-2 text-[0.8rem] border-b-2 -mb-px ${tab === id ? 'border-foreground text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(`acc.tab.${id}`)}
          </button>
        ))}
      </div>
      {error && <p className="text-[0.8rem] text-red-600 dark:text-red-400">{error}</p>}
      {!settings && !error && (
        <p className="text-[0.8rem] text-muted-foreground">{t('acc.loading')}</p>
      )}
      {settings && tab === 'reports' && (
        <Reports
          onViewAccount={(id) => {
            setAccountFilter(id);
            setTab('journal');
          }}
        />
      )}
      {settings && tab === 'journal' && (
        <Journal
          key={focus?.entryId ?? 'journal'}
          settings={settings}
          accounts={accounts}
          accountFilter={accountFilter}
          setAccountFilter={setAccountFilter}
          focus={focus}
        />
      )}
      {settings && tab === 'accounts' && (
        <Accounts settings={settings} accounts={accounts} onChanged={load} />
      )}
      {settings && tab === 'settings' && <SettingsTab settings={settings} onSaved={load} />}
    </div>
  );
}
