import { withAuth } from '@/lib/api-safe';
import { QueryExecutionError, WORKSPACES_ENABLED, resolveScopeFor } from '@/lib/analytics/server';
import { SUMMARY_LIMITS, summaryEntities, validateSummary } from '@/lib/analytics/summary';
import { summarySpecOf } from '@/lib/workflow/runtime';
import { erpWorkspaceFor } from '@/server/terminal/erpLinks';
import { WorkflowError } from '@/lib/workflow/errors';
import { cleanGraph } from '@/lib/workflow/graph';
import { isUuid, dbFor, workflowIdFrom } from '@/lib/workflow/server';
import {
  buildDrillSql,
  drillFields,
  shapeDrillRows,
  validGroupValues,
} from '@/server/analytics/summary-sql';
import { selectAsUser } from '@/server/analytics/summary-run';

export const POST = withAuth(async ({ userId, request }) => {
  const id = workflowIdFrom(request);
  const body = await request.json().catch(() => ({}));
  const target = ['draft', 'published', 'version'].includes(body.target) ? body.target : 'draft';
  if (!isUuid(id) || typeof body.nodeId !== 'string' || body.nodeId.length > 200)
    return { success: false, error: 'drillUnavailable' };

  const db = dbFor(request);
  // Row-level security: only a workflow the user may see is found.
  const { data: workflow } = await db
    .from('workflows')
    .select('id, workspace_id, graph, published_version_id')
    .eq('id', id)
    .maybeSingle();
  if (!workflow) return { success: false, error: 'drillUnavailable' };

  let graphSource: unknown = workflow.graph;
  if (target !== 'draft') {
    const versionId =
      target === 'published'
        ? workflow.published_version_id
        : isUuid(body.versionId)
          ? body.versionId
          : null;
    if (!versionId) return { success: false, error: 'drillUnavailable' };
    const { data: version } = await db
      .from('workflow_versions')
      .select('graph')
      .eq('id', versionId)
      .eq('workflow_id', id)
      .maybeSingle();
    if (!version) return { success: false, error: 'drillUnavailable' };
    graphSource = version.graph;
  }

  const node = cleanGraph(graphSource).nodes.find(
    (n) => n.id === body.nodeId && n.data.type === 'src.erpSummary'
  );
  if (!node) return { success: false, error: 'drillUnavailable' };
  const validation = validateSummary(summarySpecOf(node.data.config));
  if (!validation.ok) return { success: false, error: 'drillUnavailable' };
  const spec = validation.spec;
  if (!validGroupValues(spec, body.group)) return { success: false, error: 'invalidGroup' };
  const offset =
    Number.isInteger(body.offset) && body.offset >= 0
      ? Math.min(body.offset, SUMMARY_LIMITS.maxDrillOffset)
      : 0;

  try {
    // The node's linked ERP, when it names one (a Terminal on its own).
    const erp = (node.data.config as { erpId?: unknown })?.erpId;
    const scope = await resolveScopeFor(
      db,
      userId,
      await erpWorkspaceFor(
        db,
        WORKSPACES_ENABLED ? workflow.workspace_id : null,
        typeof erp === 'string' ? erp : null
      ),
      summaryEntities(spec)
    );
    const raw = await selectAsUser(
      request,
      buildDrillSql(spec, scope, body.group, offset),
      '/analytics/drill'
    );
    const rows = shapeDrillRows(spec.entity, raw);
    const page = SUMMARY_LIMITS.drillPage;
    return {
      success: true,
      data: {
        entity: spec.entity,
        columns: drillFields(spec.entity).map((f) => ({ name: f.key, type: f.type })),
        rows: rows.slice(0, page),
        offset,
        hasMore: rows.length > page,
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    if (error instanceof QueryExecutionError) return { success: false, error: error.code };
    if (error instanceof WorkflowError) return { success: false, error: 'erpNotLinked' };
    throw error;
  }
});
