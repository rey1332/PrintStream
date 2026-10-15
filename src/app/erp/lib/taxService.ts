'use client';

import { createClient } from '@/lib/data/client';
import type { MessageKey } from '@/lib/i18n/messages';
import { rpcWorkspaceId } from './workspace';

// Indonesian tax (db/migrations/20261012000053_erp_indonesian_tax.sql, docs/TAX.md).

export const TRX_CODES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'] as const;
export type TaxIdType = 'npwp' | 'nik' | 'passport' | 'other';
export type FakturStatus = 'none' | 'exported' | 'approved';
export type FakturMissing =
  | 'seller_npwp'
  | 'seller_nitku'
  | 'customer'
  | 'customer_tax_id'
  | 'customer_nitku'
  | 'lines'
  | 'currency';

export interface FakturRow {
  invoiceId: string;
  docNo: string | null;
  invoiceDate: string;
  customerName: string;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  trxCode: string;
  status: FakturStatus;
  fakturNumber: string | null;
  fakturDate: string | null;
  exportedAt: string | null;
  missing: FakturMissing[];
}

export interface SupplierBill {
  id: string;
  supplierName: string;
  billNo: string;
  billDate: string;
  dueDate: string;
  description: string;
  subtotal: number;
  ppnAmount: number;
  fakturNumber: string | null;
  pph23Rate: number;
  pph23Amount: number;
  pph23ObjectCode: string;
  bupotNumber: string;
  bupotDate: string | null;
  totalPayable: number;
  amountPaid: number;
  status: 'open' | 'paid' | 'void';
  voidReason: string;
  /** Whether the supplier has a tax ID on record (the number is only in the PPh 23 export). */
  supplierHasTaxId: boolean;
}

export interface BillInput {
  supplier_id: string | null;
  supplier_name: string;
  bill_no: string;
  bill_date: string;
  due_date: string;
  description: string;
  expense_account_id: string | null;
  subtotal: number;
  ppn_amount: number;
  faktur_number: string;
  faktur_date: string;
  pph23_rate: number;
  pph23_object_code: string;
}

export interface TaxMonth {
  month: string;
  ppnOut: number;
  ppnIn: number;
  ppnNet: number;
  pph21: number;
  pph23Withheld: number;
  pph23Prepaid: number;
  billsWithPph23: number;
  billsWithoutBupot: number;
  invoicesTaxed: number;
  invoicesWithoutFaktur: number;
}

export type FakturProblem = { invoice: string; kind: string; booked?: number; faktur?: number };

export class TaxError extends Error {
  key: MessageKey;
  problems: FakturProblem[];
  constructor(key: MessageKey, problems: FakturProblem[] = []) {
    super(key);
    this.key = key;
    this.problems = problems;
  }
}

