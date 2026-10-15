'use client';

import { createClient } from '@/lib/data/client';
import type { MessageKey } from '@/lib/i18n/messages';
import type { BankFormat, StatementLine } from '@/lib/finance/bankCsv';
import { rpcWorkspaceId } from './workspace';

// Cash and bank accounts, bank reconciliation and fixed assets
// (db/migrations/20261012000054_erp_finance.sql, docs/FINANCE.md).

export interface CashAccount {
  id: string;
  name: string;
  kind: 'cash' | 'bank';
  bankName: string;
  accountNo: string;
  glCode: string;
  active: boolean;
  isDefault: boolean;
  balance: number;
  openLines: number;
  lastStatementDate: string | null;
}

export interface CashTransfer {
  entryId: string;
  entryNo: number;
  date: string;
  memo: string;
  amount: number;
  from: string | null;
  to: string | null;
  voided: boolean;
}

export type LineStatus = 'open' | 'matched' | 'ignored';

export interface BankLine {
  id: string;
  statementId: string;
  lineNo: number;
  date: string;
  description: string;
  reference: string;
  amount: number;
  balance: number | null;
  status: LineStatus;
  journalLineId: string | null;
  note: string;
}

export interface BankStatement {
  id: string;
  fileName: string;
  format: BankFormat;
  from: string;
  to: string;
  lineCount: number;
  duplicateCount: number;
  importedAt: string;
}

export interface LedgerCandidate {
  journalLineId: string;
  entryNo: number;
  date: string;
  memo: string;
  sourceType: string;
  amount: number;
  daysApart: number;
}

export interface Reconciliation {
  asOf: string;
  firstLineDate: string | null;
  ledgerBalance: number;
  bankBalance: number | null;
  bankBalanceDate: string | null;
  openLines: number;
  openLinesTotal: number;
  unmatchedLedger: number;
  unmatchedLedgerTotal: number;
  difference: number | null;
}

export type AssetCategory =
  | 'land'
  | 'building'
  | 'vehicle'
  | 'heavy_equipment'
  | 'machinery'
  | 'office'
  | 'other';
export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  'heavy_equipment',
  'vehicle',
  'machinery',
  'building',
  'land',
  'office',
  'other',
];
export type DepreciationMethod = 'straight_line' | 'declining_balance' | 'none';
export type AssetFunding = 'cash' | 'payable' | 'opening' | 'recorded';

export interface FixedAsset {
  id: string;
  assetNo: string;
  name: string;
  category: AssetCategory;
  equipmentId: string | null;
  acquisitionDate: string;
  cost: number;
  salvageValue: number;
  lifeMonths: number;
  method: DepreciationMethod;
  decliningRate: number | null;
  depreciationStart: string;
  accumulated: number;
  bookValue: number;
  depreciatedThrough: string | null;
  status: 'active' | 'disposed' | 'void';
  disposedOn: string | null;
  disposalProceeds: number | null;
  note: string;
}

export interface AssetInput {
  name: string;
  asset_no?: string;
  category: AssetCategory;
  equipment_id?: string | null;
  acquisition_date: string;
  cost: number;
  salvage_value: number;
  useful_life_months: number;
  method: DepreciationMethod;
  declining_rate?: number | null;
  depreciation_start?: string | null;
  prior_months?: number;
  prior_accumulated?: number;
  funding: AssetFunding;
  cash_account_id?: string | null;
  note?: string;
}

export interface ScheduleRow {
  period: string;
  amount: number;
  accumulated: number;
  bookValue: number;
  posted: boolean;
}

export class FinanceError extends Error {
  key: MessageKey;
  constructor(key: MessageKey) {
    super(key);
    this.key = key;
  }
}

