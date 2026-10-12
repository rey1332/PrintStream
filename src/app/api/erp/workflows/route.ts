import { withAuth } from '@/lib/api-safe';
import { cleanGraph } from '@/lib/workflow/graph';
import { isMigrationMissing, isUuid, dbFor } from '@/lib/workflow/server';

const WORKSPACES_ENABLED = process.env.NEXT_PUBLIC_ERP_WORKSPACES !== 'off';
const LIST_COLUMNS =
  'id, user_id, name, description, graph, created_at, updated_at, workspace_id, published_version_id, duplicated_from';

export const POST = withAuth(async ({ userId, request }) => {
  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  const db = dbFor(request);
  const row: Record<string, unknown> = {
    user_id: userId,
    name: name || 'Untitled Workflow',
    graph: cleanGraph(null),
  };
  // The database checks that the user belongs to the workspace.
  if (WORKSPACES_ENABLED && isUuid(body.workspaceId)) row.workspace_id = body.workspaceId;
  let { data, error } = await db.from('workflows').insert(row).select('*').single();
  if (error && isMigrationMissing(error) && 'workspace_id' in row) {
    delete row.workspace_id;
    ({ data, error } = await db.from('workflows').insert(row).select('*').single());
  }

  if (error) {
    console.error('[POST /api/erp/workflows]', { code: error.code, message: error.message });
    if (error.code === '42501') {
      return {
        success: false,
        error: 'You are not allowed to create workflows here (database access rule).',
      };
    }
    return { success: false, error: 'Could not create workflow in the database.' };
  }

  return { success: true, data };
});

export const GET = withAuth(async ({ userId, request }) => {
  const db = dbFor(request);
  if (new URL(request.url).searchParams.get('resource') === 'approvals') {
    const owner = new URL(request.url).searchParams.get('owner');
    let query = db.from('erp_approval_requests').select('*');
    if (isUuid(owner)) query = query.eq('owner_id', owner);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) return { success: false, error: 'Could not load approval requests.' };
    return { success: true, data: data || [] };
  }
  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  const list = (columns: string, byWorkspace: boolean) => {
    const query = db.from('workflows').select(columns);
    return (
      byWorkspace ? query.eq('workspace_id', workspaceId!) : query.eq('user_id', userId)
    ).order('updated_at', { ascending: false });
  };
  const byWorkspace = WORKSPACES_ENABLED && isUuid(workspaceId);
  let { data, error } = await list(
    `${LIST_COLUMNS}, published:workflow_versions!workflows_published_version_fk(version)`,
    byWorkspace
  );
  // Without the published-version link (or if it cannot be embedded) the list still loads.
  if (error) ({ data, error } = await list(LIST_COLUMNS, byWorkspace));
  if (error && isMigrationMissing(error)) ({ data, error } = await list('*', false));
  if (error) {
    console.error('[GET /api/erp/workflows]', { code: error.code, message: error.message });
    return { success: false, error: 'Could not load workflows.' };
  }
  const rows = ((data ?? []) as any[]).map((w) => ({
    ...w,
    canEdit: w.user_id === userId,
    publishedVersion: w.published?.version ?? null,
    published: undefined,
  }));
  return { success: true, data: rows };
});

export const PATCH = withAuth(async ({ userId, request }) => {
  const body = await request.json().catch(() => ({}));
  const db = dbFor(request);

  if (body.action === 'decide') {
    const { error } = await db.rpc('erp_decide_po_approval', {
      p_request_id: body.requestId,
      p_decision: body.decision,
      p_note: typeof body.note === 'string' ? body.note : '',
    });
    if (error) {
      if (error.code === 'P0001' && error.message) return { success: false, error: error.message };
      console.error('[PATCH /api/erp/workflows] decide', error.code || 'unknown');
      return { success: false, error: 'Could not save the approval decision.' };
    }

    const { data: approval } = await db
      .from('erp_approval_requests')
      .select('admin_email')
      .eq('id', body.requestId)
      .maybeSingle();
    const sent = await sendApprovalEmail(
      approval?.admin_email ? [approval.admin_email] : [],
      'ETNA approval updated',
      'An approval notification is available in ETNA. Sign in to your account and open ERP Settings to review it.'
    );
    return { success: true, data: { emailSent: sent } };
  }

  if (body.action === 'notify') {
    const purchaseOrderId = typeof body.purchaseOrderId === 'string' ? body.purchaseOrderId : '';
    if (!purchaseOrderId) return { success: false, error: 'Purchase order is required.' };
    const { data: approval, error } = await db
      .from('erp_approval_requests')
      .select('id, approver_emails')
      .eq('owner_id', userId)
      .eq('purchase_order_id', purchaseOrderId)
      .maybeSingle();
    if (error) return { success: false, error: 'Could not load the approval request.' };
    if (!approval) return { success: true, data: { required: false, sent: false } };
    const sent = await sendApprovalEmail(
      approval.approver_emails || [],
      'ETNA approval needed',
      'An approval is waiting for your review. Sign in to ETNA and open ERP Settings to review it.'
    );
    return {
      success: true,
      data: {
        required: true,
        sent,
        emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
      },
    };
  }

  return { success: false, error: 'Unknown approval action.' };
});

async function sendApprovalEmail(to: string[], subject: string, text: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from || to.length === 0) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!response.ok) console.error('[approval email] provider rejected request', response.status);
  return response.ok;
}