const MESSAGES: [RegExp, MessageKey][] = [
  [/faktur number has 17 digits/, 'tax.err.fakturNumber'],
  [/already has this faktur number/, 'tax.err.fakturTaken'],
  [/transaction code cannot change/, 'tax.err.approved'],
  [/Only taxed/, 'tax.err.invoices'],
  [/needs the supplier's faktur number/, 'tax.err.fakturRequired'],
  [/tax object code/, 'tax.err.objectCode'],
  [/supplier, the date and what the bill is for/, 'tax.err.required'],
  [/due date is before/, 'tax.err.due'],
  [/amount before tax/, 'tax.err.amounts'],
  [/at most what is still/, 'tax.err.amount'],
  [/Void its payments first/, 'tax.err.paid'],
  [/bukti potong was issued/, 'tax.err.bupotIssued'],
  [/bukti potong number/, 'tax.err.bupotRequired'],
  [/has no PPh 23/, 'tax.err.noPph23'],
  [/is void/, 'tax.err.void'],
  [/expense or asset account/, 'tax.err.account'],
  [/base currency/, 'tax.err.currency'],
  [/Check the bill/, 'tax.err.check'],
  [/Only the Owner or an Admin/, 'tax.err.ownerOnly'],
  [/Give a reason/, 'prd.err.reason'],
  [/future/, 'prd.err.future'],
  [/books are closed/, 'wb.err.booksClosed'],
  [/role does not allow/, 'wb.err.role'],
];

function fail(error: { message?: string } | null): never {
  const message = error?.message ?? '';
  const hit = MESSAGES.find(([pattern]) => pattern.test(message));
  throw new TaxError(hit ? hit[1] : 'tax.err.failed');
}

const num = (v: unknown) => Number(v ?? 0);

export const taxService = {
  async faktur(from: string, to: string): Promise<FakturRow[]> {
    const { data, error } = await createClient().rpc('erp_tax_faktur_list', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
    });
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      invoiceId: r.invoice_id,
      docNo: r.doc_no,
      invoiceDate: r.invoice_date,
      customerName: r.customer_name,
      subtotal: num(r.subtotal),
      taxRate: num(r.tax_rate),
      taxAmount: num(r.tax_amount),
      total: num(r.total),
      trxCode: r.trx_code,
      status: r.faktur_status,
      fakturNumber: r.faktur_number,
      fakturDate: r.faktur_date,
      exportedAt: r.exported_at,
      missing: r.missing ?? [],
    }));
  },

  /** The Coretax XML for the chosen invoices, as a file to save. */
  async coretax(invoiceIds: string[]): Promise<{ blob: Blob; fileName: string }> {
    const response = await fetch('/api/erp/tax/coretax', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: rpcWorkspaceId(), invoiceIds }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (body?.error === 'two_factor') throw new TaxError('tax.err.twoFactor');
      if (body?.error === 'problems') throw new TaxError('tax.err.problems', body.problems ?? []);
      if (body?.error === 'forbidden') throw new TaxError('wb.err.role');
      throw new TaxError('tax.err.failed');
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'coretax-faktur.xml';
    return { blob: await response.blob(), fileName };
  },

  async setFaktur(invoiceId: string, trxCode: string | null, number: string, date: string | null) {
    const { error } = await createClient().rpc('erp_tax_faktur_set', {
      p_invoice_id: invoiceId,
      p_trx_code: trxCode,
      p_number: number || null,
      p_date: date || null,
    });
    if (error) fail(error);
  },

  async pph23Withheld(invoiceId: string, amount: number, date: string, bupotNumber: string) {
    const { error } = await createClient().rpc('erp_invoice_pph23_withheld', {
      p_invoice_id: invoiceId,
      p_amount: amount,
      p_date: date,
      p_bupot_number: bupotNumber,
    });
    if (error) fail(error);
  },

  async bills(from: string, to: string): Promise<SupplierBill[]> {
    const { data, error } = await createClient()
      .from('erp_supplier_bills')
      .select(
        'id, supplier_name, bill_no, bill_date, due_date, description, subtotal, ppn_amount, faktur_number, ' +
          'pph23_rate, pph23_amount, pph23_object_code, bupot_number, bupot_date, total_payable, amount_paid, status, ' +
          'void_reason, supplier:erp_suppliers(tax_id_type)'
      )
      .eq('workspace_id', rpcWorkspaceId())
      .gte('bill_date', from)
      .lte('bill_date', to)
      .order('bill_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      id: r.id,
      supplierName: r.supplier_name,
      billNo: r.bill_no ?? '',
      billDate: r.bill_date,
      dueDate: r.due_date,
      description: r.description,
      subtotal: num(r.subtotal),
      ppnAmount: num(r.ppn_amount),
      fakturNumber: r.faktur_number,
      pph23Rate: num(r.pph23_rate),
      pph23Amount: num(r.pph23_amount),
      pph23ObjectCode: r.pph23_object_code ?? '',
      bupotNumber: r.bupot_number ?? '',
      bupotDate: r.bupot_date,
      totalPayable: num(r.total_payable),
      amountPaid: num(r.amount_paid),
      status: r.status,
      voidReason: r.void_reason ?? '',
      supplierHasTaxId: !!r.supplier?.tax_id_type,
    }));
  },

  async suppliers(): Promise<{ id: string; name: string; hasTaxId: boolean }[]> {
    const { data, error } = await createClient()
      .from('erp_suppliers')
      .select('id, name, tax_id_type')
      .eq('workspace_id', rpcWorkspaceId())
      .order('name', { ascending: true })
      .limit(2000);
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({ id: r.id, name: r.name, hasTaxId: !!r.tax_id_type }));
  },

  async expenseAccounts(): Promise<{ id: string; code: string; name: string }[]> {
    const { data, error } = await createClient()
      .from('erp_gl_accounts')
      .select('id, code, name, account_type')
      .eq('workspace_id', rpcWorkspaceId())
      .eq('is_active', true)
      .in('account_type', ['expense', 'asset'])
      .order('code', { ascending: true });
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({ id: r.id, code: r.code, name: r.name }));
  },

  async createBill(bill: BillInput): Promise<string> {
    const { data, error } = await createClient().rpc('erp_supplier_bill_create', {
      p_workspace_id: rpcWorkspaceId(),
      p_bill: bill,
    });
    if (error) fail(error);
    return data as string;
  },

  async payBill(id: string, amount: number, date: string, method: string) {
    const { error } = await createClient().rpc('erp_supplier_bill_pay', {
      p_bill_id: id,
      p_amount: amount,
      p_date: date,
      p_method: method,
    });
    if (error) fail(error);
  },

  async bupot(id: string, number: string, date: string) {
    const { error } = await createClient().rpc('erp_supplier_bill_bupot', {
      p_bill_id: id,
      p_number: number,
      p_date: date,
    });
    if (error) fail(error);
  },

  async voidBill(id: string, reason: string) {
    const { error } = await createClient().rpc('erp_supplier_bill_void', {
      p_bill_id: id,
      p_reason: reason,
    });
    if (error) fail(error);
  },

  /** The period's bills with PPh 23 as CSV for e-Bupot (two-factor, like every export). */
  async pph23Csv(from: string, to: string): Promise<{ blob: Blob; fileName: string }> {
    const response = await fetch('/api/erp/tax/pph23', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: rpcWorkspaceId(), from, to }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new TaxError(body?.error === 'two_factor' ? 'tax.err.twoFactor' : 'tax.err.failed');
    }
    const name =
      /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
      'pph23.csv';
    return { blob: await response.blob(), fileName: name };
  },

  async summary(from: string, to: string): Promise<TaxMonth[]> {
    const { data, error } = await createClient().rpc('erp_tax_summary', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
    });
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      month: r.month,
      ppnOut: num(r.ppn_out),
      ppnIn: num(r.ppn_in),
      ppnNet: num(r.ppn_net),
      pph21: num(r.pph21),
      pph23Withheld: num(r.pph23_withheld),
      pph23Prepaid: num(r.pph23_prepaid),
      billsWithPph23: num(r.bills_with_pph23),
      billsWithoutBupot: num(r.bills_without_bupot),
      invoicesTaxed: num(r.invoices_taxed),
      invoicesWithoutFaktur: num(r.invoices_without_faktur),
    }));
  },
};

