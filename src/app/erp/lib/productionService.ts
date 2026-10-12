'use client';

import { createClient } from '@/lib/data/client';
import type { MessageKey } from '@/lib/i18n/messages';
import { rpcWorkspaceId } from './workspace';

// Production module (db/migrations/20261012000025_erp_production.sql).

export interface ProductionOutput {
  productId: string | null;
  productName: string;
  qty: number;
  unit: string;
  warehouseId: string | null;
}

export interface ProductionRun {
  id: string;
  docNo: string;
  runDate: string;
  shift: string;
  plant: string;
  hours: number;
  downtimeHours: number;
  inputProductName: string;
  inputQty: number | null;
  inputUnit: string | null;
  note: string;
  status: 'posted' | 'reversed';
  reverseReason: string;
  outputs: ProductionOutput[];
}

export interface ProductionInput {
  run_date: string;
  shift: string;
  plant: string;
  hours: number;
  downtime_hours: number;
  note: string;
  input: { product_id: string; qty: number; warehouse_id: string | null } | null;
  outputs: { product_id: string; qty: number; warehouse_id: string | null }[];
}

export interface ProductionTotal {
  productId: string | null;
  productName: string;
  unit: string;
  qty: number;
}

export interface ProductionSummary {
  runs: number;
  hours: number;
  downtimeHours: number;
  outputs: ProductionTotal[];
  inputs: ProductionTotal[];
  days: {
    date: string;
    runs: number;
    hours: number;
    downtimeHours: number;
    outputs: { productName: string; unit: string; qty: number }[];
  }[];
}

export interface Stockpile {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}

export class ProductionError extends Error {
  key: MessageKey;
  constructor(key: MessageKey) {
    super(key);
    this.key = key;
  }
}

const MESSAGES: [RegExp, MessageKey][] = [
  [/at least one product/, 'prd.err.outputs'],
  [/greater than zero/, 'prd.err.qty'],
  [/only once/, 'prd.err.duplicate'],
  [/both made and used/, 'prd.err.same'],
  [/Insufficient stock/, 'prd.err.stock'],
  [/in that stockpile/, 'prd.err.stockpile'],
  [/future/, 'prd.err.future'],
  [/between 0 and 24/, 'prd.err.hours'],
  [/Give a reason/, 'prd.err.reason'],
  [/Only the Owner or an Admin/, 'prd.err.ownerOnly'],
  [/books are closed/, 'wb.err.booksClosed'],
  [/module is switched off/, 'industry.moduleOff'],
  [/role does not allow/, 'wb.err.role'],
];

function fail(error: { message?: string } | null): never {
  const message = error?.message ?? '';
  const hit = MESSAGES.find(([pattern]) => pattern.test(message));
  throw new ProductionError(hit ? hit[1] : 'prd.err.failed');
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const productionService = {
  async runs(from: string, to: string): Promise<ProductionRun[]> {
    const { data, error } = await createClient()
      .from('erp_production_runs')
      .select(
        'id, doc_no, run_date, shift, plant, hours, downtime_hours, input_product_name, input_qty, input_unit, note, ' +
          'status, reverse_reason, outputs:erp_production_outputs(product_id, product_name, qty, unit, warehouse_id)'
      )
      .eq('workspace_id', rpcWorkspaceId())
      .gte('run_date', from)
      .lte('run_date', to)
      .order('run_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      id: r.id,
      docNo: r.doc_no ?? '',
      runDate: r.run_date,
      shift: r.shift ?? '',
      plant: r.plant ?? '',
      hours: Number(r.hours ?? 0),
      downtimeHours: Number(r.downtime_hours ?? 0),
      inputProductName: r.input_product_name ?? '',
      inputQty: num(r.input_qty),
      inputUnit: r.input_unit ?? null,
      note: r.note ?? '',
      status: r.status,
      reverseReason: r.reverse_reason ?? '',
      outputs: (r.outputs ?? []).map((o: any) => ({
        productId: o.product_id,
        productName: o.product_name,
        qty: Number(o.qty),
        unit: o.unit,
        warehouseId: o.warehouse_id,
      })),
    }));
  },

  async summary(from: string, to: string): Promise<ProductionSummary> {
    const { data, error } = await createClient().rpc('erp_production_summary', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
    });
    if (error) fail(error);
    const s = (data ?? {}) as any;
    const totals = (rows: any[]): ProductionTotal[] =>
      (rows ?? []).map((r) => ({
        productId: r.product_id ?? null,
        productName: r.product_name ?? '',
        unit: r.unit ?? '',
        qty: Number(r.qty ?? 0),
      }));
    return {
      runs: Number(s.runs ?? 0),
      hours: Number(s.hours ?? 0),
      downtimeHours: Number(s.downtime_hours ?? 0),
      outputs: totals(s.outputs),
      inputs: totals(s.inputs),
      days: (s.days ?? []).map((d: any) => ({
        date: d.date,
        runs: Number(d.runs ?? 0),
        hours: Number(d.hours ?? 0),
        downtimeHours: Number(d.downtime_hours ?? 0),
        outputs: (d.outputs ?? []).map((o: any) => ({
          productName: o.product_name,
          unit: o.unit,
          qty: Number(o.qty ?? 0),
        })),
      })),
    };
  },

  async stockpiles(): Promise<Stockpile[]> {
    const { data, error } = await createClient()
      .from('erp_warehouses')
      .select('id, code, name, is_default, is_active')
      .eq('workspace_id', rpcWorkspaceId())
      .order('code', { ascending: true });
    if (error) fail(error);
    return (data ?? [])
      .filter((w: any) => w.is_active !== false)
      .map((w: any) => ({ id: w.id, code: w.code, name: w.name, isDefault: !!w.is_default }));
  },

  async record(input: ProductionInput): Promise<string> {
    const { data, error } = await createClient().rpc('erp_production_record', {
      p_workspace_id: rpcWorkspaceId(),
      p_run: input,
    });
    if (error) fail(error);
    return String(data);
  },

  async reverse(id: string, reason: string) {
    const { error } = await createClient().rpc('erp_production_reverse', {
      p_run_id: id,
      p_reason: reason,
    });
    if (error) fail(error);
  },
};
