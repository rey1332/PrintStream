'use client';

import { createClient } from '@/lib/data/client';
import type { MessageKey } from '@/lib/i18n/messages';
import { rpcWorkspaceId } from './workspace';

// Weighbridge module (db/migrations/20261012000024_erp_weighbridge.sql).

export type TicketStatus = 'open' | 'completed' | 'cancelled';
export type VehicleKind = 'dump_truck' | 'trailer' | 'pickup' | 'other';
export const VEHICLE_KINDS: VehicleKind[] = ['dump_truck', 'trailer', 'pickup', 'other'];

export interface WeighTicket {
  id: string;
  workspaceId: string | null;
  docNo: string;
  ticketDate: string;
  status: TicketStatus;
  vehicleId: string | null;
  plateNo: string;
  driverName: string;
  customerId: string | null;
  customerName: string;
  productId: string | null;
  productName: string;
  unit: string;
  firstKg: number;
  firstAt: string;
  secondKg: number | null;
  secondAt: string | null;
  netKg: number | null;
  qty: number | null;
  price: number;
  amount: number;
  invoiceId: string | null;
  note: string;
  creditOverride: string;
  cancelReason: string;
}

export interface Vehicle {
  id: string;
  plateNo: string;
  kind: VehicleKind;
  ownerName: string;
  customerId: string | null;
  driverName: string;
  tareKg: number | null;
  tareAt: string | null;
  active: boolean;
}

export interface VehicleInput {
  plate_no: string;
  kind: VehicleKind;
  owner_name: string;
  customer_id: string | null;
  driver_name: string;
  tare_kg: number | null;
  active: boolean;
}

export interface WeighCustomer {
  id: string;
  name: string;
  creditLimit: number | null;
  exposure: number | null;
}

export interface WeighInInput {
  vehicle_id?: string | null;
  plate_no?: string;
  driver_name?: string;
  customer_id?: string | null;
  customer_name?: string;
  product_id: string;
  first_kg: number;
  price?: number | null;
  note?: string;
  credit_override?: string;
}

export interface SummaryRow {
  productId: string | null;
  productName: string;
  unit: string;
  tickets: number;
  netKg: number;
  qty: number;
  amount: number;
}

export class WeighError extends Error {
  key: MessageKey;
  constructor(key: MessageKey, message = '') {
    super(message || key);
    this.key = key;
  }
}

const MESSAGES: [RegExp, MessageKey][] = [
  [/Credit limit/, 'wb.err.credit'],
  [/already has an open ticket/, 'wb.err.openTicket'],
  [/is blocked/, 'wb.err.blocked'],
  [/cannot be weighed/, 'wb.err.unit'],
  [/Set the density/, 'wb.err.density'],
  [/Enter the weight/, 'wb.err.weight'],
  [/Enter the plate/, 'wb.err.plate'],
  [/Choose a customer/, 'wb.err.customer'],
  [/same: nothing was loaded/, 'wb.err.netZero'],
  [/no stored empty weight/, 'wb.err.noTare'],
  [/Insufficient stock/, 'wb.err.stock'],
  [/changing prices/, 'wb.err.price'],
  [/already (completed|cancelled)/, 'wb.err.notOpen'],
  [/Give a reason/, 'wb.err.reason'],
  [/void the invoice first/, 'wb.err.invoiced'],
  [/Only the Owner or an Admin/, 'wb.err.ownerOnly'],
  [/No tickets to invoice/, 'wb.err.noTickets'],
  [/plate number already exists/, 'wb.err.plateTaken'],
  [/module is switched off/, 'industry.moduleOff'],
  [/books are closed/, 'wb.err.booksClosed'],
  [/role does not allow/, 'wb.err.role'],
];

