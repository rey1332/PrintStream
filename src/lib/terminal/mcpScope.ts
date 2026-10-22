// What an MCP connection may use (db/migrations/20261012000060_mcp_scopes.sql):
// its tools and, optionally, only some datasets and pipelines. null (the
// whole scope or one list) means "all". Shared by the server, which enforces
// it, and the Terminal's MCP access page, which edits it.

export interface McpScope {
  tools: string[] | null;
  datasets: string[] | null;
  pipelines: string[] | null;
}

/** The tools, grouped as the access page shows them. Writing tools need a connection that may write. */
export const MCP_TOOL_GROUPS = [
  {
    key: 'pipelines',
    tools: ['list_pipelines', 'get_pipeline', 'list_pipeline_runs', 'get_pipeline_run'],
  },
  { key: 'datasets', tools: ['list_datasets', 'preview_dataset'] },
  { key: 'analysis', tools: ['profile_dataset', 'analyze_dataset', 'get_terminal_health'] },
  {
    key: 'building',
    tools: ['list_node_types', 'list_erp_fields', 'validate_pipeline', 'test_pipeline'],
  },
  { key: 'writing', tools: ['create_pipeline', 'update_pipeline'], write: true },
] as const;

export const MCP_TOOL_NAMES: string[] = MCP_TOOL_GROUPS.flatMap((g) => [...g.tools]);
export const MCP_WRITE_TOOLS: string[] = ['create_pipeline', 'update_pipeline'];

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;

/** A scope as stored (JSONB), or null for "everything". */
export function parseScope(raw: unknown): McpScope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    tools: strings(r.tools),
    datasets: strings(r.datasets),
    pipelines: strings(r.pipelines),
  };
}

/** Whether a scope lets an item through; a missing list allows everything. */
export function scopeAllows(
  scope: McpScope | null | undefined,
  key: keyof McpScope,
  item: string
): boolean {
  const list = scope?.[key];
  return !list || list.includes(item);
}

/** True when the scope limits nothing. */
export const scopeIsAll = (scope: McpScope | null | undefined) =>
  !scope || (!scope.tools && !scope.datasets && !scope.pipelines);
