import { withAuth } from '@/lib/api-safe';
import { cleanGraph } from '@/lib/workflow/graph';
import { isMigrationMissing, isUuid, dbFor, workflowIdFrom } from '@/lib/workflow/server';

export const GET = withAuth(async ({ request }) => {
  const id = workflowIdFrom(request);
  const versionId = request.nextUrl.searchParams.get('versionId');
  if (!isUuid(id) || !isUuid(versionId)) return { success: false, error: 'Version not found.' };
  const { data, error } = await dbFor(request)
    .from('workflow_versions')
    .select('id, version, name, graph, note, created_at')
    .eq('id', versionId)
    .eq('workflow_id', id)
    .maybeSingle();
  if (error)
    return {
      success: false,
      error: isMigrationMissing(error) ? 'migrationRequired' : 'Version not found.',
    };
  if (!data) return { success: false, error: 'Version not found.' };
  return { success: true, data: { ...data, graph: cleanGraph(data.graph) } };
});

export const POST = withAuth(async ({ request }) => {
  const id = workflowIdFrom(request);
  if (!isUuid(id)) return { success: false, error: 'Workflow not found.' };
  const body = await request.json().catch(() => ({}));
  const db = dbFor(request);

  if (body.action === 'publish') {
    if (!isUuid(body.versionId)) return { success: false, error: 'Version not found.' };
    const { error } = await db.rpc('workflow_publish_version', {
      p_workflow_id: id,
      p_version_id: body.versionId,
    });
    if (error)
      return {
        success: false,
        error: isMigrationMissing(error) ? 'migrationRequired' : 'Could not publish this version.',
      };
    return { success: true };
  }

  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : '';
  const { data, error } = await db.rpc('workflow_save_version', {
    p_workflow_id: id,
    p_note: note,
    p_publish: body.publish === true,
  });
  if (error)
    return {
      success: false,
      error: isMigrationMissing(error) ? 'migrationRequired' : 'Could not save a version.',
    };
  const version = Array.isArray(data) ? data[0] : data;
  return { success: true, data: { id: version.id, version: version.version } };
});
