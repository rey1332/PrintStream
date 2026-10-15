'use client';

// Tax data of a customer or supplier (db/migrations/20261012000053): which ID
// (NPWP, NIK, passport, other), its number, the NITKU, PKP status, and the
// name and address for tax documents (e-Faktur, bukti potong).

import React from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { taxDataProblem, type PartyTax, type TaxIdType } from '../lib/taxService';

export { emptyPartyTax, type PartyTax } from '../lib/taxService';

const labelCls = 'block text-[0.7rem] text-zinc-500 dark:text-muted-foreground mb-1';
const fieldCls =
  'w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-[var(--input,transparent)] px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

export function PartyTaxFields({
  value,
  onChange,
}: {
  value: PartyTax;
  onChange: (next: PartyTax) => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<PartyTax>) => onChange({ ...value, ...patch });
  const problem = taxDataProblem(value);
  const numeric = value.idType === 'npwp' || value.idType === 'nik';

  return (
    <fieldset className="space-y-3 rounded-lg border border-zinc-200 dark:border-border p-3">
      <legend className="px-1 text-[0.72rem] font-medium text-foreground">
        {t('tax.party.title')}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>{t('tax.party.idType')}</label>
          <select
            className={fieldCls}
            value={value.idType ?? ''}
            onChange={(e) =>
              set({
                idType: (e.target.value || null) as TaxIdType | null,
                id: e.target.value ? value.id : '',
              })
            }
          >
            <option value="">{t('tax.party.none')}</option>
            <option value="npwp">NPWP</option>
            <option value="nik">NIK</option>
            <option value="passport">{t('tax.party.passport')}</option>
            <option value="other">{t('tax.party.other')}</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>{t('tax.party.number')}</label>
          <input
            className={fieldCls}
            value={value.id}
            disabled={!value.idType}
            inputMode={numeric ? 'numeric' : undefined}
            maxLength={numeric ? 24 : 30}
            placeholder={numeric ? '0012345678901000' : ''}
            onChange={(e) =>
              set({ id: numeric ? e.target.value.replace(/\D/g, '') : e.target.value })
            }
          />
        </div>
        {value.idType === 'npwp' && (
          <div className="sm:col-span-2">
            <label className={labelCls}>NITKU</label>
            <input
              className={fieldCls}
              value={value.nitku}
              inputMode="numeric"
              maxLength={22}
              placeholder={value.id.length === 16 ? `${value.id}000000` : '0012345678901000000000'}
              onChange={(e) => set({ nitku: e.target.value.replace(/\D/g, '') })}
            />
            <p className="mt-1 text-[0.68rem] text-muted-foreground">{t('tax.party.nitkuHint')}</p>
          </div>
        )}
        <div>
          <label className={labelCls}>{t('tax.party.name')}</label>
          <input
            className={fieldCls}
            value={value.name}
            maxLength={200}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div>
          <label className={labelCls}>{t('tax.party.address')}</label>
          <input
            className={fieldCls}
            value={value.address}
            maxLength={500}
            onChange={(e) => set({ address: e.target.value })}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[0.78rem] text-foreground">
        <input
          type="checkbox"
          checked={value.isPkp}
          onChange={(e) => set({ isPkp: e.target.checked })}
        />
        {t('tax.party.pkp')}
      </label>
      {problem && (
        <p className="text-[0.72rem] text-amber-700 dark:text-amber-400" role="status">
          {t(problem)}
        </p>
      )}
    </fieldset>
  );
}
