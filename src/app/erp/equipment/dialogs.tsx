'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
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
  EQUIPMENT_KINDS,
  equipmentService,
  type EquipmentInput,
  type EquipmentKind,
  type EquipmentRow,
  type LogKind,
} from '../lib/equipmentService';

export const KIND_LABEL: Record<EquipmentKind, MessageKey> = {
  excavator: 'eq.kind.excavator',
  wheel_loader: 'eq.kind.wheel_loader',
  dump_truck: 'eq.kind.dump_truck',
  bulldozer: 'eq.kind.bulldozer',
  crusher: 'eq.kind.crusher',
  genset: 'eq.kind.genset',
  vehicle: 'eq.kind.vehicle',
  other: 'eq.kind.other',
};

export function MachineDialog({
  id,
  initial,
  onClose,
  onSaved,
}: {
  id: string | null;
  initial: EquipmentInput;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<EquipmentInput>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof EquipmentInput>(key: K, value: EquipmentInput[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await equipmentService.save(id, { ...data, code: data.code.trim(), name: data.name.trim() });
      toast.success(t('eq.saved'));
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'eq.err.failed')));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title={t(id ? 'eq.edit' : 'eq.add')} onClose={onClose} onSubmit={submit}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={`${t('eq.code')} *`}>
          <input
            autoFocus
            required
            maxLength={30}
            value={data.code}
            onChange={(e) => set('code', e.target.value)}
            className={`${inputCls} uppercase`}
          />
        </Field>
        <Field label={t('eq.kind')}>
          <select
            value={data.kind}
            onChange={(e) => set('kind', e.target.value as EquipmentKind)}
            className={inputCls}
          >
            {EQUIPMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`${t('eq.name')} *`} wide>
          <input
            required
            maxLength={120}
            value={data.name}
            onChange={(e) => set('name', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={t('eq.initialMeter')}>
          <input
            type="number"
            min={0}
            step="0.1"
            inputMode="decimal"
            value={data.initial_hour_meter}
            onChange={(e) => set('initial_hour_meter', Number(e.target.value) || 0)}
            className={inputCls}
          />
        </Field>
        <Field label={t('eq.interval')}>
          <input
            type="number"
            min={1}
            step="1"
            inputMode="numeric"
            value={data.service_interval_hours ?? ''}
            onChange={(e) =>
              set('service_interval_hours', e.target.value === '' ? null : Number(e.target.value))
            }
            className={inputCls}
          />
        </Field>
        <Field label={t('eq.note')} wide>
          <input
            maxLength={500}
            value={data.note}
            onChange={(e) => set('note', e.target.value)}
            className={inputCls}
          />
        </Field>
        {id && (
          <label className="flex items-center gap-2 text-[0.78rem] text-foreground sm:col-span-2">
            <input
              type="checkbox"
              checked={data.active}
              onChange={(e) => set('active', e.target.checked)}
            />
            {t('eq.active')}
          </label>
        )}
      </div>
      <FormError text={error} />
      <DialogButtons
        busy={saving}
        disabled={!data.code.trim() || !data.name.trim()}
        label={t('common.save')}
        onCancel={onClose}
      />
    </Dialog>
  );
}

const LOG_TITLE: Record<LogKind, MessageKey> = {
  hours: 'eq.logHours',
  fuel: 'eq.logFuel',
  service: 'eq.logService',
};

export function LogDialog({
  kind,
  machines,
  machineId,
  fuels,
  onClose,
  onSaved,
}: {
  kind: LogKind;
  machines: EquipmentRow[];
  machineId: string;
  fuels: { id: string; name: string; stock: number }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  const [equipmentId, setEquipmentId] = useState(machineId);
  const [date, setDate] = useState(() => todayIso());
  const [reading, setReading] = useState('');
  const [liters, setLiters] = useState('');
  const [fuelId, setFuelId] = useState(fuels[0]?.id ?? '');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [operator, setOperator] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const machine = machines.find((m) => m.id === equipmentId);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await equipmentService.log({
        equipment_id: equipmentId,
        kind,
        log_date: date,
        hour_meter: reading === '' ? null : Number(reading),
        liters: kind === 'fuel' ? Number(liters) : null,
        fuel_product_id: kind === 'fuel' ? fuelId : null,
        description: kind === 'service' ? description.trim() : '',
        amount: kind === 'service' && amount !== '' ? Number(amount) : null,
        operator: operator.trim(),
        note: note.trim(),
      });
      toast.success(t('eq.logged'));
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'eq.err.failed')));
    } finally {
      setSaving(false);
    }
  }

  const noFuel = kind === 'fuel' && fuels.length === 0;

  return (
    <Dialog title={t(LOG_TITLE[kind])} onClose={onClose} onSubmit={submit}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label={t('eq.form.machine')} wide>
          <select
            required
            value={equipmentId}
            onChange={(e) => setEquipmentId(e.target.value)}
            className={inputCls}
          >
            {machines
              .filter((m) => m.active)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code} · {m.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label={t('eq.form.date')}>
          <input
            type="date"
            required
            max={todayIso()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field
          label={t(kind === 'hours' ? 'eq.form.reading' : 'eq.form.readingOptional')}
          hint={
            machine ? t('eq.form.readingHint', { value: fmt.number(machine.hourMeter) }) : undefined
          }
        >
          <input
            type="number"
            required={kind === 'hours'}
            min={0}
            step="0.1"
            inputMode="decimal"
            value={reading}
            onChange={(e) => setReading(e.target.value)}
            className={`${inputCls} tabular-nums`}
          />
        </Field>
        {kind === 'fuel' &&
          (noFuel ? (
            <p className="text-[0.75rem] text-muted-foreground sm:col-span-2">
              {t('eq.form.noFuel')}
            </p>
          ) : (
            <>
              <Field label={`${t('eq.form.fuel')} *`}>
                <select
                  required
                  value={fuelId}
                  onChange={(e) => setFuelId(e.target.value)}
                  className={inputCls}
                >
                  {fuels.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} · {fmt.number(f.stock)} L
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`${t('eq.form.liters')} *`}>
                <input
                  type="number"
                  required
                  min={0.001}
                  step="any"
                  inputMode="decimal"
                  value={liters}
                  onChange={(e) => setLiters(e.target.value)}
                  className={`${inputCls} tabular-nums`}
                />
              </Field>
            </>
          ))}
        {kind === 'service' && (
          <>
            <Field label={`${t('eq.form.description')} *`} wide>
              <input
                required
                maxLength={300}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className={inputCls}
              />
            </Field>
            <Field label={t('eq.form.cost')} hint={t('eq.form.costHint')} wide>
              <input
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={inputCls}
              />
            </Field>
          </>
        )}
        <Field label={t('eq.form.operator')}>
          <input
            maxLength={120}
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label={t('eq.note')}>
          <input
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>
      <FormError text={error} />
      <DialogButtons
        busy={saving}
        disabled={!equipmentId || noFuel}
        label={t('common.save')}
        onCancel={onClose}
      />
    </Dialog>
  );
}
