'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  Check,
  Link2,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../lib/WorkspaceContext';
import { errorKey, inputCls } from '../components/moduleUi';
import { ReasonDialog } from '../components/ReasonDialog';
import {
  financeService,
  type BankLine,
  type CashAccount,
  type CashTransfer,
  type LedgerCandidate,
  type LineStatus,
  type Reconciliation,
} from '../lib/financeService';
import {
  AccountDialog,
  ImportDialog,
  MatchDialog,
  PostLineDialog,
  TransferDialog,
} from './dialogs';

type Tab = 'accounts' | 'reconcile' | 'transfers';

const monthStart = (offset = 0) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
};
const monthEnd = (start: string) => {
  const d = new Date(`${start}T00:00:00`);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const thCls = 'px-3 py-2 text-left font-medium';
const tdCls = 'px-3 py-2';
const btnCls =
  'inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[0.78rem] text-foreground hover:bg-muted disabled:opacity-50 max-lg:min-h-10';
const primaryCls =
  'inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-10';
const iconBtn = 'p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40';

export default function CashBankPage() {
  const { t } = useI18n();
  const { can } = useWorkspace();
  const [tab, setTab] = useState<Tab>('accounts');
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [reconcileId, setReconcileId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await financeService.accounts());
    } catch (err) {
      toast.error(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    load();
  }, [load]);

  const tabs: { key: Tab; label: MessageKey }[] = [
    { key: 'accounts', label: 'fin.tab.accounts' },
    { key: 'reconcile', label: 'fin.tab.reconcile' },
    { key: 'transfers', label: 'fin.tab.transfers' },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[1.25rem] font-semibold text-foreground">{t('fin.title')}</h1>
        <p className="text-[0.8rem] text-muted-foreground">{t('fin.subtitle')}</p>
      </header>
      <nav className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {tabs.map((x) => (
          <button
            key={x.key}
            role="tab"
            aria-selected={tab === x.key}
            onClick={() => setTab(x.key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[0.8rem] ${
              tab === x.key
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground'
            }`}
          >
            {t(x.label)}
          </button>
        ))}
      </nav>
      {tab === 'accounts' && (
        <AccountsTab
          accounts={accounts}
          loading={loading}
          canManage={can('payments')}
          reload={load}
          onReconcile={(id) => {
            setReconcileId(id);
            setTab('reconcile');
          }}
        />
      )}
      {tab === 'reconcile' && (
        <ReconcileTab
          accounts={accounts.filter((a) => a.active)}
          accountId={reconcileId}
          setAccountId={setReconcileId}
          canManage={can('payments')}
          reloadAccounts={load}
        />
      )}
      {tab === 'transfers' && (
        <TransfersTab accounts={accounts} canManage={can('payments')} reloadAccounts={load} />
      )}
    </div>
  );
}

// ─── Accounts ────────────────────────────────────────────────────────────────

function AccountsTab({
  accounts,
  loading,
  canManage,
  reload,
  onReconcile,
}: {
  accounts: CashAccount[];
  loading: boolean;
  canManage: boolean;
  reload: () => Promise<void>;
  onReconcile: (id: string) => void;
}) {
  const { t, fmt } = useI18n();
  const [editing, setEditing] = useState<CashAccount | 'new' | null>(null);
  const [transferring, setTransferring] = useState(false);
  const total = accounts.filter((a) => a.active).reduce((s, a) => s + a.balance, 0);

  async function setActive(a: CashAccount, active: boolean) {
    try {
      await financeService.updateAccount(a.id, { active });
      toast.success(t(active ? 'fin.acc.reopened' : 'fin.acc.closed'));
      await reload();
    } catch (err) {
      toast.error(t(errorKey(err, 'fin.err.failed')));
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.8rem] text-muted-foreground">
          {t('fin.acc.total')}{' '}
          <span className="font-semibold tabular-nums text-foreground">{fmt.money(total)}</span>
        </p>
        {canManage && (
          <div className="flex gap-2">
            <button
              className={btnCls}
              onClick={() => setTransferring(true)}
              disabled={accounts.filter((a) => a.active).length < 2}
            >
              <ArrowLeftRight size={14} /> {t('fin.transfer.new')}
            </button>
            <button className={primaryCls} onClick={() => setEditing('new')}>
              <Plus size={14} /> {t('fin.acc.new')}
            </button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[0.8rem]">
          <thead className="bg-muted/40 text-[0.72rem] text-muted-foreground">
            <tr>
              <th className={thCls}>{t('fin.col.account')}</th>
              <th className={`${thCls} max-sm:hidden`}>{t('fin.col.bank')}</th>
              <th className={`${thCls} max-sm:hidden`}>{t('fin.col.code')}</th>
              <th className={`${thCls} text-right`}>{t('fin.col.balance')}</th>
              <th className={`${thCls} max-md:hidden`}>{t('fin.col.statement')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className={`${tdCls} text-muted-foreground`}>
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {accounts.map((a) => (
              <tr key={a.id} className={`border-t border-border ${a.active ? '' : 'opacity-60'}`}>
                <td className={tdCls}>
                  <div className="font-medium text-foreground">{a.name}</div>
                  <div className="text-[0.7rem] text-muted-foreground">
                    {t(a.kind === 'bank' ? 'fin.kind.bank' : 'fin.kind.cash')}
                    {a.isDefault && ` · ${t('fin.acc.default')}`}
                    {!a.active && ` · ${t('fin.acc.inactive')}`}
                  </div>
                  {a.bankName && (
                    <div className="text-[0.7rem] text-muted-foreground sm:hidden">
                      {[a.bankName, a.accountNo].filter(Boolean).join(' ')}
                    </div>
                  )}
                </td>
                <td className={`${tdCls} max-sm:hidden`}>
                  {a.bankName || '—'}
                  {a.accountNo && (
                    <div className="text-[0.7rem] text-muted-foreground">{a.accountNo}</div>
                  )}
                </td>
                <td className={`${tdCls} tabular-nums max-sm:hidden`}>{a.glCode}</td>
                <td className={`${tdCls} text-right font-medium tabular-nums`}>
                  {fmt.money(a.balance)}
                </td>
                <td className={`${tdCls} max-md:hidden`}>
                  {a.lastStatementDate ? fmt.date(a.lastStatementDate) : '—'}
                  {a.openLines > 0 && (
                    <div className="text-[0.7rem] text-amber-600 dark:text-amber-400">
                      {t('fin.acc.openLines', { n: a.openLines })}
                    </div>
                  )}
                </td>
                <td className={`${tdCls} whitespace-nowrap text-right`}>
                  {a.active && (
                    <button
                      className={iconBtn}
                      title={t('fin.tab.reconcile')}
                      aria-label={t('fin.tab.reconcile')}
                      onClick={() => onReconcile(a.id)}
                    >
                      <Link2 size={15} />
                    </button>
                  )}
                  {canManage && (
                    <>
                      <button
                        className={iconBtn}
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                        onClick={() => setEditing(a)}
                      >
                        <Pencil size={15} />
                      </button>
                      {!a.isDefault && (
                        <button
                          className={iconBtn}
                          title={t(a.active ? 'fin.acc.close' : 'fin.acc.reopen')}
                          aria-label={t(a.active ? 'fin.acc.close' : 'fin.acc.reopen')}
                          onClick={() => setActive(a, !a.active)}
                        >
                          {a.active ? <X size={15} /> : <RotateCcw size={15} />}
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[0.72rem] text-muted-foreground">{t('fin.acc.help')}</p>
      {editing && (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toast.success(t('common.saved'));
            await reload();
          }}
        />
      )}
      {transferring && (
        <TransferDialog
          accounts={accounts.filter((a) => a.active)}
          onClose={() => setTransferring(false)}
          onSaved={async () => {
            setTransferring(false);
            toast.success(t('fin.transfer.saved'));
            await reload();
          }}
        />
      )}
    </section>
  );
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

const STATUS_FILTERS: (LineStatus | 'all')[] = ['open', 'all', 'matched', 'ignored'];

function ReconcileTab({
  accounts,
  accountId,
  setAccountId,
  canManage,
  reloadAccounts,
}: {
  accounts: CashAccount[];
  accountId: string | null;
  setAccountId: (id: string) => void;
  canManage: boolean;
  reloadAccounts: () => Promise<void>;
}) {
  const { t, fmt } = useI18n();
  const banks = useMemo(
    () => [...accounts].sort((a, b) => Number(b.kind === 'bank') - Number(a.kind === 'bank')),
    [accounts]
  );
  const account = banks.find((a) => a.id === accountId) ?? banks[0] ?? null;
  const [month, setMonth] = useState(monthStart());
  const [status, setStatus] = useState<LineStatus | 'all'>('open');
  const [lines, setLines] = useState<BankLine[]>([]);
  const [summary, setSummary] = useState<Reconciliation | null>(null);
  const [bookOnly, setBookOnly] = useState<LedgerCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState<BankLine | null>(null);
  const [posting, setPosting] = useState<BankLine | null>(null);
  const [ignoring, setIgnoring] = useState<BankLine | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    try {
      const end = monthEnd(month);
      const [l, s, b] = await Promise.all([
        financeService.lines(account.id, month, end, status),
        financeService.reconciliation(account.id, end),
        financeService.unmatchedLedger(account.id, month, end),
      ]);
      setLines(l);
      setSummary(s);
      setBookOnly(b);
    } catch (err) {
      toast.error(t(errorKey(err, 'fin.err.failed')));
    }
  }, [account, month, status, t]);
  useEffect(() => {
    load();
  }, [load]);

  async function act(work: () => Promise<unknown>, done?: MessageKey) {
    setBusy(true);
    try {
      await work();
      if (done) toast.success(t(done));
      await Promise.all([load(), reloadAccounts()]);
    } catch (err) {
      toast.error(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  if (!account)
    return <p className="text-[0.8rem] text-muted-foreground">{t('fin.rec.noAccount')}</p>;

  const reconciled = summary?.difference === 0 && summary.openLines === 0;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-[0.75rem] text-muted-foreground">
          {t('fin.col.account')}
          <select
            className={`${inputCls} mt-1 w-56`}
            value={account.id}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {banks.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[0.75rem] text-muted-foreground">
          {t('tax.month')}
          <input
            type="month"
            className={`${inputCls} mt-1 w-44`}
            value={month.slice(0, 7)}
            onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)}
          />
        </label>
        {canManage && (
          <div className="ml-auto flex gap-2">
            <button
              className={btnCls}
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const n = await financeService.autoMatch(account.id);
                  toast.success(t('fin.rec.autoMatched', { n }));
                })
              }
            >
              <Sparkles size={14} /> {t('fin.rec.autoMatch')}
            </button>
            <button className={primaryCls} onClick={() => setImporting(true)}>
              <Upload size={14} /> {t('fin.rec.import')}
            </button>
          </div>
        )}
      </div>

      {summary && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={t('fin.rec.bank')}
            value={summary.bankBalance === null ? '—' : fmt.money(summary.bankBalance)}
            hint={
              summary.bankBalanceDate
                ? t('fin.rec.asOf', { date: fmt.date(summary.bankBalanceDate) })
                : t('fin.rec.noBalance')
            }
          />
          <Stat
            label={t('fin.rec.ledger')}
            value={fmt.money(summary.ledgerBalance)}
            hint={t('fin.rec.asOf', { date: fmt.date(summary.asOf) })}
          />
          <Stat
            label={t('fin.rec.open')}
            value={fmt.money(summary.openLinesTotal)}
            hint={t('fin.rec.openHint', { n: summary.openLines })}
          />
          <Stat
            label={t('fin.rec.difference')}
            value={summary.difference === null ? '—' : fmt.money(summary.difference)}
            hint={reconciled ? t('fin.rec.reconciled') : t('fin.rec.differenceHint')}
            tone={
              summary.difference === null ? undefined : summary.difference === 0 ? 'good' : 'bad'
            }
          />
        </div>
      )}

      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={t('fin.rec.filter')}>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 text-[0.72rem] ${
              status === s
                ? 'border-foreground text-foreground'
                : 'border-border text-muted-foreground'
            }`}
          >
            {t(`fin.status.${s}` as MessageKey)}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[0.8rem]">
          <thead className="bg-muted/40 text-[0.72rem] text-muted-foreground">
            <tr>
              <th className={thCls}>{t('fin.col.date')}</th>
              <th className={thCls}>{t('fin.col.description')}</th>
              <th className={`${thCls} text-right`}>{t('fin.col.in')}</th>
              <th className={`${thCls} text-right`}>{t('fin.col.out')}</th>
              <th className={`${thCls} text-right`}>{t('fin.col.bankBalance')}</th>
              <th className={thCls}>{t('fin.col.status')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {!lines.length && (
              <tr>
                <td colSpan={7} className={`${tdCls} text-muted-foreground`}>
                  {t('fin.rec.noLines')}
                </td>
              </tr>
            )}
            {lines.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className={`${tdCls} whitespace-nowrap`}>{fmt.date(l.date)}</td>
                <td className={tdCls}>
                  <div className="max-w-[28rem] break-words">{l.description || '—'}</div>
                  {(l.reference || l.note) && (
                    <div className="text-[0.7rem] text-muted-foreground">
                      {[l.reference, l.note].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </td>
                <td className={`${tdCls} text-right tabular-nums`}>
                  {l.amount > 0 ? fmt.money(l.amount) : ''}
                </td>
                <td className={`${tdCls} text-right tabular-nums`}>
                  {l.amount < 0 ? fmt.money(-l.amount) : ''}
                </td>
                <td className={`${tdCls} text-right tabular-nums text-muted-foreground`}>
                  {l.balance === null ? '' : fmt.money(l.balance)}
                </td>
                <td className={tdCls}>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[0.68rem] ${
                      l.status === 'matched'
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : l.status === 'ignored'
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                    }`}
                  >
                    {t(`fin.status.${l.status}` as MessageKey)}
                  </span>
                </td>
                <td className={`${tdCls} whitespace-nowrap text-right`}>
                  {canManage && l.status === 'open' && (
                    <>
                      <button
                        className={iconBtn}
                        disabled={busy}
                        title={t('fin.rec.match')}
                        aria-label={t('fin.rec.match')}
                        onClick={() => setMatching(l)}
                      >
                        <Link2 size={15} />
                      </button>
                      <button
                        className={iconBtn}
                        disabled={busy}
                        title={t('fin.rec.post')}
                        aria-label={t('fin.rec.post')}
                        onClick={() => setPosting(l)}
                      >
                        <Check size={15} />
                      </button>
                      <button
                        className={iconBtn}
                        disabled={busy}
                        title={t('fin.rec.ignore')}
                        aria-label={t('fin.rec.ignore')}
                        onClick={() => setIgnoring(l)}
                      >
                        <X size={15} />
                      </button>
                    </>
                  )}
                  {canManage && l.status !== 'open' && (
                    <button
                      className={iconBtn}
                      disabled={busy}
                      title={t('fin.rec.unmatch')}
                      aria-label={t('fin.rec.unmatch')}
                      onClick={() => act(() => financeService.unmatch(l.id), 'fin.rec.unmatched')}
                    >
                      <Undo2 size={15} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {bookOnly.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-[0.85rem] font-semibold text-foreground">{t('fin.rec.bookOnly')}</h2>
          <p className="text-[0.72rem] text-muted-foreground">{t('fin.rec.bookOnlyHint')}</p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-[0.8rem]">
              <tbody>
                {bookOnly.map((b) => (
                  <tr key={b.journalLineId} className="border-t border-border first:border-t-0">
                    <td className={`${tdCls} whitespace-nowrap`}>{fmt.date(b.date)}</td>
                    <td className={`${tdCls} tabular-nums text-muted-foreground`}>#{b.entryNo}</td>
                    <td className={tdCls}>{b.memo}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{fmt.money(b.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {importing && (
        <ImportDialog
          account={account}
          onClose={() => setImporting(false)}
          onImported={async (imported, duplicates) => {
            setImporting(false);
            toast.success(t('fin.import.done', { n: imported, d: duplicates }));
            await act(async () => {
              const n = await financeService.autoMatch(account.id);
              if (n) toast.success(t('fin.rec.autoMatched', { n }));
            });
          }}
        />
      )}
      {matching && (
        <MatchDialog
          line={matching}
          onClose={() => setMatching(null)}
          onMatched={async () => {
            setMatching(null);
            toast.success(t('fin.rec.matched'));
            await Promise.all([load(), reloadAccounts()]);
          }}
        />
      )}
      {posting && (
        <PostLineDialog
          line={posting}
          onClose={() => setPosting(null)}
          onPosted={async () => {
            setPosting(null);
            toast.success(t('fin.rec.posted'));
            await Promise.all([load(), reloadAccounts()]);
          }}
        />
      )}
      {ignoring && (
        <ReasonDialog
          title={t('fin.rec.ignoreTitle')}
          description={t('fin.rec.ignoreHint')}
          confirmLabel={t('fin.rec.ignore')}
          onClose={() => setIgnoring(null)}
          onConfirm={async (reason) => {
            try {
              await financeService.ignore(ignoring.id, reason);
            } catch (err) {
              throw new Error(t(errorKey(err, 'fin.err.failed')));
            }
            setIgnoring(null);
            await load();
          }}
        />
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-[0.7rem] text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-[1.05rem] font-semibold tabular-nums ${
          tone === 'good'
            ? 'text-emerald-600 dark:text-emerald-400'
            : tone === 'bad'
              ? 'text-red-600 dark:text-red-400'
              : 'text-foreground'
        }`}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[0.68rem] text-muted-foreground">{hint}</div>
    </div>
  );
}

// ─── Transfers ───────────────────────────────────────────────────────────────

function TransfersTab({
  accounts,
  canManage,
  reloadAccounts,
}: {
  accounts: CashAccount[];
  canManage: boolean;
  reloadAccounts: () => Promise<void>;
}) {
  const { t, fmt } = useI18n();
  const [month, setMonth] = useState(monthStart());
  const [rows, setRows] = useState<CashTransfer[]>([]);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<CashTransfer | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await financeService.transfers(month, monthEnd(month)));
    } catch (err) {
      toast.error(t(errorKey(err, 'fin.err.failed')));
    }
  }, [month, t]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="text-[0.75rem] text-muted-foreground">
          {t('tax.month')}
          <input
            type="month"
            className={`${inputCls} mt-1 w-44`}
            value={month.slice(0, 7)}
            onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)}
          />
        </label>
        {canManage && (
          <button
            className={primaryCls}
            onClick={() => setAdding(true)}
            disabled={accounts.filter((a) => a.active).length < 2}
          >
            <ArrowLeftRight size={14} /> {t('fin.transfer.new')}
          </button>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[0.8rem]">
          <thead className="bg-muted/40 text-[0.72rem] text-muted-foreground">
            <tr>
              <th className={thCls}>{t('fin.col.date')}</th>
              <th className={thCls}>{t('fin.transfer.from')}</th>
              <th className={thCls}>{t('fin.transfer.to')}</th>
              <th className={thCls}>{t('fin.transfer.memo')}</th>
              <th className={`${thCls} text-right`}>{t('fin.col.amount')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {!rows.length && (
              <tr>
                <td colSpan={6} className={`${tdCls} text-muted-foreground`}>
                  {t('fin.transfer.none')}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.entryId}
                className={`border-t border-border ${r.voided ? 'opacity-50 line-through' : ''}`}
              >
                <td className={`${tdCls} whitespace-nowrap`}>{fmt.date(r.date)}</td>
                <td className={tdCls}>{r.from ?? '—'}</td>
                <td className={tdCls}>{r.to ?? '—'}</td>
                <td className={tdCls}>{r.memo}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{fmt.money(r.amount)}</td>
                <td className={`${tdCls} text-right`}>
                  {canManage && !r.voided && (
                    <button
                      className={iconBtn}
                      title={t('fin.transfer.void')}
                      aria-label={t('fin.transfer.void')}
                      onClick={() => setVoiding(r)}
                    >
                      <Undo2 size={15} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && (
        <TransferDialog
          accounts={accounts.filter((a) => a.active)}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            toast.success(t('fin.transfer.saved'));
            await Promise.all([load(), reloadAccounts()]);
          }}
        />
      )}
      {voiding && (
        <ReasonDialog
          title={t('fin.transfer.void')}
          description={t('fin.transfer.voidHint', { amount: fmt.money(voiding.amount) })}
          confirmLabel={t('fin.transfer.void')}
          required={false}
          onClose={() => setVoiding(null)}
          onConfirm={async () => {
            try {
              await financeService.voidTransfer(voiding.entryId);
            } catch (err) {
              throw new Error(t(errorKey(err, 'fin.err.failed')));
            }
            setVoiding(null);
            await Promise.all([load(), reloadAccounts()]);
          }}
        />
      )}
    </section>
  );
}
