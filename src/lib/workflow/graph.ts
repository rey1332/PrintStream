import type { WorkflowGraph } from './types';

export const GRAPH_MAX_BYTES = 1_000_000;

export function cleanGraph(graph: unknown): WorkflowGraph {
  const g = (graph ?? {}) as { nodes?: any[]; edges?: any[] };
  const nodes = (Array.isArray(g.nodes) ? g.nodes : []).map((n) => ({
    id: String(n?.id ?? ''),
    type: 'workflowNode',
    position: { x: Number(n?.position?.x) || 0, y: Number(n?.position?.y) || 0 },
    data: {
      type: String(n?.data?.type ?? ''),
      label: String(n?.data?.label ?? ''),
      config: n?.data?.config && typeof n.data.config === 'object' ? n.data.config : {},
    },
  }));
  const edges = (Array.isArray(g.edges) ? g.edges : []).map((e) => {
    const edge: Record<string, unknown> = {
      id: String(e?.id ?? ''),
      source: String(e?.source ?? ''),
      target: String(e?.target ?? ''),
    };
    if (e?.sourceHandle) edge.sourceHandle = String(e.sourceHandle);
    if (e?.targetHandle) edge.targetHandle = String(e.targetHandle);
    return edge;
  });
  return { nodes, edges } as unknown as WorkflowGraph;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sameGraph(a: unknown, b: unknown): boolean {
  return stableStringify(cleanGraph(a)) === stableStringify(cleanGraph(b));
}
