import { withAuth } from '@/lib/api-safe';
import { cleanGraph } from '@/lib/workflow/graph';
import { isMigrationMissing, isUuid, dbFor, workflowIdFrom } from '@/lib/workflow/server';

export const POST = withAuth(async ({ userId, request }) => {
  const id = workflowIdFrom(request);
  if (!isUuid(id)) return { success: false, error: 'Workflow not found.' };
  const body = await request.json().catch(() => ({}));
  const db = dbFor(request);
  const { data: source, error } = await db.from('workflows').select('*').eq('id', id).maybeSingle();
  if (error || !source) return { success: false, error: 'Workflow not found.' };

  const name =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 120)
      : `${source.name} (copy)`.slice(0, 120);
  const row: Record<string, unknown> = {
    user_id: userId,
    name,
    description: source.description,
    graph: cleanGraph(source.graph),
    workspace_id: source.workspace_id ?? null,
    duplicated_from: source.id,
  };
  let { data, error: insertError } = await db.from('workflows').insert(row).select('id').single();
  if (insertError && isMigrationMissing(insertError)) {
    delete row.workspace_id;
    delete row.duplicated_from;
    ({ data, error: insertError } = await db.from('workflows').insert(row).select('id').single());
  }
  if (insertError || !data) return { success: false, error: 'Could not duplicate this workflow.' };
  return { success: true, data: { id: data.id } };
});
