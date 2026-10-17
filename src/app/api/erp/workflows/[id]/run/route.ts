import { withAuth } from '@/lib/api-safe';
import {
  QueryExecutionError,
  WORKSPACES_ENABLED,
  executeQuery,
  resolveScope,
  resolveScopeFor,
} from '@/lib/analytics/server';
import { summaryEntities } from '@/lib/analytics/summary';
import { buildSummarySql, shapeSummary } from '@/server/analytics/summary-sql';
import { selectAsUser } from '@/server/analytics/summary-run';
import { identityOf, sessionFromCookies } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import { datasetReader } from '@/server/terminal/pipelines';
import { erpWorkspaceFor } from '@/server/terminal/erpLinks';
import { WorkflowError } from '@/lib/workflow/errors';
import { executeWorkflow, forDisplay, outputRowCount, summarize } from '@/lib/workflow/executor';
import { cleanGraph } from '@/lib/workflow/graph';
import {
  graphHash,
  isMigrationMissing,
  isUuid,
  dbFor,
  workflowIdFrom,
} from '@/lib/workflow/server';

const RUN_BUDGET_MS = 8000;

export const maxDuration = 26;

type Target = 'draft' | 'published' | 'version';

export const POST = withAuth(async ({ userId, request }) => {
  const started = Date.now();
  const id = workflowIdFrom(request);
  const body = await request.json().catch(() => ({}));
  const target: Target = ['draft', 'published', 'version'].includes(body.target)
    ? body.target
    : 'draft';
  const requestId = isUuid(body.requestId) ? body.requestId : null;
  // The editor's auto-refresh re-runs the workflow every minute while it is open.
  const autoRefresh = body.trigger === 'auto_refresh';
  if (!isUuid(id)) return { success: false, error: 'Workflow not found.' };

  const db = dbFor(request);
  const { data: workflow } = await db
    .from('workflows')
    .select('id, workspace_id, graph, published_version_id')
    .eq('id', id)
    .maybeSingle();
  if (!workflow) return { success: false, error: 'Workflow not found.' };

  let graphSource: unknown = workflow.graph;
  let versionId: string | null = null;
  if (target !== 'draft') {
    versionId =
      target === 'published'
        ? workflow.published_version_id
        : isUuid(body.versionId)
          ? body.versionId
          : null;
    if (!versionId) return { success: false, error: 'notPublished' };
    const { data: version } = await db
      .from('workflow_versions')
      .select('graph')
      .eq('id', versionId)
      .eq('workflow_id', id)
      .maybeSingle();
    if (!version) return { success: false, error: 'Version not found.' };
    graphSource = version.graph;
  }
  const graph = cleanGraph(graphSource);

  const { data: startRows, error: startError } = await db.rpc('workflow_run_start', {
    p_workflow_id: id,
    p_run_kind: target,
    p_version_id: versionId,
    p_request_id: requestId,
    p_graph_hash: graphHash(graph),
    // Only sent for auto-refresh, so manual runs also work before the migration.
    ...(autoRefresh ? { p_triggered_by: 'auto_refresh' } : {}),
  });
  if (startError) {
    if (isMigrationMissing(startError)) return { success: false, error: 'migrationRequired' };
    if (/Too many workflow runs/.test(startError.message ?? ''))
      return { success: false, error: 'tooManyRuns' };
    if (/Auto-refresh too soon/.test(startError.message ?? ''))
      return { success: false, error: 'tooSoon' };
    return { success: false, error: 'Could not start the run.' };
  }
  const start = (Array.isArray(startRows) ? startRows[0] : startRows) as {
    run_id: string;
    created: boolean;
    run_status: string;
    run_version: number | null;
  };
  if (!start.created)
    return { success: true, data: { runId: start.run_id, reused: true, status: start.run_status } };

  const workspaceId = WORKSPACES_ENABLED ? workflow.workspace_id : null;
  const deadline = started + RUN_BUDGET_MS;
  // Terminal datasets are read here too; only background runs write them.
  const session = await sessionFromCookies(request.cookies);
  try {
    const outcome = await executeWorkflow(graph, {
      deadline,
      ctx: {
        query: async (spec, erp) => {
          try {
            const ws = await erpWorkspaceFor(db, workspaceId, erp);
            const scope = await resolveScope(db, userId, ws, spec);
            return await executeQuery(db, spec, scope, deadline);
          } catch (error) {
            if (error instanceof QueryExecutionError) {
              throw new WorkflowError(
                error.code === 'timeout' ? 'wf.err.timeout' : `cat.err.${error.code}`
              );
            }
            throw error;
          }
        },
        summarize: async (spec, erp) => {
          try {
            // Same checks as rows: membership and read permission for every entity involved.
            const ws = await erpWorkspaceFor(db, workspaceId, erp);
            const scope = await resolveScopeFor(db, userId, ws, summaryEntities(spec));
            const raw = await selectAsUser(
              request,
              buildSummarySql(spec, scope),
              '/analytics/summary'
            );
            return { ...shapeSummary(spec, raw), fetchedAt: new Date().toISOString() };
          } catch (error) {
            if (error instanceof QueryExecutionError) {
              throw new WorkflowError(
                error.code === 'timeout' ? 'wf.err.timeout' : `cat.err.${error.code}`
              );
            }
            throw error;
          }
        },
        ...(session
          ? {
              readDataset: datasetReader(
                getAppExecutor(),
                identityOf(session),
                '/terminal/pipeline/preview'
              ),
            }
          : {}),
      },
      isCancelled: async () => {
        if (request.signal?.aborted) return true;
        const { data } = await db.rpc('workflow_run_cancel_requested', { p_run_id: start.run_id });
        return data === true;
      },
    });

    const firstError =
      Object.values(outcome.results).find((r) => r.error && !r.skipped)?.error ??
      outcome.issues.find((i) => i.severity === 'error');
    await db.rpc('workflow_run_finish', {
      p_run_id: start.run_id,
      p_status: outcome.status,
      p_node_results: summarize(outcome.results),
      p_quality: outcome.quality ?? {},
      p_row_count: outputRowCount(graph, outcome.results),
      p_error_code: outcome.errorCode ?? null,
      p_error: firstError?.key ?? null,
    });

    return {
      success: true,
      data: {
        runId: start.run_id,
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        version: start.run_version,
        issues: outcome.issues,
        quality: outcome.quality,
        results: forDisplay(graph, outcome.results),
        durationMs: Date.now() - started,
      },
    };
  } catch (error) {
    await db.rpc('workflow_run_finish', {
      p_run_id: start.run_id,
      p_status: 'failed',
      p_node_results: {},
      p_quality: {},
      p_row_count: null,
      p_error_code: 'unexpected',
      p_error: null,
    });
    throw error;
  }
});
