import { withAuth } from '@/lib/api-safe';
import { ontologyContext } from '@/server/ontology/route-context';
import { OntologyError, readOntologyRecord } from '@/server/ontology/service';

export const POST = withAuth(async ({ request }) => {
  const body = await request.json().catch(() => null);
  try {
    const ctx = await ontologyContext(request, '/ontology/record');
    return {
      success: true,
      data: await readOntologyRecord(ctx, body?.workspaceId, body?.type, body?.id),
    };
  } catch (error) {
    if (error instanceof OntologyError) return { success: false, error: error.code };
    throw error;
  }
});
