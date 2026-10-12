'use client';

import { createClient } from '@/lib/data/client';
import type { MessageKey } from '@/lib/i18n/messages';
import { rpcWorkspaceId } from './workspace';

// Equipment module (db/migrations/20261012000026_erp_equipment.sql).

export const EQUIPMENT_KINDS = [
  'excavator',
  'wheel_loader',
  'dump_truck',
  'bulldozer',
  'crusher',
  'genset',
  'vehicle',
  'other',
] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];
export type LogKind = 'hours' | 'fuel' | 'service';

export interface EquipmentRow {
  id: string;
  code: string;
  name: string;
  kind: EquipmentKind;
  hourMeter: number;
  serviceIntervalHours: number | null;
  lastServiceHours: number | null;
  lastServiceDate: string | null;
  serviceDueIn: number | null;
  active: boolean;
  hours: number;
  liters: number;
  fuelCost: number;
  litersPerHour: number | null;
  services: number;
}

export interface EquipmentInput {
  code: string;
  name: string;
  kind: EquipmentKind;
  initial_hour_meter: number;
  service_interval_hours: number | null;
  note: string;
  active: boolean;
}

export interface EquipmentLog {
  id: string;
  equipmentId: string;
  kind: LogKind;
  logDate: string;
  hourMeter: number | null;
  hoursWorked: number | null;
  liters: number | null;
  fuelProductName: string;
  amount: number | null;
  description: string;
  operator: string;
  note: string;
  status: 'posted' | 'reversed';
  reverseReason: string;
}

export interface LogInput {
  equipment_id: string;
  kind: LogKind;
  log_date: string;
  hour_meter: number | null;
  liters?: number | null;
  fuel_product_id?: string | null;
  description?: string;
  amount?: number | null;
  operator: string;
  note: string;
}

export class EquipmentError extends Error {
  key: MessageKey;
  constructor(key: MessageKey) {
    super(key);
    this.key = key;
  }
}

const MESSAGES: [RegExp, MessageKey][] = [
  [/lower than the last one/, 'eq.err.meterBack'],
  [/More than 1,000 hours/, 'eq.err.meterJump'],
  [/hour meter reading/, 'eq.err.meter'],
  [/liters issued/, 'eq.err.liters'],
  [/Choose the fuel/, 'eq.err.fuel'],
  [/counted in liters/, 'eq.err.fuelUnit'],
  [/Insufficient stock/, 'eq.err.stock'],
  [/Describe the service/, 'eq.err.description'],
  [/future/, 'prd.err.future'],
  [/retired/, 'eq.err.inactive'],
  [/already has this code/, 'eq.err.codeTaken'],
  [/code and a name/, 'eq.err.name'],
  [/cannot be negative/, 'eq.err.numbers'],
  [/Give a reason/, 'prd.err.reason'],
  [/Only the Owner or an Admin/, 'eq.err.ownerOnly'],
  [/books are closed/, 'wb.err.booksClosed'],
  [/module is switched off/, 'industry.moduleOff'],
  [/role does not allow/, 'wb.err.role'],
];

function fail(error: { message?: string } | null): never {
  const message = error?.message ?? '';
  const hit = MESSAGES.find(([pattern]) => pattern.test(message));
  throw new EquipmentError(hit ? hit[1] : 'eq.err.failed');
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const equipmentService = {
  async overview(from: string, to: string): Promise<EquipmentRow[]> {
    const { data, error } = await createClient().rpc('erp_equipment_overview', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
    });
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      id: r.equipment_id,
      code: r.code,
      name: r.name,
      kind: r.kind,
      hourMeter: Number(r.hour_meter ?? 0),
      serviceIntervalHours: num(r.service_interval_hours),
      lastServiceHours: num(r.last_service_hours),
      lastServiceDate: r.last_service_date ?? null,
      serviceDueIn: num(r.service_due_in),
      active: !!r.active,
      hours: Number(r.hours ?? 0),
      liters: Number(r.liters ?? 0),
      fuelCost: Number(r.fuel_cost ?? 0),
      litersPerHour: num(r.liters_per_hour),
      services: Number(r.services ?? 0),
    }));
  },

  /** Initial meter and note are not in the overview. */
  async details(id: string): Promise<{ initialHourMeter: number; note: string }> {
    const { data, error } = await createClient()
      .from('erp_equipment')
      .select('initial_hour_meter, note')
      .eq('id', id)
      .maybeSingle();
    if (error) fail(error);
    return { initialHourMeter: Number(data?.initial_hour_meter ?? 0), note: data?.note ?? '' };
  },

  async logs(from: string, to: string): Promise<EquipmentLog[]> {
    const { data, error } = await createClient()
      .from('erp_equipment_logs')
      .select(
        'id, equipment_id, kind, log_date, hour_meter, hours_worked, liters, fuel_product_name, amount, description, ' +
          'operator, note, status, reverse_reason'
      )
      .eq('workspace_id', rpcWorkspaceId())
      .gte('log_date', from)
      .lte('log_date', to)
      .order('log_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      id: r.id,
      equipmentId: r.equipment_id,
      kind: r.kind,
      logDate: r.log_date,
      hourMeter: num(r.hour_meter),
      hoursWorked: num(r.hours_worked),
      liters: num(r.liters),
      fuelProductName: r.fuel_product_name ?? '',
      amount: num(r.amount),
      description: r.description ?? '',
      operator: r.operator ?? '',
      note: r.note ?? '',
      status: r.status,
      reverseReason: r.reverse_reason ?? '',
    }));
  },

  async fuels(): Promise<{ id: string; name: string; stock: number }[]> {
    const { data, error } = await createClient()
      .from('erp_products')
      .select('id, name, current_stock')
      .eq('workspace_id', rpcWorkspaceId())
      .eq('unit', 'l')
      .order('name', { ascending: true });
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      stock: Number(r.current_stock ?? 0),
    }));
  },

  async save(id: string | null, input: EquipmentInput): Promise<string> {
    const { data, error } = await createClient().rpc('erp_equipment_save', {
      p_workspace_id: rpcWorkspaceId(),
      p_equipment: { ...input, id },
    });
    if (error) fail(error);
    return String(data);
  },

  async log(input: LogInput): Promise<string> {
    const { data, error } = await createClient().rpc('erp_equipment_log', {
      p_workspace_id: rpcWorkspaceId(),
      p_log: input,
    });
    if (error) fail(error);
    return String(data);
  },

  async reverse(id: string, reason: string) {
    const { error } = await createClient().rpc('erp_equipment_log_reverse', {
      p_log_id: id,
      p_reason: reason,
    });
    if (error) fail(error);
  },
};
