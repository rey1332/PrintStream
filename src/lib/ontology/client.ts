import type { OntologyTypeKey } from './registry';

export interface OntologyItem {
  id: string;
  type: OntologyTypeKey;
  props: Record<string, string | number | boolean | null>;
}

export interface SearchGroup {
  type: OntologyTypeKey;
  total: number;
  offset: number;
  hasMore: boolean;
  items: OntologyItem[];
}

export interface SearchResponse {
  groups: SearchGroup[];
  excludedTypes: OntologyTypeKey[];
}

export interface RelatedGroup {
  key: string;
  target: OntologyTypeKey;
  cardinality: 'one' | 'many';
  total: number;
  items: OntologyItem[];
}

export interface RecordResponse {
  item: OntologyItem;
  relations: RelatedGroup[];
  hiddenRelations: string[];
}

export class OntologyApiError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success)
    throw new OntologyApiError(String(result?.error ?? `http${response.status}`));
  return result.data as T;
}

export interface SearchInput {
  q: string;
  types: OntologyTypeKey[];
  statuses?: string[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  offset?: number;
}

export function searchErp(workspaceId: string | null, input: SearchInput, signal?: AbortSignal) {
  return post<SearchResponse>('/api/erp/ontology/search', { workspaceId, ...input }, signal);
}

export function readErpRecord(
  workspaceId: string | null,
  type: OntologyTypeKey,
  id: string,
  signal?: AbortSignal
) {
  return post<RecordResponse>('/api/erp/ontology/record', { workspaceId, type, id }, signal);
}
