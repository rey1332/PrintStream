'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  BANK_FORMATS,
  parseStatement,
  type BankFormat,
  type ColumnMap,
  type DateOrder,
  type ParseResult,
} from '@/lib/finance/bankCsv';
import {
  Dialog,
  DialogButtons,
  Field,
  FormError,
  errorKey,
  inputCls,
  todayIso,
} from '../components/moduleUi';
import { accountingService, type GlAccount } from '../lib/accountingService';
import {
  financeService,
  type BankLine,
  type CashAccount,
  type LedgerCandidate,
} from '../lib/financeService';

export function AccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account: CashAccount | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(account?.name ?? '');
  const [kind, setKind] = useState<'cash' | 'bank'>(account?.kind ?? 'bank');
  const [bankName, setBankName] = useState(account?.bankName ?? '');
  const [accountNo, setAccountNo] = useState(account?.accountNo ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t('fin.err.name'));
    setBusy(true);
    setError('');
    try {
      if (account) await financeService.updateAccount(account.id, { name, bankName, accountNo });
      else await financeService.createAccount({ name, kind, bankName, accountNo });
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t(account ? 'fin.acc.edit' : 'fin.acc.new')} onClose={onClose} onSubmit={submit}>
      <Field label={t('fin.acc.name')} hint={t('fin.acc.nameHint')}>
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoFocus
        />
      </Field>
      {!account && (
        <Field label={t('fin.acc.kind')}>
          <select
            className={inputCls}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'cash' | 'bank')}
          >
            <option value="bank">{t('fin.kind.bank')}</option>
            <option value="cash">{t('fin.kind.cash')}</option>
          </select>
        </Field>
      )}
      {kind === 'bank' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('fin.acc.bankName')}>
            <input
              className={inputCls}
              value={bankName}
              onChange={(e) => setBankName(e.target.value)}
              maxLength={60}
            />
          </Field>
          <Field label={t('fin.acc.accountNo')}>
            <input
              className={inputCls}
              value={accountNo}
              onChange={(e) => setAccountNo(e.target.value)}
              maxLength={40}
              inputMode="numeric"
            />
          </Field>
        </div>
      )}
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('common.save')} onCancel={onClose} />
    </Dialog>
  );
}

