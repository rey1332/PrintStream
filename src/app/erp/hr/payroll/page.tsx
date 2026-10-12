'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Loader2, Undo2, Wallet, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../../lib/WorkspaceContext';
import {
  HrError,
  currentMonthRange,
  hrService,
  type PayrollPreview,
  type PayrollRun,
  type PayrollSettings,
} from '../../lib/hrService';
import { PayrollRulesPanel } from './PayrollRulesPanel';

const inputCls =
  'rounded-lg border border-border bg-card px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

export default function PayrollPage() {
  const { t, fmt } = useI18n();
  const { active, hrReady } = useWorkspace();
  const [range, setRange] = useState(currentMonthRange);
  const [payDate, setPayDate] = useState(() => currentMonthRange().to);
  const [creditTo, setCreditTo] = useState<'cash' | 'payable'>('cash');
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [thr, setThr] = useState(false);
  const idRules = settings?.rules === 'id';
  const [preview, setPreview] = useState<PayrollPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reversing, setReversing] = useState<{ run: PayrollRun; reason: string } | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState('');

  const errorText = useCallback(
    (err: unknown) => t(err instanceof HrError ? err.key : 'hr.err.failed'),
    [t]
  );

  const loadPreview = useCallback(async () => {
    setPreviewError('');
    try {
      setPreview(await hrService.payrollPreview(range.from, range.to, thr && idRules, payDate));
    } catch (err) {
      setPreview(null);
      setPreviewError(errorText(err));
    }
  }, [range, thr, idRules, payDate, errorText]);

  useEffect(() => {
    if (!hrReady) return;
    hrService
      .payrollSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, [hrReady, active?.id]);

  const loadRuns = useCallback(async () => {
    try {
      setRuns(await hrService.payrollRuns());
    } catch {
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hrReady) return;
    void loadPreview();
  }, [hrReady, active?.id, loadPreview]);

  useEffect(() => {
    if (!hrReady) return;
    setLoading(true);
    void loadRuns();
  }, [hrReady, active?.id, loadRuns]);

  // What is paid out (net) and what the run costs (gross).
  const total = preview ? preview.net : 0;
  const canPost =
    !!preview && preview.lines.length > 0 && preview.gross > 0 && !preview.negative && !!payDate;

  async function post() {
    if (!canPost || posting) return;
    setPosting(true);
    try {
      await hrService.payrollRun(range.from, range.to, payDate, creditTo, thr && idRules);
      toast.success(t('hr.pay.posted'));
      setConfirming(false);
      await Promise.all([loadPreview(), loadRuns()]);
    } catch (err) {
      setConfirming(false);
      toast.error(errorText(err));
    } finally {
      setPosting(false);
    }
  }

  async function reverse(event: React.FormEvent) {
    event.preventDefault();
    if (!reversing || reverseBusy) return;
    setReverseBusy(true);
    setReverseError('');
    try {
      await hrService.payrollReverse(reversing.run.id, reversing.reason.trim());
      toast.success(t('hr.pay.reversed'));
      setReversing(null);
      await Promise.all([loadPreview(), loadRuns()]);
    } catch (err) {
      setReverseError(errorText(err));
    } finally {
      setReverseBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.payroll')}</h1>
        <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('hr.pay.subtitle')}</p>
        <p
          role="note"
          className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[0.75rem] text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
        >
          {t(idRules ? 'hr.idset.note' : 'hr.taxWarning')}
        </p>
      </div>

      {settings && <PayrollRulesPanel settings={settings} onSaved={setSettings} />}

      <section
        aria-labelledby="payroll-new"
        className="rounded-xl border border-border bg-card p-5 space-y-4"
      >
        <h2 id="payroll-new" className="text-[0.85rem] font-semibold text-foreground">
          {t('hr.pay.newRun')}
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[0.7rem] text-muted-foreground">
              {t('hr.hist.from')}
            </span>
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[0.7rem] text-muted-foreground">
              {t('hr.hist.to')}
            </span>
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[0.7rem] text-muted-foreground">
              {t('hr.pay.payDate')}
            </span>
            <input
              type="date"
              required
              value={payDate}
              onChange={(e) => setPayDate(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block min-w-[14rem]">
            <span className="mb-1 block text-[0.7rem] text-muted-foreground">
              {t('hr.pay.creditTo')}
            </span>
            <select
              value={creditTo}
              onChange={(e) => setCreditTo(e.target.value as 'cash' | 'payable')}
              className={`${inputCls} w-full`}
            >
              <option value="cash">{t('hr.pay.cash')}</option>
              <option value="payable">{t('hr.pay.payable')}</option>
            </select>
          </label>
          {idRules && (
            <label
              className="flex items-center gap-2 pb-2 text-[0.8rem] text-foreground"
              title={t('hr.pay.thrHint')}
            >
              <input type="checkbox" checked={thr} onChange={(e) => setThr(e.target.checked)} />
              {t('hr.pay.thr')}
            </label>
          )}
        </div>

        {previewError && (
          <p className="text-[0.8rem] text-red-600 dark:text-red-400" role="alert">
            {previewError}
          </p>
        )}

        {preview && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(
                [
                  ['hr.pay.employees', fmt.number(preview.employees)],
                  ['hr.hist.regularPay', fmt.money(preview.regular)],
                  ['hr.hist.overtimePay', fmt.money(preview.overtime)],
                  ['hr.pay.leave', fmt.money(preview.leave)],
                  ['hr.pay.holiday', fmt.money(preview.holiday)],
                  ['hr.pay.allowances', fmt.money(preview.allowances)],
                  ['hr.pay.gross', fmt.money(preview.gross)],
                  ['hr.pay.deductions', fmt.money(preview.deductions)],
                  ['hr.pay.employer', fmt.money(preview.employer)],
                  ['hr.pay.net', fmt.money(preview.net)],
                  ...(idRules
                    ? ([
                        ['hr.pay.thrTotal', fmt.money(preview.thr)],
                        ['hr.pay.pph21', fmt.money(preview.pph21)],
                        ['hr.pay.bpjs', fmt.money(preview.bpjs)],
                      ] as [MessageKey, string][])
                    : []),
                ] as [MessageKey, string][]
              ).map(([label, value]) => (
                <div
                  key={label}
                  className={`rounded-lg p-3 ${label === 'hr.pay.net' ? 'bg-primary/10' : 'bg-[var(--surface-2)]'}`}
                >
                  <dt className="text-[0.7rem] text-muted-foreground">{t(label)}</dt>
                  <dd className="text-[1rem] font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            {preview.negative && (
              <p role="alert" className="text-[0.8rem] text-red-600 dark:text-red-400">
                {t('hr.err.negative')}
              </p>
            )}
            {preview.lines.length > 0 && (
              <details>
                <summary className="cursor-pointer text-[0.78rem] font-medium text-foreground">
                  {t('hr.pay.lines')} ({fmt.number(preview.lines.length)})
                </summary>
                <div className="mt-2 overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-[0.75rem]">
                    <thead className="bg-[var(--surface-2)] text-left text-[0.68rem] text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">{t('hr.emp.name')}</th>
                        <th className="px-3 py-1.5 font-medium text-right">{t('hr.pay.gross')}</th>
                        <th className="px-3 py-1.5 font-medium text-right">
                          {t('hr.pay.deductions')}
                        </th>
                        <th className="px-3 py-1.5 font-medium text-right">
                          {t('hr.pay.employer')}
                        </th>
                        <th className="px-3 py-1.5 font-medium text-right">{t('hr.pay.net')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.lines.map((l) => (
                        <tr key={l.employeeId} className="border-t border-border">
                          <td className="px-3 py-1.5 text-foreground">{l.name}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmt.money(l.gross)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmt.money(l.deductions)}
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums">
                            {fmt.money(l.employer)}
                          </td>
                          <td
                            className={`px-3 py-1.5 text-right tabular-nums font-medium ${l.net < 0 ? 'text-red-600 dark:text-red-400' : ''}`}
                          >
                            {fmt.money(l.net)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
            <p className="text-[0.75rem] text-muted-foreground">
              {t('hr.pay.records', { n: fmt.number(preview.records) })}
              {preview.alreadyPaid > 0 &&
                ` · ${t('hr.pay.alreadyPaid', { n: fmt.number(preview.alreadyPaid) })}`}
              {preview.stillIn > 0 &&
                ` · ${t('hr.pay.stillIn', { n: fmt.number(preview.stillIn) })}`}
            </p>
            {preview.lines.length === 0 && (
              <p className="text-[0.8rem] text-muted-foreground">{t('hr.err.nothingToPay')}</p>
            )}
            <button
              type="button"
              disabled={!canPost}
              onClick={() => setConfirming(true)}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
            >
              <Wallet size={14} /> {t('hr.pay.post')}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="payroll-runs" className="space-y-2">
        <h2 id="payroll-runs" className="text-[0.85rem] font-semibold text-foreground">
          {t('hr.pay.runs')}
        </h2>
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <Wallet size={32} className="mx-auto text-muted-foreground mb-3 opacity-40" />
            <p className="text-[0.8rem] text-muted-foreground">{t('hr.pay.empty')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[0.8rem]">
              <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('hr.pay.period')}</th>
                  <th className="px-4 py-2 font-medium">{t('hr.pay.payDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('hr.pay.creditTo')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('hr.pay.recordsCol')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('hr.pay.gross')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('hr.pay.net')}</th>
                  <th className="px-4 py-2 font-medium">{t('hr.pay.entry')}</th>
                  <th className="px-4 py-2 font-medium">{t('common.status')}</th>
                  <th className="px-4 py-2">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-2 whitespace-nowrap">
                      {fmt.date(r.periodFrom)} – {fmt.date(r.periodTo)}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{fmt.date(r.payDate)}</td>
                    <td className="px-4 py-2">
                      {t(r.creditTo === 'cash' ? 'hr.pay.cash' : 'hr.pay.payable')}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.number(r.records)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.money(r.total)}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium">
                      {fmt.money(r.netTotal)}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {r.entryNo === null ? '—' : `#${r.entryNo}`}
                    </td>
                    <td className="px-4 py-2">
                      {r.status === 'reversed' ? (
                        <span
                          className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[0.7rem] text-muted-foreground"
                          title={r.reverseReason}
                        >
                          {t('hr.pay.statusReversed')}
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-[0.7rem] text-green-800 dark:bg-green-950/40 dark:text-green-300">
                          {t('hr.pay.statusPosted')}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">
                      {r.employees > 0 && (
                        <Link
                          href={`/erp/print/payslip/${r.id}`}
                          title={t('hr.pay.payslips')}
                          aria-label={t('hr.pay.payslips')}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                        >
                          <FileText size={14} />
                        </Link>
                      )}
                      {r.status === 'posted' && (
                        <button
                          type="button"
                          title={t('hr.pay.reverse')}
                          aria-label={t('hr.pay.reverse')}
                          onClick={() => {
                            setReverseError('');
                            setReversing({ run: r, reason: '' });
                          }}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                        >
                          <Undo2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirming && preview && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !posting) setConfirming(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="post-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-4"
          >
            <h2 id="post-title" className="text-[1rem] font-semibold text-foreground">
              {t('hr.pay.confirmTitle')}
            </h2>
            <p className="text-[0.8rem] text-muted-foreground">
              {t(creditTo === 'cash' ? 'hr.pay.confirmCash' : 'hr.pay.confirmPayable', {
                total: fmt.money(total),
                date: fmt.date(payDate),
              })}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={posting}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={post}
                disabled={posting}
                className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {posting && <Loader2 size={13} className="animate-spin" />}
                {t('hr.pay.post')}
              </button>
            </div>
          </div>
        </div>
      )}

      {reversing && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setReversing(null);
          }}
        >
          <form
            onSubmit={reverse}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reverse-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 id="reverse-title" className="text-[1rem] font-semibold text-foreground">
                {t('hr.pay.reverseTitle')}
              </h2>
              <button
                type="button"
                onClick={() => setReversing(null)}
                aria-label={t('common.close')}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-[0.8rem] text-muted-foreground">
              {t('hr.pay.reverseBody', { total: fmt.money(reversing.run.total) })}
            </p>
            <label className="block">
              <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                {t('hr.hist.reason')}
              </span>
              <textarea
                required
                minLength={5}
                maxLength={500}
                rows={2}
                value={reversing.reason}
                onChange={(e) => setReversing({ ...reversing, reason: e.target.value })}
                className={`${inputCls} w-full`}
              />
            </label>
            {reverseError && (
              <p className="text-[0.78rem] text-red-600 dark:text-red-400" role="alert">
                {reverseError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setReversing(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={reverseBusy || reversing.reason.trim().length < 5}
                className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-red-600 text-white disabled:opacity-50"
              >
                {reverseBusy && <Loader2 size={13} className="animate-spin" />}
                {t('hr.pay.reverse')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
