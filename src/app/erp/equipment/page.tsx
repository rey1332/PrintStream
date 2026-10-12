'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Fuel, Pencil, Plus, Undo2, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useWorkspace } from '../lib/WorkspaceContext';
import {
  equipmentService,
  type EquipmentInput,
  type EquipmentLog,
  type EquipmentRow,
  type LogKind,
} from '../lib/equipmentService';
import { errorKey, inputCls, todayIso } from '../components/moduleUi';
import { KIND_LABEL, LogDialog, MachineDialog } from './dialogs';

const emptyMachine = (): EquipmentInput => ({
  code: '',
  name: '',
  kind: 'excavator',
  initial_hour_meter: 0,
  service_interval_hours: 250,
  note: '',
  active: true,
});

export default function EquipmentPage() {
  const { t, fmt } = useI18n();
  const { active, can, role } = useWorkspace();
  const [from, setFrom] = useState(() => todayIso().slice(0, 8) + '01');
  const [to, setTo] = useState(() => todayIso());
  const [machines, setMachines] = useState<EquipmentRow[]>([]);
  const [logs, setLogs] = useState<EquipmentLog[]>([]);
  const [fuels, setFuels] = useState<{ id: string; name: string; stock: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ id: string | null; data: EquipmentInput } | null>(null);
  const [logging, setLogging] = useState<{ kind: LogKind; machineId: string } | null>(null);
  const canRecord = can('inventory');
  const canReverse = role === 'owner' || role === 'admin';

  const load = useCallback(async () => {
    const [m, l] = await Promise.all([
      equipmentService.overview(from, to),
      equipmentService.logs(from, to),
    ]);
    setMachines(m);
    setLogs(l);
  }, [from, to]);

  useEffect(() => {
    setLoading(true);
    load()
      .catch((err) => toast.error(t(errorKey(err, 'eq.err.failed'))))
      .finally(() => setLoading(false));
  }, [active?.id, load, t]);

  useEffect(() => {
    if (!canRecord) return;
    equipmentService
      .fuels()
      .then(setFuels)
      .catch(() => undefined);
  }, [active?.id, canRecord, logging]);

  const byId = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines]);
  const totals = machines.reduce(
    (acc, m) => ({
      hours: acc.hours + m.hours,
      liters: acc.liters + m.liters,
      cost: acc.cost + m.fuelCost,
    }),
    { hours: 0, liters: 0, cost: 0 }
  );

  async function openEdit(m: EquipmentRow) {
    try {
      const details = await equipmentService.details(m.id);
      setEditing({
        id: m.id,
        data: {
          code: m.code,
          name: m.name,
          kind: m.kind,
          initial_hour_meter: details.initialHourMeter,
          service_interval_hours: m.serviceIntervalHours,
          note: details.note,
          active: m.active,
        },
      });
    } catch (err) {
      toast.error(t(errorKey(err, 'eq.err.failed')));
    }
  }

  async function reverse(entry: EquipmentLog) {
    const reason = window.prompt(t('eq.reversePrompt'));
    if (reason === null) return;
    try {
      await equipmentService.reverse(entry.id, reason);
      toast.success(t('eq.reversedToast'));
      await load();
    } catch (err) {
      toast.error(t(errorKey(err, 'eq.err.failed')));
    }
  }

  const serviceBadge = (m: EquipmentRow) => {
    if (m.serviceDueIn === null) return <span className="text-muted-foreground">—</span>;
    const cls =
      m.serviceDueIn < 0
        ? 'bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400'
        : m.serviceDueIn <= 25
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400'
          : 'bg-[var(--surface-3)] text-muted-foreground';
    return (
      <span className={`rounded-full px-2 py-0.5 text-[0.68rem] font-medium ${cls}`}>
        {m.serviceDueIn < 0
          ? t('eq.overdue', { hours: fmt.number(-m.serviceDueIn) })
          : t('eq.dueIn', { hours: fmt.number(m.serviceDueIn) })}
      </span>
    );
  };

  const describe = (l: EquipmentLog) => {
    if (l.kind === 'fuel')
      return t('eq.fuelLine', { liters: fmt.number(l.liters ?? 0), fuel: l.fuelProductName });
    if (l.kind === 'service') return l.description;
    return t('eq.hoursWorked', { hours: fmt.number(l.hoursWorked ?? 0) });
  };

  const actionBtn =
    'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[0.72rem] text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11';
  const LOG_ICON = { hours: Clock, fuel: Fuel, service: Wrench } as const;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.equipment')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('eq.subtitle')}</p>
        </div>
        {canRecord && (
          <button
            type="button"
            onClick={() => setEditing({ id: null, data: emptyMachine() })}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground max-lg:min-h-11"
          >
            <Plus size={14} /> {t('eq.add')}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[0.7rem] text-muted-foreground">{t('prd.from')}</span>
          <input
            type="date"
            value={from}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
            className={`${inputCls} w-auto`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[0.7rem] text-muted-foreground">{t('prd.to')}</span>
          <input
            type="date"
            value={to}
            onChange={(e) => e.target.value && setTo(e.target.value)}
            className={`${inputCls} w-auto`}
          />
        </label>
        <p className="pb-2 text-[0.78rem] text-muted-foreground">
          {t('eq.periodTotals', {
            hours: fmt.number(totals.hours),
            liters: fmt.number(totals.liters),
            cost: fmt.money(totals.cost),
          })}
        </p>
      </div>

      {loading ? (
        <div className="h-24 rounded-xl animate-pulse bg-[var(--surface-3)]" />
      ) : machines.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center">
          <Wrench size={30} className="mx-auto mb-3 text-muted-foreground opacity-40" />
          <p className="text-[0.8rem] text-muted-foreground">{t('eq.empty')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-[0.78rem]">
            <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t('eq.col.machine')}</th>
                <th className="px-3 py-2 font-medium text-right">{t('eq.meter')}</th>
                <th className="px-3 py-2 font-medium text-right">{t('eq.hours')}</th>
                <th className="px-3 py-2 font-medium text-right">{t('eq.liters')}</th>
                <th className="px-3 py-2 font-medium text-right max-md:hidden">{t('eq.lph')}</th>
                <th className="px-3 py-2 font-medium text-right max-md:hidden">
                  {t('eq.fuelCost')}
                </th>
                <th className="px-3 py-2 font-medium">{t('eq.service')}</th>
                <th className="px-3 py-2">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {machines.map((m) => (
                <tr
                  key={m.id}
                  className={`border-t border-border ${m.active ? '' : 'text-muted-foreground'}`}
                >
                  <td className="px-3 py-2">
                    <p className="font-medium text-foreground">
                      {m.code} · {m.name}
                    </p>
                    <p className="text-[0.7rem] text-muted-foreground">
                      {t(KIND_LABEL[m.kind] ?? 'eq.kind.other')}
                      {m.active ? '' : ` · ${t('eq.retired')}`}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt.number(m.hourMeter)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt.number(m.hours)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt.number(m.liters)}</td>
                  <td className="px-3 py-2 text-right tabular-nums max-md:hidden">
                    {m.litersPerHour === null ? '—' : fmt.number(m.litersPerHour)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums max-md:hidden">
                    {fmt.money(m.fuelCost)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{serviceBadge(m)}</td>
                  <td className="px-2 py-1 text-right">
                    {canRecord && (
                      <div className="flex flex-wrap justify-end gap-1">
                        {m.active &&
                          (['hours', 'fuel', 'service'] as const).map((kind) => {
                            const Icon = LOG_ICON[kind];
                            return (
                              <button
                                key={kind}
                                type="button"
                                onClick={() => setLogging({ kind, machineId: m.id })}
                                className={actionBtn}
                              >
                                <Icon size={12} aria-hidden />
                                {t(
                                  kind === 'hours'
                                    ? 'eq.logHours'
                                    : kind === 'fuel'
                                      ? 'eq.logFuel'
                                      : 'eq.logService'
                                )}
                              </button>
                            );
                          })}
                        <button
                          type="button"
                          onClick={() => void openEdit(m)}
                          title={t('common.edit')}
                          aria-label={`${t('common.edit')}: ${m.code}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-[0.85rem] font-semibold text-foreground">{t('eq.log')}</h2>
        {!loading && logs.length === 0 ? (
          <p className="text-[0.78rem] text-muted-foreground">{t('eq.logEmpty')}</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[0.78rem]">
              <tbody>
                {logs.map((l) => {
                  const Icon = LOG_ICON[l.kind];
                  const m = byId.get(l.equipmentId);
                  return (
                    <tr
                      key={l.id}
                      className={`border-t border-border first:border-t-0 ${l.status === 'reversed' ? 'text-muted-foreground line-through decoration-1' : ''}`}
                    >
                      <td className="px-3 py-2 whitespace-nowrap">{fmt.date(l.logDate)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{m ? m.code : '—'}</td>
                      <td className="px-3 py-2">
                        <Icon size={12} className="mr-1 inline text-muted-foreground" aria-hidden />
                        {describe(l)}
                        {l.operator && (
                          <span className="text-muted-foreground"> · {l.operator}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap max-sm:hidden">
                        {l.hourMeter === null ? '' : fmt.number(l.hourMeter)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {l.amount === null ? '' : fmt.money(l.amount)}
                      </td>
                      <td className="px-1 py-1 text-right">
                        {l.status === 'reversed' ? (
                          <span className="text-[0.68rem] no-underline" title={l.reverseReason}>
                            {t('eq.reversed')}
                          </span>
                        ) : (
                          canReverse && (
                            <button
                              type="button"
                              onClick={() => void reverse(l)}
                              title={t('eq.reverse')}
                              aria-label={t('eq.reverse')}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                            >
                              <Undo2 size={13} />
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <MachineDialog
          id={editing.id}
          initial={editing.data}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {logging && (
        <LogDialog
          kind={logging.kind}
          machines={machines}
          machineId={logging.machineId}
          fuels={fuels}
          onClose={() => setLogging(null)}
          onSaved={() => {
            setLogging(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
