import { NextResponse } from 'next/server';
import { withAuthRaw } from '@/lib/api-safe';
import { createRouteClient } from '@/server/db/route-client';
import { buildCoretaxXml, type FakturExport } from '@/server/tax/coretax';
import { readLimitedText } from '@/server/http/body';

// The chosen sales invoices as a Coretax e-Faktur import file:
// POST /api/erp/tax/coretax { workspaceId, invoiceIds } → XML attachment, or
// 422 { problems } when the file cannot be made (nothing is marked then).
// Needs 'invoicing' (checked by the database) and, like every export, a
// two-factor session: the file carries the customers' tax IDs.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export const POST = withAuthRaw(async ({ request }) => {
  let body: { workspaceId?: unknown; invoiceIds?: unknown } = {};
  try {
    body = JSON.parse((await readLimitedText(request, 64_000)) || '{}');
  } catch {
    return reply({ success: false, error: 'invalid' }, 400);
  }
  const workspaceId =
    typeof body.workspaceId === 'string' && UUID.test(body.workspaceId) ? body.workspaceId : null;
  const ids = Array.isArray(body.invoiceIds)
    ? body.invoiceIds.filter((id) => typeof id === 'string' && UUID.test(id))
    : [];
  if (!ids.length || ids.length !== (body.invoiceIds as unknown[]).length || ids.length > 500)
    return reply({ success: false, error: 'invalid' }, 400);

  const db = createRouteClient(request);
  const { data: aal } = await db.rpc('erp_session_aal');
  if (aal !== 'aal2') return reply({ success: false, error: 'two_factor' }, 403);

  const read = (mark: boolean) =>
    db.rpc('erp_tax_faktur_export', {
      p_workspace_id: workspaceId,
      p_invoice_ids: ids,
      p_mark: mark,
    });
  const check = await read(false);
  if (check.error) {
    const forbidden = check.error.code === '42501';
    return reply(
      { success: false, error: forbidden ? 'forbidden' : 'invoices' },
      forbidden ? 403 : 400
    );
  }
  const { xml, problems } = buildCoretaxXml(check.data as FakturExport);
  if (!xml) return reply({ success: false, error: 'problems', problems }, 422);

  // The file is good: now the invoices are marked exported (and the export is in the audit log).
  const marked = await read(true);
  if (marked.error) return reply({ success: false, error: 'failed' }, 500);
  const dates = (check.data as FakturExport).invoices.map((i) => i.date).sort();
  const period = dates[0]?.slice(0, 7).replace('-', '') ?? 'faktur';
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="coretax-faktur-${period}.xml"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