const MESSAGES: [RegExp, MessageKey][] = [
  [/name for the account/, 'fin.err.name'],
  [/account with this name exists/, 'fin.err.duplicate'],
  [/default cash account cannot be closed/, 'fin.err.default'],
  [/Move the balance/, 'fin.err.balance'],
  [/active cash or bank account/, 'fin.err.cashAccount'],
  [/two different accounts/, 'fin.err.same'],
  [/positive amount/, 'fin.err.amount'],
  [/already void/, 'fin.err.alreadyVoid'],
  [/unmatch it first|Unmatch its lines|Unmatch this line/, 'fin.err.matched'],
  [/no lines/, 'fin.err.empty'],
  [/at most 5000 lines/, 'fin.err.tooMany'],
  [/invalid date or amount/, 'fin.err.invalidLine'],
  [/dated in the future or before 2000/, 'fin.err.dateRange'],
  [/already matched/, 'fin.err.alreadyMatched'],
  [/same amount that is not matched/, 'fin.err.notCandidate'],
  [/why this line/, 'fin.err.note'],
  [/Only an open line/, 'fin.err.notOpen'],
  [/another active account/, 'fin.err.account'],
  [/name and the acquisition date/, 'fin.err.assetRequired'],
  [/salvage value below/, 'fin.err.assetAmounts'],
  [/useful life/, 'fin.err.life'],
  [/declining rate/, 'fin.err.rate'],
  [/already taken does not fit/, 'fin.err.prior'],
  [/bought now has no depreciation/, 'fin.err.priorNew'],
  [/cannot start before/, 'fin.err.start'],
  [/closed period/, 'fin.err.closedStart'],
  [/Equipment not found/, 'fin.err.equipment'],
  [/active asset account/, 'fin.err.assetAccount'],
  [/Depreciation is posted for this asset/, 'fin.err.depreciated'],
  [/Depreciation is posted after/, 'fin.err.depreciatedAfter'],
  [/between the acquisition and today/, 'fin.err.disposeDate'],
  [/Only an active asset/, 'fin.err.notActive'],
  [/proceeds cannot be negative/, 'fin.err.amount'],
  [/up to the current month/, 'fin.err.futureMonth'],
  [/Enter a reason/, 'prd.err.reason'],
  [/cannot be in the future/, 'prd.err.future'],
  [/books are closed/, 'wb.err.booksClosed'],
  [/role does not allow|not allowed/, 'wb.err.role'],
];

function fail(error: { message?: string } | null): never {
  const message = error?.message ?? '';
  const hit = MESSAGES.find(([pattern]) => pattern.test(message));
  throw new FinanceError(hit ? hit[1] : 'fin.err.failed');
}

const num = (v: unknown) => Number(v ?? 0);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) fail(error);
  return data as T;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const mapLine = (r: Row): BankLine => ({
  id: r.id,
  statementId: r.statement_id,
  lineNo: r.line_no,
  date: r.line_date,
  description: r.description,
  reference: r.reference,
  amount: num(r.amount),
  balance: numOrNull(r.balance),
  status: r.status,
  journalLineId: r.journal_line_id,
  note: r.note,
});

const mapAsset = (r: Row): FixedAsset => ({
  id: r.id,
  assetNo: r.asset_no,
  name: r.name,
  category: r.category,
  equipmentId: r.equipment_id,
  acquisitionDate: r.acquisition_date,
  cost: num(r.cost),
  salvageValue: num(r.salvage_value),
  lifeMonths: r.useful_life_months,
  method: r.method,
  decliningRate: numOrNull(r.declining_rate),
  depreciationStart: r.depreciation_start,
  accumulated: num(r.accumulated),
  bookValue: num(r.cost) - num(r.accumulated),
  depreciatedThrough: r.depreciated_through,
  status: r.status,
  disposedOn: r.disposed_on,
  disposalProceeds: numOrNull(r.disposal_proceeds),
  note: r.note,
});

