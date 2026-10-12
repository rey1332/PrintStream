import { withAuth } from '@/lib/api-safe';
import { validateSearch } from '@/lib/ontology/query';
import { ontologyContext } from '@/server/ontology/route-context';
import { OntologyError, searchOntology } from '@/server/ontology/service';

export const POST = withAuth(async ({ request }) => {
  const body = await request.json().catch(() => null);
  const validation = validateSearch(body);
  if (!validation.ok) return { success: false, error: validation.error };
  try {
    const ctx = await ontologyContext(request, '/ontology/search');
    return {
      success: true,
      data: await searchOntology(ctx, body?.workspaceId, validation.request),
    };
  } catch (error) {
    if (error instanceof OntologyError) return { success: false, error: error.code };
    throw error;
  }
});
