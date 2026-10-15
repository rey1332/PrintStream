import { NextResponse } from 'next/server';
import { withAuthRaw } from '@/lib/api-safe';
import { createRouteClient } from '@/server/db/route-client';
import { readLimitedText } from '@/server/http/body';
import { csvCell } from '@/lib/csv';

// A period's supplier bills with PPh 23, as CSV, for preparing the bukti
// potong in e-Bupot Unifikasi: POST /api/erp/tax/pph23 { workspaceId, from, to }.
// Read under row-level security (who may see payments); like every export it
// needs a two-factor session, since it carries the suppliers' NPWP / NIK.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const reply = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

const COLUMNS = [
  'bill_date',
  'supplier',
  'id_type',
  'npwp_nik',
  'nitku',
  'bill_no',
  'description',
  'object_code',
  'dpp',
  'rate',
  'pph23',
  'bupot_number',
  'bupot_date',
] as const;

export const POST = withAuthRaw(async ({ request }) => {
  let body: { workspaceId?: unknown; from?: unknown; to?: unknown } = {};
  try {
    body = JSON.parse((await readLimitedText(request, 4_000)) || '{}');
  } catch {
    return reply({ success: false, error: 'invalid' }, 400);
  }
  const ws =
    typeof body.workspaceId === 'string' && UUID.test(body.workspaceId) ? body.workspaceId : null;
  const from = typeof body.from === 'string' && DATE.test(body.from) ? body.from : null;
  const to = typeof body.to === 'string' && DATE.test(body.to) ? body.to : null;
  if (!ws || !from || !to || from > to) return reply({ success: false, error: 'invalid' }, 400);

  const db = createRouteClient(request);
  const { data: aal } = await db.rpc('erp_session_aal');
  if (aal !== 'aal2') return reply({ success: false, error: 'two_factor' }, 403);

  const { data, error } = await db
    .from('erp_supplier_bills')
    .select(
      'bill_date, supplier_name, bill_no, description, pph23_object_code, subtotal, pph23_rate, pph23_amount, ' +
        'bupot_number, bupot_date, supplier:erp_suppliers(tax_id_type, tax_id, nitku)'
    )
    .eq('workspace_id', ws)
    .neq('status', 'void')
    .gt('pph23_amount', 0)
    .gte('bill_date', from)
    .lte('bill_date', to)
    .order('bill_date', { ascending: true })
    .limit(5000);
  if (error) return reply({ success: false, error: 'failed' }, 500);

  const rows = (data ?? []).map((r: any) =>
    [
      r.bill_date,
      r.supplier_name,
      r.supplier?.tax_id_type ?? '',
      r.supplier?.tax_id ?? '',
      r.supplier?.nitku ?? '',
      r.bill_no,
      r.description,
      r.pph23_object_code,
      Number(r.subtotal),
      Number(r.pph23_rate),
      Number(r.pph23_amount),
      r.bupot_number,
      r.bupot_date ?? '',
    ]
      .map(csvCell)
      .join(',')
  );
  const csv = [COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pph23-${from.slice(0, 7).replace('-', '')}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
});
