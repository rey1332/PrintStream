'use client';

import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { HrError, PTKP_STATUSES, hrService, type PayTerms, type PayType } from '../lib/hrService';
import { Dialog, DialogButtons, Field, FormError, inputCls } from './moduleUi';

const DEFAULT_TERMS: PayTerms = {
  payType: 'hourly',
  monthlySalary: 0,
  fixedAllowance: 0,
  dailyRate: 0,
  joinDate: '',
  ptkpStatus: 'TK/0',
  npwp: '',
  bpjsTk: true,
  bpjsJp: true,
  bpjsKes: true,
};

/** Employees → Pay terms: monthly or daily pay, and the Indonesian tax and BPJS details. */
export function PayTermsDialog({
  employeeId,
  employeeName,
  onClose,
}: {
  employeeId: string;
  employeeName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [terms, setTerms] = useState<PayTerms | null>(null);
  const [idRules, setIdRules] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([hrService.employeeTerms(), hrService.payrollSettings()])
      .then(([all, settings]) => {
        setTerms(all[employeeId] ?? DEFAULT_TERMS);
        setIdRules(settings.rules === 'id');
      })
      .catch((err) => {
        setTerms(DEFAULT_TERMS);
        setError(t(err instanceof HrError ? err.key : 'hr.err.failed'));
      });
  }, [employeeId, t]);

  const set = <K extends keyof PayTerms>(key: K, value: PayTerms[K]) =>
    setTerms((x) => (x ? { ...x, [key]: value } : x));
  const money = (key: 'monthlySalary' | 'fixedAllowance' | 'dailyRate', label: string) => (
    <Field label={label}>
      <input
        type="number"
        min={0}
        step="1"
        inputMode="numeric"
        value={terms?.[key] ?? 0}
        onChange={(e) => set(key, Number(e.target.value) || 0)}
        className={inputCls}
      />
    </Field>
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!terms || saving) return;
    setSaving(true);
    setError('');
    try {
      await hrService.saveEmployeeTerms(employeeId, terms);
      toast.success(t('hr.terms.saved'));
      onClose();
    } catch (err) {
      setError(t(err instanceof HrError ? err.key : 'hr.err.failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={t('hr.terms.title', { name: employeeName })} onClose={onClose} onSubmit={submit}>
      {!terms ? (
        <p className="text-[0.8rem] text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('hr.terms.payType')}>
            <select
              value={terms.payType}
              onChange={(e) => set('payType', e.target.value as PayType)}
              className={inputCls}
            >
              <option value="hourly">{t('hr.terms.hourly')}</option>
              <option value="daily">{t('hr.terms.daily')}</option>
              <option value="monthly">{t('hr.terms.monthly')}</option>
            </select>
          </Field>
          <Field label={t('hr.terms.joinDate')}>
            <input
              type="date"
              value={terms.joinDate}
              onChange={(e) => set('joinDate', e.target.value)}
              className={inputCls}
            />
          </Field>
          {terms.payType === 'monthly' && (
            <>
              {money('monthlySalary', t('hr.terms.salary'))}
              {money('fixedAllowance', t('hr.terms.fixedAllowance'))}
              <p className="text-[0.7rem] text-muted-foreground sm:col-span-2">
                {t('hr.terms.monthlyHint')}
              </p>
            </>
          )}
          {terms.payType === 'daily' && money('dailyRate', t('hr.terms.dailyRate'))}

          <h3 className="mt-2 text-[0.78rem] font-semibold text-foreground sm:col-span-2">
            {t('hr.terms.tax')}
          </h3>
          {!idRules && (
            <p className="text-[0.7rem] text-muted-foreground sm:col-span-2">
              {t('hr.terms.idOff')}
            </p>
          )}
          <Field label={t('hr.terms.ptkp')}>
            <select
              value={terms.ptkpStatus}
              onChange={(e) => set('ptkpStatus', e.target.value as PayTerms['ptkpStatus'])}
              className={inputCls}
            >
              {PTKP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('hr.terms.npwp')}>
            <input
              maxLength={30}
              inputMode="numeric"
              value={terms.npwp}
              onChange={(e) => set('npwp', e.target.value)}
              className={inputCls}
            />
          </Field>
          {(
            [
              ['bpjsTk', 'hr.terms.bpjsTk'],
              ['bpjsJp', 'hr.terms.bpjsJp'],
              ['bpjsKes', 'hr.terms.bpjsKes'],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center gap-2 text-[0.78rem] text-foreground sm:col-span-2"
            >
              <input
                type="checkbox"
                checked={terms[key]}
                disabled={key === 'bpjsJp' && !terms.bpjsTk}
                onChange={(e) => set(key, e.target.checked)}
              />
              {t(label)}
            </label>
          ))}
        </div>
      )}
      <FormError text={error} />
      <DialogButtons busy={saving} disabled={!terms} label={t('common.save')} onCancel={onClose} />
    </Dialog>
  );
}