export const financeService = {
  // ─── Cash and bank accounts ────────────────────────────────────────────────
  async accounts(asOf?: string): Promise<CashAccount[]> {
    const rows = await rpc<Row[]>('erp_cash_account_list', {
      p_workspace_id: rpcWorkspaceId(),
      p_as_of: asOf ?? null,
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      bankName: r.bank_name,
      accountNo: r.account_no,
      glCode: r.gl_code,
      active: r.is_active,
      isDefault: r.is_default,
      balance: num(r.balance),
      openLines: r.open_lines ?? 0,
      lastStatementDate: r.last_statement_date,
    }));
  },

  async createAccount(input: {
    name: string;
    kind: 'cash' | 'bank';
    bankName: string;
    accountNo: string;
  }) {
    return rpc<string>('erp_cash_account_create', {
      p_workspace_id: rpcWorkspaceId(),
      p: {
        name: input.name,
        kind: input.kind,
        bank_name: input.bankName,
        account_no: input.accountNo,
      },
    });
  },

  async updateAccount(
    id: string,
    input: Partial<{ name: string; bankName: string; accountNo: string; active: boolean }>
  ) {
    const p: Row = {};
    if (input.name !== undefined) p.name = input.name;
    if (input.bankName !== undefined) p.bank_name = input.bankName;
    if (input.accountNo !== undefined) p.account_no = input.accountNo;
    if (input.active !== undefined) p.is_active = input.active;
    await rpc('erp_cash_account_update', { p_id: id, p });
  },

  async transfer(from: string, to: string, amount: number, date: string, memo: string) {
    return rpc<string>('erp_cash_transfer', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
      p_amount: amount,
      p_date: date,
      p_memo: memo,
    });
  },

  async transfers(from: string, to: string): Promise<CashTransfer[]> {
    const rows = await rpc<Row[]>('erp_cash_transfer_list', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
    });
    return (rows ?? []).map((r) => ({
      entryId: r.entry_id,
      entryNo: r.entry_no,
      date: r.entry_date,
      memo: r.memo,
      amount: num(r.amount),
      from: r.from_account,
      to: r.to_account,
      voided: r.voided,
    }));
  },

  async voidTransfer(entryId: string) {
    await rpc('erp_cash_transfer_void', { p_workspace_id: rpcWorkspaceId(), p_entry_id: entryId });
  },

  // ─── Bank statements ───────────────────────────────────────────────────────
  async importStatement(
    accountId: string,
    statement: {
      fileName: string;
      format: BankFormat;
      opening: number | null;
      closing: number | null;
      lines: StatementLine[];
    }
  ): Promise<{ statementId: string | null; imported: number; duplicates: number }> {
    const r = await rpc<Row>('erp_bank_statement_import', {
      p_workspace_id: rpcWorkspaceId(),
      p_cash_account_id: accountId,
      p: {
        file_name: statement.fileName,
        format: statement.format,
        opening_balance: statement.opening,
        closing_balance: statement.closing,
        lines: statement.lines.map((l) => ({
          date: l.date,
          description: l.description,
          reference: l.reference,
          amount: l.amount,
          balance: l.balance,
        })),
      },
    });
    return { statementId: r.statement_id, imported: r.imported, duplicates: r.duplicates };
  },

  async statements(accountId: string): Promise<BankStatement[]> {
    const { data, error } = await createClient()
      .from('erp_bank_statements')
      .select(
        'id, file_name, bank_format, date_from, date_to, line_count, duplicate_count, imported_at'
      )
      .eq('cash_account_id', accountId)
      .order('imported_at', { ascending: false })
      .limit(50);
    if (error) fail(error);
    return (data ?? []).map((r: Row) => ({
      id: r.id,
      fileName: r.file_name,
      format: r.bank_format,
      from: r.date_from,
      to: r.date_to,
      lineCount: r.line_count,
      duplicateCount: r.duplicate_count,
      importedAt: r.imported_at,
    }));
  },

  async deleteStatement(id: string) {
    await rpc('erp_bank_statement_delete', { p_statement_id: id });
  },

  async lines(
    accountId: string,
    from: string,
    to: string,
    status: LineStatus | 'all'
  ): Promise<BankLine[]> {
    let query = createClient()
      .from('erp_bank_statement_lines')
      .select(
        'id, statement_id, line_no, line_date, description, reference, amount, balance, status, journal_line_id, note'
      )
      .eq('cash_account_id', accountId)
      .gte('line_date', from)
      .lte('line_date', to);
    if (status !== 'all') query = query.eq('status', status);
    const { data, error } = await query
      .order('line_date', { ascending: true })
      .order('line_no', { ascending: true })
      .limit(2000);
    if (error) fail(error);
    return (data ?? []).map(mapLine);
  },

  async candidates(lineId: string): Promise<LedgerCandidate[]> {
    const rows = await rpc<Row[]>('erp_bank_line_candidates', { p_line_id: lineId });
    return (rows ?? []).map((r) => ({
      journalLineId: r.journal_line_id,
      entryNo: r.entry_no,
      date: r.entry_date,
      memo: r.memo,
      sourceType: r.source_type,
      amount: num(r.amount),
      daysApart: r.days_apart,
    }));
  },

  async match(lineId: string, journalLineId: string) {
    await rpc('erp_bank_line_match', { p_line_id: lineId, p_journal_line_id: journalLineId });
  },
  async unmatch(lineId: string) {
    await rpc('erp_bank_line_unmatch', { p_line_id: lineId });
  },
  async ignore(lineId: string, note: string) {
    await rpc('erp_bank_line_ignore', { p_line_id: lineId, p_note: note });
  },
  async postLine(lineId: string, accountId: string, memo: string) {
    return rpc<string>('erp_bank_line_post', {
      p_line_id: lineId,
      p_account_id: accountId,
      p_memo: memo,
    });
  },
  async autoMatch(accountId: string): Promise<number> {
    return rpc<number>('erp_bank_auto_match', {
      p_workspace_id: rpcWorkspaceId(),
      p_cash_account_id: accountId,
    });
  },

  async reconciliation(accountId: string, asOf: string): Promise<Reconciliation> {
    const r = await rpc<Row>('erp_bank_reconciliation', {
      p_workspace_id: rpcWorkspaceId(),
      p_cash_account_id: accountId,
      p_as_of: asOf,
    });
    return {
      asOf: r.as_of,
      firstLineDate: r.first_line_date,
      ledgerBalance: num(r.ledger_balance),
      bankBalance: numOrNull(r.bank_balance),
      bankBalanceDate: r.bank_balance_date,
      openLines: r.open_lines,
      openLinesTotal: num(r.open_lines_total),
      unmatchedLedger: r.unmatched_ledger,
      unmatchedLedgerTotal: num(r.unmatched_ledger_total),
      difference: numOrNull(r.difference),
    };
  },

  async unmatchedLedger(accountId: string, from: string, to: string): Promise<LedgerCandidate[]> {
    const rows = await rpc<Row[]>('erp_bank_unmatched_ledger', {
      p_workspace_id: rpcWorkspaceId(),
      p_cash_account_id: accountId,
      p_from: from,
      p_to: to,
    });
    return (rows ?? []).map((r) => ({
      journalLineId: r.journal_line_id,
      entryNo: r.entry_no,
      date: r.entry_date,
      memo: r.memo,
      sourceType: r.source_type,
      amount: num(r.amount),
      daysApart: 0,
    }));
  },

  // ─── Fixed assets ──────────────────────────────────────────────────────────
  async assets(): Promise<FixedAsset[]> {
    const ws = rpcWorkspaceId();
    // Without an active workspace, row-level security leaves the readable ones.
    let query = createClient().from('erp_fixed_assets').select('*');
    if (ws) query = query.eq('workspace_id', ws);
    const { data, error } = await query.order('acquisition_date', { ascending: false }).limit(1000);
    if (error) fail(error);
    return (data ?? []).map(mapAsset);
  },

  async createAsset(input: AssetInput) {
    return rpc<string>('erp_fixed_asset_create', { p_workspace_id: rpcWorkspaceId(), p: input });
  },

  async depreciate(through: string): Promise<{ assets: number; months: number; amount: number }> {
    const r = await rpc<Row>('erp_fixed_assets_depreciate', {
      p_workspace_id: rpcWorkspaceId(),
      p_through: through,
    });
    return { assets: r.assets, months: r.months, amount: num(r.amount) };
  },

  async dispose(
    id: string,
    date: string,
    proceeds: number,
    cashAccountId: string | null,
    note: string
  ) {
    await rpc('erp_fixed_asset_dispose', {
      p_asset_id: id,
      p_date: date,
      p_proceeds: proceeds,
      p_cash_account_id: cashAccountId,
      p_note: note,
    });
  },

  async voidAsset(id: string, reason: string) {
    await rpc('erp_fixed_asset_void', { p_asset_id: id, p_reason: reason });
  },

  async schedule(id: string): Promise<ScheduleRow[]> {
    const rows = await rpc<Row[]>('erp_fixed_asset_schedule', { p_asset_id: id });
    return (rows ?? []).map((r) => ({
      period: r.period,
      amount: num(r.amount),
      accumulated: num(r.accumulated),
      bookValue: num(r.book_value),
      posted: r.posted,
    }));
  },
};