/** NPWP / NIK: 16 digits; NITKU: 22 digits. Returns the message of what is wrong, or null. */
export function taxDataProblem(t: {
  idType: TaxIdType | null;
  id: string;
  nitku: string;
}): MessageKey | null {
  const id = t.id.replace(/\D/g, '');
  if (t.idType === 'npwp' || t.idType === 'nik') {
    if (id.length !== 16) return t.idType === 'npwp' ? 'tax.err.npwp' : 'tax.err.nik';
  } else if (t.idType && !t.id.trim()) return 'tax.err.otherId';
  if (t.nitku && t.nitku.replace(/\D/g, '').length !== 22) return 'tax.err.nitku';
  return null;
}

// ─── Tax data of customers and suppliers ─────────────────────────────────────

export interface PartyTax {
  idType: TaxIdType | null;
  id: string;
  nitku: string;
  isPkp: boolean;
  name: string;
  address: string;
}

export const emptyPartyTax = (): PartyTax => ({
  idType: null,
  id: '',
  nitku: '',
  isPkp: false,
  name: '',
  address: '',
});

/** Row → form value. */
export function partyTaxFrom(r: any): PartyTax {
  return {
    idType: r?.tax_id_type ?? null,
    id: r?.tax_id ?? '',
    nitku: r?.nitku ?? '',
    isPkp: !!r?.is_pkp,
    name: r?.tax_name ?? '',
    address: r?.tax_address ?? '',
  };
}

/** Form value → columns. */
export function partyTaxColumns(v: PartyTax) {
  return {
    tax_id_type: v.idType,
    tax_id: v.idType ? v.id.trim() : '',
    nitku: v.idType === 'npwp' ? v.nitku : '',
    is_pkp: v.isPkp,
    tax_name: v.name.trim(),
    tax_address: v.address.trim(),
  };
}
