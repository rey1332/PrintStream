import { withAuth } from '@/lib/api-safe';
import { createRouteClient } from '@/server/db/route-client';
import { csvCell } from '@/lib/csv';

const WORKSPACES_ENABLED = process.env.NEXT_PUBLIC_ERP_WORKSPACES !== 'off';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 1000;
const MAX_ROWS = 100_000;

const ALLOWED_TABLES = [
  'erp_customers',
  'erp_suppliers',
  'erp_products',
  'erp_invoices',
  'erp_payments',
  'erp_transactions',
  'erp_purchase_orders',
  'erp_sales_orders',
];

const INTERNAL_COLUMNS = ['user_id', 'workspace_id', 'created_by', 'cancelled_by', 'voided_by'];

const DOCUMENT_CURRENCY_TABLES = [
  'erp_invoices',
  'erp_payments',
  'erp_purchase_orders',
  'erp_sales_orders',
];
const MONEY_TABLES = [...DOCUMENT_CURRENCY_TABLES, 'erp_products', 'erp_transactions'];

export const POST = withAuth(async ({ userId, request }) => {
  const body = await request.json().catch(() => ({}));
  const { table, format = 'csv', workspaceId } = body ?? {};
  if (!ALLOWED_TABLES.includes(table)) return { success: false, error: 'Invalid table' };
  if (format !== 'csv' && format !== 'json') return { success: false, error: 'Unsupported format' };

  const db = createRouteClient(request);

  let scope: { column: 'user_id' | 'workspace_id'; value: string } = {
    column: 'user_id',
    value: userId,
  };
  if (WORKSPACES_ENABLED && typeof workspaceId === 'string' && UUID.test(workspaceId)) {
    const { data: allowed, error } = await db.rpc('erp_has_permission', {
      p_workspace_id: workspaceId,
      p_permission: 'read',
    });
    if (error || allowed !== true)
      return { success: false, error: 'This workspace is not available to you.' };
    scope = { column: 'workspace_id', value: workspaceId };
  }

  // Exports need a two-factor session (decision R-21).
  const { data: aal } = await db.rpc('erp_session_aal');
  if (aal !== 'aal2')
    return {
      success: false,
      error:
        'Exports need two-factor. Turn it on under Settings → Security, then sign in again with your code.',
    };

  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await db
      .from(table)
      .select('*')
      .eq(scope.column, scope.value)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      console.error(`[Export ${table}]`, error.code);
      return { success: false, error: 'Failed to fetch data' };
    }
    rows.push(...((data ?? []) as Record<string, unknown>[]));
    if (!data || data.length < PAGE_SIZE) break;
  }

  let baseCurrency: string | null = null;
  if (MONEY_TABLES.includes(table)) {
    const { data, error } = await db.rpc('erp_currency_settings_get', {
      p_workspace_id: scope.column === 'workspace_id' ? scope.value : null,
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row?.base_currency) {
      console.error(`[Export ${table}] base currency`, error?.code);
      return { success: false, error: 'Failed to fetch data' };
    }
    baseCurrency = String(row.base_currency);
  }

  const sanitized = rows.map((row) => {
    const clean = { ...row };
    for (const column of INTERNAL_COLUMNS) delete clean[column];
    if (baseCurrency) {
      if (DOCUMENT_CURRENCY_TABLES.includes(table)) clean.currency = clean.currency ?? baseCurrency;
      clean.base_currency = baseCurrency;
    }
    return clean;
  });

  // Audit trail: who exported what, never the data itself (data-access log, 20261012000033).
  console.info(
    `[Export] user=${userId} table=${table} rows=${sanitized.length} scope=${scope.column}`
  );
  const { error: logError } = await db.rpc('erp_log_data_access', {
    p_workspace_id: scope.column === 'workspace_id' ? scope.value : null,
    p_object_kind: 'erp_entity',
    p_object_id: table,
    p_operation: 'export',
    p_rows: sanitized.length,
  });
  if (logError && logError.code !== '42883' && logError.code !== 'PGRST202') {
    console.error(`[Export ${table}] access log`, logError.code);
    return { success: false, error: 'Failed to fetch data' };
  }

  const date = new Date().toISOString().split('T')[0];
  if (format === 'json') {
    return {
      success: true,
      data: { content: JSON.stringify(sanitized, null, 2), filename: `${table}-${date}.json` },
    };
  }
  const headers = sanitized.length > 0 ? Object.keys(sanitized[0]) : [];
  const csv = [
    headers.map(csvCell).join(','),
    ...sanitized.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ].join('\r\n');
  return { success: true, data: { content: csv, filename: `${table}-${date}.csv` } };
});
