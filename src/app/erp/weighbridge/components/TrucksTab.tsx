'use client';

import React, { useMemo, useState } from 'react';
import { Pencil, Plus, Search, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  VEHICLE_KINDS,
  weighbridgeService,
  type Vehicle,
  type VehicleInput,
  type VehicleKind,
  type WeighCustomer,
} from '../../lib/weighbridgeService';
import {
  Dialog,
  DialogButtons,
  Field,
  FormError,
  errorKey,
  inputCls,
} from '../../components/moduleUi';

const KIND_LABEL: Record<VehicleKind, MessageKey> = {
  dump_truck: 'wb.kind.dump_truck',
  trailer: 'wb.kind.trailer',
  pickup: 'wb.kind.pickup',
  other: 'wb.kind.other',
};

const emptyInput = (): VehicleInput => ({
  plate_no: '',
  kind: 'dump_truck',
  owner_name: '',
  customer_id: null,
  driver_name: '',
  tare_kg: null,
  active: true,
});

export function TrucksTab({
  vehicles,
  customers,
  canEdit,
  onChanged,
}: {
  vehicles: Vehicle[];
  customers: WeighCustomer[];
  canEdit: boolean;
  onChanged: () => void;
}) {
  const { t, fmt } = useI18n();
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<{ id: string | null; data: VehicleInput } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const customerName = (id: string | null) => customers.find((c) => c.id === id)?.name ?? '';

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vehicles;
    return vehicles.filter((v) =>
      [v.plateNo, v.driverName, v.ownerName, customerName(v.customerId)].some((s) =>
        s.toLowerCase().includes(q)
      )
    );
    // customerName depends only on customers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicles, customers, query]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!modal || saving) return;
    setSaving(true);
    setError('');
    try {
      await weighbridgeService.saveVehicle(modal.id, {
        ...modal.data,
        plate_no: modal.data.plate_no.trim().toUpperCase(),
      });
      toast.success(t('wb.truck.saved'));
      setModal(null);
      onChanged();
    } catch (err) {
      setError(t(errorKey(err)));
    } finally {
      setSaving(false);
    }
  }

  const set = <K extends keyof VehicleInput>(key: K, value: VehicleInput[K]) =>
    setModal((m) => (m ? { ...m, data: { ...m.data, [key]: value } } : m));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 sm:max-w-xs">
          <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            className="min-w-0 flex-1 bg-transparent text-[0.8rem] text-foreground outline-none"
          />
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setError('');
              setModal({ id: null, data: emptyInput() });
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium border border-border text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11"
          >
            <Plus size={14} /> {t('wb.truck.add')}
          </button>
        )}
      </div>

      {vehicles.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Truck size={30} className="mx-auto mb-3 text-muted-foreground opacity-40" />
          <p className="text-[0.8rem] text-muted-foreground">{t('wb.truck.empty')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-[0.8rem]">
            <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('wb.in.truck')}</th>
                <th className="px-4 py-2 font-medium max-md:hidden">{t('wb.truck.kind')}</th>
                <th className="px-4 py-2 font-medium">{t('wb.in.driver')}</th>
                <th className="px-4 py-2 font-medium max-md:hidden">{t('wb.truck.owner')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('wb.truck.tare')}</th>
                <th className="px-4 py-2 font-medium">{t('common.status')}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((v) => (
                <tr key={v.id} className="border-t border-border">
                  <td className="px-4 py-2">
                    <p className="font-medium text-foreground">{v.plateNo}</p>
                    {v.customerId && (
                      <p className="text-[0.7rem] text-muted-foreground">
                        {customerName(v.customerId)}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground max-md:hidden">
                    {t(KIND_LABEL[v.kind] ?? 'wb.kind.other')}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{v.driverName || '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground max-md:hidden">
                    {v.ownerName || '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {v.tareKg === null ? '—' : fmt.number(v.tareKg)}
                    {v.tareAt && (
                      <span className="block text-[0.68rem] text-muted-foreground">
                        {t('wb.truck.tareAt', { date: fmt.date(v.tareAt) })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[0.68rem] font-medium ${v.active ? 'bg-green-100 text-green-700 dark:bg-green-950/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400'}`}
                    >
                      {t(v.active ? 'wb.truck.active' : 'wb.truck.blocked')}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => {
                          setError('');
                          setModal({
                            id: v.id,
                            data: {
                              plate_no: v.plateNo,
                              kind: v.kind,
                              owner_name: v.ownerName,
                              customer_id: v.customerId,
                              driver_name: v.driverName,
                              tare_kg: v.tareKg,
                              active: v.active,
                            },
                          });
                        }}
                        title={t('common.edit')}
                        aria-label={`${t('common.edit')}: ${v.plateNo}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                      >
                        <Pencil size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <Dialog
          title={t(modal.id ? 'wb.truck.edit' : 'wb.truck.add')}
          onClose={() => setModal(null)}
          onSubmit={save}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={`${t('wb.in.truck')} *`}>
              <input
                autoFocus
                required
                minLength={2}
                maxLength={20}
                value={modal.data.plate_no}
                onChange={(e) => set('plate_no', e.target.value)}
                className={`${inputCls} uppercase`}
              />
            </Field>
            <Field label={t('wb.truck.kind')}>
              <select
                value={modal.data.kind}
                onChange={(e) => set('kind', e.target.value as VehicleKind)}
                className={inputCls}
              >
                {VEHICLE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(KIND_LABEL[k])}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('wb.in.driver')}>
              <input
                maxLength={120}
                value={modal.data.driver_name}
                onChange={(e) => set('driver_name', e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('wb.truck.owner')}>
              <input
                maxLength={120}
                value={modal.data.owner_name}
                onChange={(e) => set('owner_name', e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('wb.truck.customer')}>
              <select
                value={modal.data.customer_id ?? ''}
                onChange={(e) => set('customer_id', e.target.value || null)}
                className={inputCls}
              >
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('wb.truck.tare')}>
              <input
                type="number"
                inputMode="decimal"
                min={1}
                max={200000}
                step="0.1"
                value={modal.data.tare_kg ?? ''}
                onChange={(e) =>
                  set('tare_kg', e.target.value === '' ? null : Number(e.target.value))
                }
                className={inputCls}
              />
            </Field>
            <label className="flex items-center gap-2 text-[0.78rem] text-foreground sm:col-span-2">
              <input
                type="checkbox"
                checked={modal.data.active}
                onChange={(e) => set('active', e.target.checked)}
              />
              {t('wb.truck.active')}
            </label>
          </div>
          <FormError text={error} />
          <DialogButtons
            busy={saving}
            disabled={modal.data.plate_no.trim().length < 2}
            label={t('common.save')}
            onCancel={() => setModal(null)}
          />
        </Dialog>
      )}
    </div>
  );
}
