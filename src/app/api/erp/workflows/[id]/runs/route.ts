import { withAuth } from '@/lib/api-safe';
import { isMigrationMissing, isUuid, dbFor } from '@/lib/workflow/server';

const workflowIdOf = (pathname: string) => pathname.split('/').filter(Boolean).at(-2) ?? '';

const HISTORY_COLUMNS =
  'id, user_id, status, run_kind, version, started_at, finished_at, duration_ms, row_count, quality, error_code, error, cancel_requested_at, triggered_by, node_results';

export const GET = withAuth(async ({ userId, request }) => {
  const workflowId = workflowIdOf(request.nextUrl.pathname);
  if (!isUuid(workflowId)) return { success: true, data: [] };
  const db = dbFor(request);
  // ?auto=0 leaves out auto-refresh runs (one a minute while the editor is open).
  const hideAuto = request.nextUrl.searchParams.get('auto') === '0';
  let query = db.from('workflow_runs').select(HISTORY_COLUMNS).eq('workflow_id', workflowId);
  if (hideAuto) query = query.neq('triggered_by', 'auto_refresh');
  let { data, error } = await query.order('started_at', { ascending: false }).limit(30);
  if (error && isMigrationMissing(error)) {
    ({ data, error } = (await db
      .from('workflow_runs')
      .select('id, user_id, status, started_at, finished_at, duration_ms, error')
      .eq('workflow_id', workflowId)
      .order('started_at', { ascending: false })
      .limit(30)) as any);
  }
  if (error) return { success: false, error: 'Could not load run history.' };
  return {
    success: true,
    data: ((data ?? []) as any[]).map((r) => ({
      ...r,
      byMe: r.user_id === userId,
      user_id: undefined,
    })),
  };
});

function metadataOnly(nodeResults: unknown) {
  if (!nodeResults || typeof nodeResults !== 'object') return {};
  return Object.fromEntries(
    Object.entries(nodeResults as Record<string, any>)
      .slice(0, 200)
      .map(([id, r]) => [
        id,
        {
          ok: Boolean(r?.ok),
          ms: Number.isFinite(Number(r?.durationMs)) ? Math.round(Number(r.durationMs)) : 0,
          rows: Array.isArray(r?.output?.rows) ? r.output.rows.length : undefined,
          error: typeof r?.error === 'string' ? r.error.slice(0, 300) : undefined,
        },
      ])
  );
}

export const POST = withAuth(async ({ userId, request }) => {
  const workflowId = workflowIdOf(request.nextUrl.pathname);
  const body = await request.json().catch(() => ({}));
  const db = dbFor(request);

  if (body.action === 'cancel') {
    // A run still in progress is only known to the browser by the request id that started it.
    let runId = isUuid(body.runId) ? body.runId : null;
    if (!runId && isUuid(body.requestId) && isUuid(workflowId)) {
      const { data: run } = await db
        .from('workflow_runs')
        .select('id')
        .eq('workflow_id', workflowId)
        .eq('user_id', userId)
        .eq('request_id', body.requestId)
        .maybeSingle();
      runId = run?.id ?? null;
    }
    if (!runId) return { success: false, error: 'Run not found.' };
    const { data, error } = await db.rpc('workflow_run_cancel', { p_run_id: runId });
    if (error)
      return {
        success: false,
        error: isMigrationMissing(error) ? 'migrationRequired' : 'Run not found.',
      };
    return { success: true, data: { status: data } };
  }

  // ── Previous app version: a run executed in the browser ──
  const durationMs = Number(body.duration_ms);
  if (
    !isUuid(workflowId) ||
    !['success', 'failed'].includes(body.status) ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return { success: false, error: 'Invalid workflow run data.' };
  }
  const { error } = await db.from('workflow_runs').insert({
    workflow_id: workflowId,
    user_id: userId,
    status: body.status,
    node_results: metadataOnly(body.node_results),
    duration_ms: Math.round(durationMs),
    finished_at: new Date().toISOString(),
    error: typeof body.error === 'string' ? body.error.slice(0, 2000) : null,
  });
  if (error) {
    console.error('[POST /api/erp/workflows/:id/runs]', {
      code: error.code,
      message: error.message,
    });
    return { success: false, error: 'Could not save workflow run history.' };
  }
  return { success: true };
});
