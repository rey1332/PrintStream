import { createClient } from '@/lib/data/client';
import { translateServerMessage, tr } from '@/lib/i18n/translate';
import { rpcWorkspaceId } from './workspace';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export const ACCOUNT_TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

export interface AccountingSettings {
  baseCurrency: string;
  lockDate: string | null;
  salesTaxRate: number;
  purchaseTaxRate: number;
  canManage: boolean;
  canPost: boolean;
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
  debit: number;
  credit: number;
  balance: number;
}

export interface JournalLine {
  accountId: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
  memo: string;
}

export interface JournalEntry {
  id: string;
  entryNo: number;
  date: string;
  memo: string;
  sourceType: string;
  sourceId: string | null;
  reversesEntryId: string | null;
  reversed: boolean;
  lines: JournalLine[];
}

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: string | null;
  active: boolean;
}

function fail(error: { code?: string; message?: string }): never {
  if (error.code === 'PGRST202' || error.code === '42883')
    throw new Error(tr('erp.error.needsUpdate'));
  throw new Error(error.message ? translateServerMessage(error.message) : tr('erp.error.generic'));
}

export const accountingService = {
  async settings(): Promise<AccountingSettings> {
    const { data, error } = await createClient().rpc('erp_accounting_settings_get', {
      p_workspace_id: rpcWorkspaceId(),
    });
    if (error) fail(error);
    const row = (Array.isArray(data) ? data[0] : data) ?? {};
    return {
      baseCurrency: row.base_currency ?? 'USD',
      lockDate: row.lock_date ?? null,
      salesTaxRate: Number(row.sales_tax_rate ?? 0),
      purchaseTaxRate: Number(row.purchase_tax_rate ?? 0),
      canManage: !!row.can_manage,
      canPost: !!row.can_post,
    };
  },

  async saveSettings(baseCurrency: string, lockDate: string | null, salesTaxRate: number) {
    const { error } = await createClient().rpc('erp_accounting_settings_set', {
      p_workspace_id: rpcWorkspaceId(),
      p_base_currency: baseCurrency,
      p_lock_date: lockDate || null,
      p_sales_tax_rate: salesTaxRate,
    });
    if (error) fail(error);
  },

  async savePurchaseTaxRate(rate: number) {
    const { error } = await createClient().rpc('erp_set_purchase_tax_rate', {
      p_workspace_id: rpcWorkspaceId(),
      p_rate: rate,
    });
    if (error) fail(error);
  },

  async trialBalance(from: string | null, to: string | null): Promise<TrialBalanceRow[]> {
    const { data, error } = await createClient().rpc('erp_trial_balance', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: from,
      p_to: to,
    });
    if (error) fail(error);
    return (data ?? []).map((r: any) => ({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.account_type,
      systemKey: r.system_key,
      debit: Number(r.debit),
      credit: Number(r.credit),
      balance: Number(r.balance),
    }));
  },

  async journal(opts: {
    from?: string | null;
    to?: string | null;
    accountId?: string | null;
    limit: number;
    offset: number;
  }) {
    const { data, error } = await createClient().rpc('erp_journal_list', {
      p_workspace_id: rpcWorkspaceId(),
      p_from: opts.from || null,
      p_to: opts.to || null,
      p_account_id: opts.accountId || null,
      p_limit: opts.limit,
      p_offset: opts.offset,
    });
    if (error) fail(error);
    const rows = (data ?? []) as any[];
    return {
      total: rows.length ? Number(rows[0].total_count) : 0,
      entries: rows.map(
        (r): JournalEntry => ({
          id: r.id,
          entryNo: r.entry_no,
          date: r.entry_date,
          memo: r.memo,
          sourceType: r.source_type,
          sourceId: r.source_id,
          reversesEntryId: r.reverses_entry_id,
          reversed: !!r.reversed,
          lines: (r.lines ?? []).map((l: any) => ({
            accountId: l.account_id,
            code: l.code,
            name: l.name,
            debit: Number(l.debit),
            credit: Number(l.credit),
            memo: l.memo ?? '',
          })),
        })
      ),
    };
  },

  async accounts(): Promise<GlAccount[]> {
    const db = createClient();
    const scope = rpcWorkspaceId();
    let query = db
      .from('erp_gl_accounts')
      .select('id, code, name, account_type, system_key, is_active')
      .order('code');
    if (scope) {
      query = query.eq('workspace_id', scope);
    } else {
      const { data: auth } = await db.auth.getUser();
      query = query.eq('user_id', auth.user?.id ?? '');
    }
    const { data, error } = await query;
    if (error) fail(error);
    return (data ?? []).map((a: any) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.account_type,
      systemKey: a.system_key,
      active: a.is_active,
    }));
  },

  async postJournal(
    date: string,
    memo: string,
    lines: { accountId: string; debit: number; credit: number; memo?: string }[]
  ) {
    const { data, error } = await createClient().rpc('erp_post_journal', {
      p_workspace_id: rpcWorkspaceId(),
      p_date: date,
      p_memo: memo,
      p_lines: lines.map((l) => ({
        account_id: l.accountId,
        debit: l.debit || 0,
        credit: l.credit || 0,
        memo: l.memo ?? '',
      })),
    });
    if (error) fail(error);
    return data as string;
  },

  async reverseJournal(entryId: string, reason: string) {
    const { error } = await createClient().rpc('erp_reverse_journal', {
      p_entry_id: entryId,
      p_reason: reason,
    });
    if (error) fail(error);
  },

  async createAccount(code: string, name: string, type: AccountType) {
    const { error } = await createClient().rpc('erp_create_gl_account', {
      p_workspace_id: rpcWorkspaceId(),
      p_code: code,
      p_name: name,
      p_type: type,
    });
    if (error) fail(error);
  },

  async setAccountActive(accountId: string, active: boolean) {
    const { error } = await createClient().rpc('erp_set_gl_account_active', {
      p_account_id: accountId,
      p_active: active,
    });
    if (error) fail(error);
  },
};

export function statements(period: TrialBalanceRow[], cumulative: TrialBalanceRow[]) {
  const sum = (rows: TrialBalanceRow[], type: AccountType) =>
    rows.filter((r) => r.type === type).reduce((s, r) => s + r.balance, 0);
  const income = sum(period, 'income');
  const expenses = sum(period, 'expense');
  const earningsToDate = sum(cumulative, 'income') - sum(cumulative, 'expense');
  const assets = sum(cumulative, 'asset');
  const liabilities = sum(cumulative, 'liability');
  const equity = sum(cumulative, 'equity');
  return {
    income,
    expenses,
    netIncome: income - expenses,
    assets,
    liabilities,
    equity,
    earningsToDate,
    difference: Math.round((assets - liabilities - equity - earningsToDate) * 100) / 100,
  };
}