function fail(error: { message?: string } | null): never {
  const message = error?.message ?? '';
  const hit = MESSAGES.find(([pattern]) => pattern.test(message));
  throw new WeighError(hit ? hit[1] : 'wb.err.failed', message);
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function mapTicket(r: any): WeighTicket {
  return {
    id: r.id,
    workspaceId: r.workspace_id ?? null,
    docNo: r.doc_no ?? '',
    ticketDate: r.ticket_date,
    status: r.status,
    vehicleId: r.vehicle_id,
    plateNo: r.plate_no,
    driverName: r.driver_name ?? '',
    customerId: r.customer_id,
    customerName: r.customer_name,
    productId: r.product_id,
    productName: r.product_name,
    unit: r.unit,
    firstKg: Number(r.first_kg),
    firstAt: r.first_at,
    secondKg: num(r.second_kg),
    secondAt: r.second_at,
    netKg: num(r.net_kg),
    qty: num(r.qty),
    price: Number(r.price),
    amount: Number(r.amount ?? 0),
    invoiceId: r.invoice_id,
    note: r.note ?? '',
    creditOverride: r.credit_override ?? '',
    cancelReason: r.cancel_reason ?? '',
  };
}

function mapVehicle(r: any): Vehicle {
  return {
    id: r.id,
    plateNo: r.plate_no,
    kind: r.kind,
    ownerName: r.owner_name ?? '',
    customerId: r.customer_id,
    driverName: r.driver_name ?? '',
    tareKg: num(r.tare_kg),
    tareAt: r.tare_at,
    active: !!r.active,
  };
}

const TICKET_COLUMNS =
  'id, workspace_id, doc_no, ticket_date, status, vehicle_id, plate_no, driver_name, customer_id, customer_name, product_id, ' +
  'product_name, unit, first_kg, first_at, second_kg, second_at, net_kg, qty, price, amount, invoice_id, note, ' +
  'credit_override, cancel_reason';

export const weighbridgeService = {
  /** Open tickets (any date) and tickets dated p_date. */
  async tickets(date: string): Promise<WeighTicket[]> {
    const ws = rpcWorkspaceId();
    const db = createClient();
    const [open, dated] = await Promise.all([
      db
        .from('erp_weigh_tickets')
        .select(TICKET_COLUMNS)
        .eq('workspace_id', ws)
        .eq('status', 'open')
        .order('first_at', { ascending: true })
        .limit(500),
      db
        .from('erp_weigh_tickets')
        .select(TICKET_COLUMNS)
        .eq('workspace_id', ws)
        .eq('ticket_date', date)
        .neq('status', 'open')
        .order('completed_at', { ascending: false })
        .limit(1000),
    ]);
    if (open.error) fail(open.error);
    if (dated.error) fail(dated.error);
    return [...(open.data ?? []), ...(dated.data ?? [])].map(mapTicket);
  },

  async ticket(id: string): Promise<WeighTicket | null> {
    const { data, error } = await createClient()
      .from('erp_weigh_tickets')
      .select(TICKET_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) fail(error);
    return data ? mapTicket(data) : null;
  },

  /** Completed tickets not yet invoiced, for the invoice tab. */
  async uninvoiced(): Promise<WeighTicket[]> {
    const { data, error } = await createClient()
      .from('erp_weigh_tickets')
      .select(TICKET_COLUMNS)
      .eq('workspace_id', rpcWorkspaceId())
      .eq('status', 'completed')
      .is('invoice_id', null)
      .order('ticket_date', { ascending: true })
      .limit(5000);
    if (error) fail(error);
    return (data ?? []).map(mapTicket);
  },

  async summary(from: string, to: string): Promise<SummaryRow[]> {
    const { data, error } = await createClient().rpc('erp_weighbridge_summary', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
    });
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      productId: r.product_id,
      productName: r.product_name,
      unit: r.unit,
      tickets: Number(r.tickets),
      netKg: Number(r.net_kg ?? 0),
      qty: Number(r.qty ?? 0),
      amount: Number(r.amount ?? 0),
    }));
  },

  async vehicles(): Promise<Vehicle[]> {
    const { data, error } = await createClient()
      .from('erp_vehicles')
      .select('id, plate_no, kind, owner_name, customer_id, driver_name, tare_kg, tare_at, active')
      .eq('workspace_id', rpcWorkspaceId())
      .order('plate_no', { ascending: true })
      .limit(2000);
    if (error) fail(error);
    return (data ?? []).map(mapVehicle);
  },

  async saveVehicle(id: string | null, input: VehicleInput): Promise<string> {
    const { data, error } = await createClient().rpc('erp_vehicle_save', {
      p_workspace_id: rpcWorkspaceId(),
      p_vehicle: { ...input, id },
    });
    if (error) fail(error);
    return String(data);
  },

  async customers(): Promise<WeighCustomer[]> {
    const { data, error } = await createClient().rpc('erp_weigh_customers', {
      p_workspace_id: rpcWorkspaceId(),
    });
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      creditLimit: num(r.credit_limit),
      exposure: num(r.exposure),
    }));
  },

  async weighIn(input: WeighInInput): Promise<string> {
    const { data, error } = await createClient().rpc('erp_weigh_in', {
      p_workspace_id: rpcWorkspaceId(),
      p_ticket: input,
    });
    if (error) fail(error);
    return String(data);
  },

  /** secondKg null = the truck's stored empty weight. */
  async weighOut(
    id: string,
    secondKg: number | null,
    price: number | null,
    override: string | null
  ) {
    const { error } = await createClient().rpc('erp_weigh_out', {
      p_ticket_id: id,
      p_second_kg: secondKg,
      p_price: price,
      p_credit_override: override,
    });
    if (error) fail(error);
  },

  async cancel(id: string, reason: string) {
    const { error } = await createClient().rpc('erp_weigh_cancel', {
      p_ticket_id: id,
      p_reason: reason,
    });
    if (error) fail(error);
  },

  async invoice(customerId: string, from: string, to: string, taxRate: number, dueDate: string) {
    const { data, error } = await createClient().rpc('erp_weigh_tickets_invoice', {
      p_workspace_id: rpcWorkspaceId(),
      p_customer_id: customerId,
      p_from: from,
      p_to: to,
      p_tax_rate: taxRate,
      p_due_date: dueDate || null,
    });
    if (error) fail(error);
    return String(data);
  },
};

/** Quantity in the product's unit for a net weight (as erp__weigh_qty). */
export function weighQty(netKg: number, unit: string, density: number | null): number | null {
  if (unit === 'rit') return 1;
  const tons = netKg / 1000;
  switch (unit) {
    case 'kg':
      return Math.round(netKg * 1000) / 1000;
    case 'ton':
      return Math.round(tons * 1000) / 1000;
    case 'm3':
      return density && density > 0 ? Math.round((tons / density) * 1000) / 1000 : null;
    case 'l':
      return density && density > 0 ? Math.round((netKg / density) * 1000) / 1000 : null;
    default:
      return null;
  }
}