export function TransferDialog({
  accounts,
  onClose,
  onSaved,
}: {
  accounts: CashAccount[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  const [from, setFrom] = useState(
    accounts.find((a) => a.kind === 'bank')?.id ?? accounts[0]?.id ?? ''
  );
  const [to, setTo] = useState(accounts.find((a) => a.id !== from)?.id ?? '');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const source = accounts.find((a) => a.id === from);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(amount);
    if (from === to) return setError(t('fin.err.same'));
    if (!(value > 0)) return setError(t('fin.err.amount'));
    setBusy(true);
    setError('');
    try {
      await financeService.transfer(from, to, value, date, memo);
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t('fin.transfer.new')} onClose={onClose} onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('fin.transfer.from')}
          hint={
            source ? t('fin.transfer.balance', { amount: fmt.money(source.balance) }) : undefined
          }
        >
          <select className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fin.transfer.to')}>
          <select className={inputCls} value={to} onChange={(e) => setTo(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id} disabled={a.id === from}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fin.col.amount')}>
          <input
            className={inputCls}
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label={t('fin.col.date')}>
          <input
            className={inputCls}
            type="date"
            max={todayIso()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label={t('fin.transfer.memo')} wide>
          <input
            className={inputCls}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={300}
            placeholder={t('fin.transfer.memoHint')}
          />
        </Field>
      </div>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('fin.transfer.save')} onCancel={onClose} />
    </Dialog>
  );
}

// ─── Statement import ────────────────────────────────────────────────────────

type MapKey =
  | 'date'
  | 'description'
  | 'reference'
  | 'amount'
  | 'dc'
  | 'debit'
  | 'credit'
  | 'balance';
const MAP_KEYS: MapKey[] = [
  'date',
  'description',
  'reference',
  'amount',
  'dc',
  'debit',
  'credit',
  'balance',
];

/** The file as text: UTF-8, or Windows-1252 when it is not valid UTF-8 (older bank exports). */
async function readText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const columnName = (
  headers: string[],
  i: number,
  t: (k: MessageKey, v?: Record<string, string | number>) => string
) => (headers[i] ? headers[i] : t('fin.import.column', { n: i + 1 }));

export function ImportDialog({
  account,
  onClose,
  onImported,
}: {
  account: CashAccount;
  onClose: () => void;
  onImported: (imported: number, duplicates: number) => void;
}) {
  const { t, fmt } = useI18n();
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [format, setFormat] = useState<BankFormat | 'auto'>('auto');
  const [dateOrder, setDateOrder] = useState<DateOrder>('dmy');
  const [headerRow, setHeaderRow] = useState<number | null>(null);
  const [map, setMap] = useState<ColumnMap | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const result: ParseResult | null = useMemo(
    () =>
      text
        ? parseStatement(text, {
            format,
            dateOrder,
            ...(headerRow === null ? {} : { headerRow }),
            ...(map ? { map } : {}),
          })
        : null,
    [text, format, dateOrder, headerRow, map]
  );
  // The columns found in the file become the starting point for choosing by hand.
  useEffect(() => {
    if (result && !map && result.map) setMap(result.map);
  }, [result, map]);

  const width = useMemo(
    () => Math.max(0, ...(result?.rows ?? []).slice(0, 80).map((r) => r.length)),
    [result]
  );
  const headers = result?.headers ?? [];
  const total = result?.lines.reduce((s, l) => s + l.amount, 0) ?? 0;

  async function choose(file: File | undefined) {
    setError('');
    setMap(null);
    setHeaderRow(null);
    if (!file) return;
    if (file.size > 5_000_000) return setError(t('fin.err.fileSize'));
    setFileName(file.name);
    setText(await readText(file));
  }

  function setColumn(key: MapKey, value: string) {
    const base: ColumnMap = map ?? {
      date: 0,
      description: [],
      reference: null,
      amount: null,
      dc: null,
      debit: null,
      credit: null,
      balance: null,
    };
    const i = value === '' ? null : Number(value);
    if (key === 'date') setMap({ ...base, date: i ?? 0 });
    else if (key === 'description') setMap({ ...base, description: i === null ? [] : [i] });
    else setMap({ ...base, [key]: i });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!result || !result.lines.length) return setError(t('fin.err.empty'));
    if (result.lines.length > 5000) return setError(t('fin.err.tooMany'));
    setBusy(true);
    setError('');
    try {
      const r = await financeService.importStatement(account.id, {
        fileName,
        format: result.format,
        opening: result.opening,
        closing: result.closing,
        lines: result.lines,
      });
      onImported(r.imported, r.duplicates);
    } catch (err) {
      setError(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  const value = (key: MapKey): string => {
    if (!map) return '';
    const v = key === 'description' ? map.description[0] : map[key];
    return v === null || v === undefined ? '' : String(v);
  };

  return (
    <Dialog
      title={t('fin.import.title', { account: account.name })}
      onClose={onClose}
      onSubmit={submit}
      wide
    >
      <p className="text-[0.75rem] text-muted-foreground">{t('fin.import.intro')}</p>
      <Field label={t('fin.import.file')}>
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className={inputCls}
          onChange={(e) => choose(e.target.files?.[0])}
        />
      </Field>
      {result && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('fin.import.format')}>
              <select
                className={inputCls}
                value={format}
                onChange={(e) => setFormat(e.target.value as BankFormat | 'auto')}
              >
                <option value="auto">
                  {t('fin.import.auto', { bank: t(`fin.format.${result.format}` as MessageKey) })}
                </option>
                {BANK_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {t(`fin.format.${f}` as MessageKey)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('fin.import.dateOrder')}>
              <select
                className={inputCls}
                value={dateOrder}
                onChange={(e) => setDateOrder(e.target.value as DateOrder)}
              >
                <option value="dmy">{t('fin.import.dmy')}</option>
                <option value="mdy">{t('fin.import.mdy')}</option>
              </select>
            </Field>
            <Field label={t('fin.import.headerRow')} hint={t('fin.import.headerRowHint')}>
              <input
                type="number"
                min={0}
                className={inputCls}
                value={headerRow === null ? result.headerRow + 1 : headerRow + 1}
                onChange={(e) => setHeaderRow(Math.max(-1, Number(e.target.value) - 1))}
              />
            </Field>
          </div>
          <details open={!result.map || !result.lines.length}>
            <summary className="cursor-pointer text-[0.78rem] text-foreground">
              {t('fin.import.columns')}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-4">
              {MAP_KEYS.map((key) => (
                <Field key={key} label={t(`fin.map.${key}` as MessageKey)}>
                  <select
                    className={inputCls}
                    value={value(key)}
                    onChange={(e) => setColumn(key, e.target.value)}
                  >
                    {key !== 'date' && <option value="">—</option>}
                    {Array.from({ length: width }, (_, i) => (
                      <option key={i} value={i}>
                        {columnName(headers, i, t)}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <p className="mt-1 text-[0.68rem] text-muted-foreground">
              {t('fin.import.columnsHint')}
            </p>
          </details>
          <div className="rounded-lg border border-border">
            <div className="flex flex-wrap justify-between gap-2 border-b border-border px-3 py-2 text-[0.75rem]">
              <span>{t('fin.import.found', { n: result.lines.length })}</span>
              <span className="tabular-nums text-muted-foreground">
                {t('fin.import.net', { amount: fmt.money(total) })}
                {result.closing !== null &&
                  ` · ${t('fin.import.closing', { amount: fmt.money(result.closing) })}`}
              </span>
            </div>
            <div className="max-h-56 overflow-auto">
              <table className="w-full text-[0.75rem]">
                <tbody>
                  {result.lines.slice(0, 12).map((l) => (
                    <tr key={l.row} className="border-t border-border first:border-t-0">
                      <td className="px-3 py-1.5 whitespace-nowrap">{fmt.date(l.date)}</td>
                      <td className="px-3 py-1.5">{l.description}</td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums ${l.amount < 0 ? 'text-red-600 dark:text-red-400' : ''}`}
                      >
                        {fmt.money(l.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {result.problems.length > 0 && (
            <p className="text-[0.72rem] text-amber-700 dark:text-amber-300">
              {t('fin.import.problems', {
                n: result.problems.length,
                rows: result.problems
                  .slice(0, 8)
                  .map((p) => p.row)
                  .join(', '),
              })}
              {result.problems.some((p) => p.kind === 'pending') && ` ${t('fin.import.pending')}`}
            </p>
          )}
        </>
      )}
      <FormError text={error} />
      <DialogButtons
        busy={busy}
        disabled={!result?.lines.length}
        label={t('fin.import.save')}
        onCancel={onClose}
      />
    </Dialog>
  );
}

// ─── Matching ────────────────────────────────────────────────────────────────

const SOURCE_LABEL = (source: string): MessageKey => `acc.src.${source}` as MessageKey;

export function MatchDialog({
  line,
  onClose,
  onMatched,
}: {
  line: BankLine;
  onClose: () => void;
  onMatched: () => void;
}) {
  const { t, fmt } = useI18n();
  const [candidates, setCandidates] = useState<LedgerCandidate[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    financeService
      .candidates(line.id)
      .then((list) => {
        setCandidates(list);
        setChosen(list[0]?.journalLineId ?? '');
      })
      .catch((err) => setError(t(errorKey(err, 'fin.err.failed'))));
  }, [line.id, t]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    setBusy(true);
    setError('');
    try {
      await financeService.match(line.id, chosen);
      onMatched();
    } catch (err) {
      setError(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t('fin.rec.matchTitle')} onClose={onClose} onSubmit={submit}>
      <p className="text-[0.78rem] text-foreground">
        {fmt.date(line.date)} · {line.description} ·{' '}
        <span className="font-medium tabular-nums">{fmt.money(line.amount)}</span>
      </p>
      {candidates === null && !error && (
        <p className="text-[0.75rem] text-muted-foreground">{t('common.loading')}</p>
      )}
      {candidates?.length === 0 && (
        <p className="text-[0.75rem] text-muted-foreground">{t('fin.rec.noCandidates')}</p>
      )}
      {!!candidates?.length && (
        <fieldset className="space-y-1">
          <legend className="mb-1 text-[0.7rem] text-muted-foreground">
            {t('fin.rec.candidates')}
          </legend>
          {candidates.map((c) => (
            <label
              key={c.journalLineId}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-[0.78rem]"
            >
              <input
                type="radio"
                name="candidate"
                className="mt-0.5"
                checked={chosen === c.journalLineId}
                onChange={() => setChosen(c.journalLineId)}
              />
              <span className="flex-1">
                <span className="block text-foreground">{c.memo}</span>
                <span className="block text-[0.7rem] text-muted-foreground">
                  #{c.entryNo} · {fmt.date(c.date)} · {t(SOURCE_LABEL(c.sourceType))}
                  {c.daysApart > 0 && ` · ${t('fin.rec.daysApart', { n: c.daysApart })}`}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <FormError text={error} />
      <DialogButtons busy={busy} disabled={!chosen} label={t('fin.rec.match')} onCancel={onClose} />
    </Dialog>
  );
}

export function PostLineDialog({
  line,
  onClose,
  onPosted,
}: {
  line: BankLine;
  onClose: () => void;
  onPosted: () => void;
}) {
  const { t, fmt } = useI18n();
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState(line.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    accountingService
      .accounts()
      .then((list) => {
        const usable = list.filter((a) => a.active);
        setAccounts(usable);
        // Money out is usually a bank charge; money in, interest or other income.
        const preferred =
          line.amount < 0
            ? (usable.find((a) => a.systemKey === 'bank_charges') ??
              usable.find((a) => a.systemKey === 'expenses'))
            : usable.find((a) => a.systemKey === 'other_income');
        setAccountId(preferred?.id ?? '');
      })
      .catch((err) => setError(t(errorKey(err, 'fin.err.failed'))));
  }, [line.amount, t]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId) return setError(t('fin.err.account'));
    setBusy(true);
    setError('');
    try {
      await financeService.postLine(line.id, accountId, memo);
      onPosted();
    } catch (err) {
      setError(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t('fin.rec.postTitle')} onClose={onClose} onSubmit={submit}>
      <p className="text-[0.78rem] text-foreground">
        {fmt.date(line.date)} ·{' '}
        <span className="font-medium tabular-nums">{fmt.money(line.amount)}</span>
      </p>
      <p className="text-[0.72rem] text-muted-foreground">
        {t(line.amount < 0 ? 'fin.rec.postOut' : 'fin.rec.postIn')}
      </p>
      <Field label={t('fin.rec.counterAccount')}>
        <select
          className={inputCls}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">—</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('fin.transfer.memo')}>
        <input
          className={inputCls}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={300}
        />
      </Field>
      <FormError text={error} />
      <DialogButtons
        busy={busy}
        disabled={!accountId}
        label={t('fin.rec.post')}
        onCancel={onClose}
      />
    </Dialog>
  );
}
