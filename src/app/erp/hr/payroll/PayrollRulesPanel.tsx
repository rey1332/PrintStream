'use client';

import React, { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { HrError, hrService, type PayrollSettings } from '../../lib/hrService';
import { Field, inputCls } from '../../components/moduleUi';

/** Payroll → Payroll rules: basic or Indonesian, with the BPJS rates and caps. */
export function PayrollRulesPanel({
  settings,
  onSaved,
}: {
  settings: PayrollSettings;
  onSaved: (s: PayrollSettings) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<PayrollSettings>(settings);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof PayrollSettings>(key: K, value: PayrollSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await hrService.savePayrollSettings(draft);
      toast.success(t('hr.idset.saved'));
      onSaved(draft);
    } catch (err) {
      toast.error(t(err instanceof HrError ? err.key : 'hr.err.failed'));
    } finally {
      setSaving(false);
    }
  }

  const number = (key: 'jkkRate' | 'jkmRate' | 'jpCap' | 'kesCap' | 'kesFloor', step: string) => (
    <input
      type="number"
      min={0}
      step={step}
      inputMode="decimal"
      value={draft[key]}
      onChange={(e) => set(key, Number(e.target.value) || 0)}
      className={inputCls}
    />
  );

  return (
    <details className="rounded-xl border border-border bg-card p-5">
      <summary className="cursor-pointer text-[0.85rem] font-semibold text-foreground">
        {t('hr.idset.title')}: {t(settings.rules === 'id' ? 'hr.idset.id' : 'hr.idset.basic')}
      </summary>
      <div className="mt-4 space-y-4">
        <div className="space-y-2" role="radiogroup" aria-label={t('hr.idset.title')}>
          {(['basic', 'id'] as const).map((rules) => (
            <label key={rules} className="flex items-start gap-2 text-[0.8rem] text-foreground">
              <input
                type="radio"
                name="payroll-rules"
                className="mt-1"
                checked={draft.rules === rules}
                onChange={() => set('rules', rules)}
              />
              {t(rules === 'id' ? 'hr.idset.id' : 'hr.idset.basic')}
            </label>
          ))}
        </div>
        {draft.rules === 'id' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t('hr.idset.jkk')} hint={t('hr.idset.jkkHint')}>
              {number('jkkRate', '0.01')}
            </Field>
            <Field label={t('hr.idset.jkm')}>{number('jkmRate', '0.01')}</Field>
            <Field label={t('hr.idset.jpCap')} hint={t('hr.idset.jpCapHint')}>
              {number('jpCap', '1')}
            </Field>
            <Field label={t('hr.idset.kesCap')}>{number('kesCap', '1')}</Field>
            <Field label={t('hr.idset.kesFloor')}>{number('kesFloor', '1')}</Field>
          </div>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {t('common.save')}
        </button>
      </div>
    </details>
  );
}
