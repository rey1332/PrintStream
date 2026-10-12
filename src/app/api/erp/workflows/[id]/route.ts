import { withAuth } from '@/lib/api-safe';
import { GRAPH_MAX_BYTES, cleanGraph, sameGraph } from '@/lib/workflow/graph';
import { GRAPH_LIMITS } from '@/lib/workflow/schema';
import { isMigrationMissing, isUuid, dbFor, workflowIdFrom } from '@/lib/workflow/server';

export const GET = withAuth(async ({ userId, request }) => {
  const id = workflowIdFrom(request);
  if (!isUuid(id)) return { success: true, data: null };
  const db = dbFor(request);
  const { data: workflow, error } = await db
    .from('workflows')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return { success: false, error: 'Could not load this workflow.' };
  if (!workflow) return { success: true, data: null };

  const { data: versions, error: versionsError } = await db
    .from('workflow_versions')
    .select('id, version, note, created_at, created_by')
    .eq('workflow_id', id)
    .order('version', { ascending: false })
    .limit(50);
  if (versionsError && !isMigrationMissing(versionsError))
    return { success: false, error: 'Could not load this workflow.' };

  let published: { id: string; version: number; draftMatches: boolean } | null = null;
  if (workflow.published_version_id) {
    const { data: v } = await db
      .from('workflow_versions')
      .select('id, version, graph')
      .eq('id', workflow.published_version_id)
      .maybeSingle();
    if (v)
      published = {
        id: v.id,
        version: v.version,
        draftMatches: sameGraph(workflow.graph, v.graph),
      };
  }

  return {
    success: true,
    data: {
      ...workflow,
      graph: cleanGraph(workflow.graph),
      canEdit: workflow.user_id === userId,
      versions: (versions ?? []).map((v) => ({
        ...v,
        byMe: v.created_by === userId,
        created_by: undefined,
      })),
      published,
      versionsAvailable: !versionsError,
    },
  };
});

export const PATCH = withAuth(async ({ userId, request }) => {
  const id = workflowIdFrom(request);
  if (!isUuid(id)) return { success: false, error: 'Could not save this workflow.' };
  const body = await request.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.graph && Array.isArray(body.graph.nodes) && Array.isArray(body.graph.edges)) {
    const graph = cleanGraph(body.graph);
    if (
      graph.nodes.length > GRAPH_LIMITS.maxNodes ||
      graph.edges.length > GRAPH_LIMITS.maxEdges ||
      JSON.stringify(graph).length > GRAPH_MAX_BYTES
    ) {
      return { success: false, error: 'tooLarge' };
    }
    patch.graph = graph;
  }
  if (typeof body.name === 'string')
    patch.name = body.name.trim().slice(0, 120) || 'Untitled Workflow';

  const db = dbFor(request);
  let query = db.from('workflows').update(patch).eq('id', id).eq('user_id', userId);
  // Saving over a newer save from another tab or device is refused.
  if (typeof body.expectedUpdatedAt === 'string')
    query = query.eq('updated_at', body.expectedUpdatedAt);
  const { data, error } = await query.select('id, updated_at').maybeSingle();
  if (error) return { success: false, error: 'Could not save this workflow.' };
  if (!data) {
    const { data: exists } = await db
      .from('workflows')
      .select('id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    return { success: false, error: exists ? 'conflict' : 'Could not save this workflow.' };
  }
  return { success: true, data: { updated_at: data.updated_at } };
});

export const DELETE = withAuth(async ({ userId, request }) => {
  const db = dbFor(request);
  const { error } = await db
    .from('workflows')
    .delete()
    .eq('id', workflowIdFrom(request))
    .eq('user_id', userId);
  if (error) return { success: false, error: 'Could not delete this workflow.' };
  return { success: true };
});
