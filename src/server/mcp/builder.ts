// Building pipelines through MCP: what the nodes are, a compact graph format
// for assistants (nodes with config, edges from → to) turned into the
// editor's graph (positions laid out, defaults filled in), the editor's own
// checks (lib/workflow/schema.ts) in words, and test runs of a draft that
// read as the member and write nothing.

import { CATALOG, ENTITY_KEYS, isEntityKey } from '@/lib/analytics/catalog';
import { FILTER_OPS, QUERY_LIMITS } from '@/lib/analytics/query';
import { translate } from '@/lib/i18n/translate';
import type { MessageKey } from '@/lib/i18n/messages';
import { executeWorkflow, outputFor, summarize } from '@/lib/workflow/executor';
import { GRAPH_MAX_BYTES } from '@/lib/workflow/graph';
import { CORE_NODE_INFO, type NodeInfo } from '@/lib/workflow/nodeCatalog';
import {
  COMPARISON_OPERATORS,
  DATASET_WRITE_MODES,
  RUNTIME,
  type NodeOutput,
} from '@/lib/workflow/runtime';
import { GRAPH_LIMITS, analyzeGraph, topoOrder, type GraphAnalysis } from '@/lib/workflow/schema';
import type { DataTable, WorkflowGraph } from '@/lib/workflow/types';
import { UNIFY_META } from '@/lib/workflow/unifyNodes';
import type { Executor, SqlTx } from '@/server/db/executor';
import { FIELD_TYPES, loadDataset } from '@/server/terminal/datasets';
import { readingContext } from '@/server/terminal/pipelines';
import type { RequestIdentity } from '@/server/terminal/session';

// ─── The nodes ───────────────────────────────────────────────────────────────

const strip = ({ type, category, label, description, defaultConfig }: NodeInfo): NodeInfo => ({
  type,
  category,
  label,
  description,
  defaultConfig,
});

/** In the editor palette's order. */
export const NODE_INFO: NodeInfo[] = [
  ...CORE_NODE_INFO.filter((m) => m.category === 'source' || m.category === 'transform'),
  ...UNIFY_META.map(strip),
  ...CORE_NODE_INFO.filter((m) => m.category === 'analysis' || m.category === 'output'),
];
const INFO = new Map(NODE_INFO.map((n) => [n.type, n]));

const LIST = 'Comma-separated column names.';
// What an assistant needs beyond the starting configuration.
const NOTES: Record<string, string> = {
  'src.erp': `entity: one of list_erp_fields; fields: its field keys; related: [{relation, fields}]; filters: [{field, op, value}] with op ${FILTER_OPS.join(', ')}; sort: {field, direction} or null; limit up to ${QUERY_LIMITS.maxRows}; erpId: empty for this workspace, or the id of a linked ERP.`,
  'src.erpSummary':
    'Totals computed in the database over every matching record: groupBy [{field, bucket?: day|week|month|quarter|year} or {relation, field}], measures [{op: sum|avg|min|max|count, field?}], filters as src.erp.',
  'src.psDataset':
    'datasetId: from list_datasets (its columns are filled in when saved); limit: rows to read.',
  'tf.filter': `operator: ${COMPARISON_OPERATORS.join(', ')}; value as text.`,
  'tf.sort': 'direction: asc or desc.',
  'tf.select': `columns: ${LIST} rename: "old:new, other:new2".`,
  'tf.aggregate': 'operation: sum, avg, count, min, max.',
  'tf.calc':
    'formula over columns: + - * / %, abs round floor ceil sqrt min max; names with spaces or symbols in [brackets].',
  'tf.join':
    'Two inputs: the first edge into it is the left table, the second the right; joinType: inner, left, right, outer.',
  'tf.validate': `requiredColumns, numericColumns, dateColumns, uniqueKey: ${LIST} action: report or drop.`,
  'tf.branch': 'Two outputs: from_port "match" (rows that match) and "else".',
  'out.psDataset': `datasetId from list_datasets; mode: ${DATASET_WRITE_MODES.join(', ')}. Writes only in background runs of a published version; test runs show what would be written.`,
  'out.erpList':
    'list: customers, suppliers or products; erpMode: add_new or add_or_update; needs a "name" column. Writes only in background runs of a published version.',
};

export function nodeTypes(category?: string) {
  return NODE_INFO.filter((n) => !category || n.category === category).map((n) => {
    const runtime = RUNTIME[n.type];
    return {
      type: n.type,
      category: n.category,
      name: n.label,
      description: n.description,
      inputs: runtime?.inputs ?? 0,
      ...(runtime && runtime.outputs.length > 1 ? { output_ports: runtime.outputs } : {}),
      ...(runtime && runtime.outputs.length === 0 ? { final: true } : {}),
      default_config: n.defaultConfig,
      ...(NOTES[n.type] ? { notes: NOTES[n.type] } : {}),
    };
  });
}

export function erpFields(entity?: string) {
  const keys = entity ? (isEntityKey(entity) ? [entity] : []) : [...ENTITY_KEYS];
  return keys.map((k) => {
    const e = CATALOG[k];
    return {
      entity: k,
      module: e.module,
      ...(entity
        ? {
            fields: e.fields.map((f) => ({
              key: f.key,
              type: f.type,
              ...(f.enumValues ? { values: f.enumValues } : {}),
            })),
            relations: e.relations.map((r) => ({ relation: r.key, entity: r.target })),
            date_field: e.dateField ?? null,
          }
        : { fields: e.fields.length, date_field: e.dateField ?? null }),
    };
  });
}

// ─── Assistant graphs ↔ editor graphs ────────────────────────────────────────

export interface AssistantNode {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
}
export interface AssistantEdge {
  from: string;
  to: string;
  from_port?: string;
}

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Graph problems that make it unusable (it is not saved). */
export class GraphShapeError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join(' '));
    this.problems = problems;
  }
}

export const graphInputSchema = {
  nodes: {
    type: 'array',
    maxItems: GRAPH_LIMITS.maxNodes,
    description:
      "The steps: {id (letters, digits, - or _; unique), type (from list_node_types), label?, config? (merged over the type's default_config)}.",
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { type: 'string' },
        label: { type: 'string' },
        config: { type: 'object' },
      },
      required: ['id', 'type'],
    },
  },
  edges: {
    type: 'array',
    maxItems: GRAPH_LIMITS.maxEdges,
    description:
      'How rows flow: {from, to, from_port? ("match"/"else" for a Branch)}. A Join takes its left table from the first edge into it.',
    items: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        from_port: { type: 'string' },
      },
      required: ['from', 'to'],
    },
  },
} as const;

/**
 * The editor's graph for an assistant's nodes and edges. Nodes already in
 * `previous` (same id) keep their place on the canvas; new ones are laid out
 * left to right by depth.
 */
export function toEditorGraph(
  nodesIn: unknown,
  edgesIn: unknown,
  previous?: WorkflowGraph | null
): WorkflowGraph {
  const problems: string[] = [];
  const nodes = Array.isArray(nodesIn) ? (nodesIn as AssistantNode[]) : [];
  const edges = Array.isArray(edgesIn) ? (edgesIn as AssistantEdge[]) : [];
  if (!Array.isArray(nodesIn)) problems.push('nodes must be a list.');
  if (edgesIn !== undefined && !Array.isArray(edgesIn)) problems.push('edges must be a list.');
  if (nodes.length > GRAPH_LIMITS.maxNodes)
    problems.push(`At most ${GRAPH_LIMITS.maxNodes} nodes.`);
  if (edges.length > GRAPH_LIMITS.maxEdges)
    problems.push(`At most ${GRAPH_LIMITS.maxEdges} edges.`);
  const seen = new Set<string>();
  for (const n of nodes) {
    const id = String(n?.id ?? '');
    if (!NODE_ID.test(id)) problems.push(`Node id "${id}" is not valid (letters, digits, - or _).`);
    else if (seen.has(id)) problems.push(`Node id "${id}" is used twice.`);
    seen.add(id);
    if (!RUNTIME[String(n?.type)])
      problems.push(`Node "${id}": unknown type "${String(n?.type)}" (see list_node_types).`);
    if (n?.config !== undefined && (typeof n.config !== 'object' || Array.isArray(n.config)))
      problems.push(`Node "${id}": config must be an object.`);
  }
  for (const e of edges) {
    const from = String(e?.from ?? '');
    const to = String(e?.to ?? '');
    if (!seen.has(from) || !seen.has(to)) {
      problems.push(`Edge ${from} → ${to}: both ends must be node ids.`);
      continue;
    }
    const ports = RUNTIME[String(nodes.find((n) => n.id === from)?.type)]?.outputs ?? [];
    if (ports.length > 1 && !ports.includes(String(e.from_port)))
      problems.push(`Edge ${from} → ${to}: from_port must be one of ${ports.join(', ')}.`);
  }
  if (problems.length) throw new GraphShapeError(problems);

  const graph: WorkflowGraph = {
    nodes: nodes.map((n) => {
      const info = INFO.get(n.type);
      return {
        id: n.id,
        type: 'workflowNode',
        position: { x: 0, y: 0 },
        data: {
          type: n.type,
          label:
            String(n.label ?? '')
              .trim()
              .slice(0, 120) ||
            info?.label ||
            n.type,
          config: { ...(info?.defaultConfig ?? {}), ...(n.config ?? {}) },
        },
      };
    }),
    edges: edges.map((e, i) => {
      const ports = RUNTIME[String(nodes.find((n) => n.id === e.from)?.type)]?.outputs ?? [];
      return {
        id: `e${i + 1}-${e.from}-${e.to}`,
        source: e.from,
        target: e.to,
        ...(ports.length > 1 ? { sourceHandle: String(e.from_port) } : {}),
      };
    }),
  };
  if (JSON.stringify(graph).length > GRAPH_MAX_BYTES)
    throw new GraphShapeError(['The pipeline is too large.']);
  layout(graph, previous ?? null);
  return graph;
}

function layout(graph: WorkflowGraph, previous: WorkflowGraph | null) {
  const kept = new Map((previous?.nodes ?? []).map((n) => [n.id, n.position]));
  const depth = new Map<string, number>();
  for (const id of topoOrder(graph) ?? graph.nodes.map((n) => n.id)) {
    const ins = graph.edges.filter((e) => e.target === id).map((e) => depth.get(e.source) ?? 0);
    depth.set(id, ins.length ? Math.max(...ins) + 1 : 0);
  }
  const rows = new Map<number, number>();
  for (const n of graph.nodes) {
    const k = kept.get(n.id);
    if (k) {
      n.position = { x: Number(k.x) || 0, y: Number(k.y) || 0 };
      continue;
    }
    const d = depth.get(n.id) ?? 0;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    n.position = { x: 80 + d * 300, y: 80 + row * 170 };
  }
}

/** The editor's graph as assistants write it (see toEditorGraph). */
export function fromEditorGraph(graph: any) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  return {
    nodes: nodes.map((n: any) => {
      const config = { ...(n.data?.config ?? {}) };
      // Filled in from the dataset when saved; not something to write.
      if (n.data?.type === 'src.psDataset') delete config.columns;
      return {
        id: String(n.id),
        type: String(n.data?.type ?? n.type ?? ''),
        label: String(n.data?.label ?? ''),
        config,
        ...(n.data?.disabled ? { disabled: true } : {}),
      };
    }),
    edges: edges.map((e: any) => ({
      from: String(e.source),
      to: String(e.target),
      ...(e.sourceHandle ? { from_port: String(e.sourceHandle) } : {}),
    })),
  };
}

/**
 * Dataset nodes against the Terminal's datasets: a source gets the dataset's
 * columns (as the editor stores them when one is picked); problems are
 * returned as checks.
 */
export async function attachDatasets(tx: SqlTx, workspaceId: string, graph: WorkflowGraph) {
  const issues: Check[] = [];
  for (const n of graph.nodes) {
    const type = String(n.data.type);
    if (type !== 'src.psDataset' && type !== 'out.psDataset') continue;
    const id = String(n.data.config?.datasetId ?? '');
    if (!id) continue;
    let ok = false;
    try {
      const ds = await loadDataset(tx, id);
      ok = ds.workspaceId === workspaceId && (ds.status === 'ready' || ds.status === 'altering');
      if (ok && type === 'src.psDataset')
        n.data.config = {
          ...n.data.config,
          columns: ds.columns
            .filter((c) => !c.hidden && c.provisioned)
            .map((c) => ({ name: c.label, type: FIELD_TYPES[c.type] ?? 'text' })),
        };
    } catch {
      ok = false;
    }
    if (!ok)
      issues.push({
        severity: 'error',
        node_id: n.id,
        message: `Dataset ${id} is not a ready dataset of this Terminal (see list_datasets).`,
      });
  }
  return issues;
}

// ─── Checks in words ─────────────────────────────────────────────────────────

export interface Check {
  severity: 'error' | 'warning';
  node_id?: string;
  message: string;
}

const say = (key: string | undefined, vars?: Record<string, string | number>) =>
  key ? translate('en', key as MessageKey, vars) : '';

export function checksOf(analysis: GraphAnalysis): Check[] {
  return analysis.issues.map((i) => ({
    severity: i.severity,
    ...(i.nodeId ? { node_id: i.nodeId } : {}),
    message: say(i.key, i.vars),
  }));
}

/** The columns each node puts out, as far as they are known before running. */
export function columnsOf(analysis: GraphAnalysis) {
  return Object.fromEntries(
    Object.entries(analysis.nodes).map(([id, info]) => [
      id,
      Object.fromEntries(
        Object.entries(info.outputs).map(([port, schema]) => [
          port,
          schema
            ? schema.map((c) => (c.type ? `${c.name} (${c.type})` : c.name))
            : 'unknown until run',
        ])
      ),
    ])
  );
}

export function check(graph: WorkflowGraph, extra: Check[] = []) {
  const analysis = analyzeGraph(graph);
  const checks = [...extra, ...checksOf(analysis)];
  return {
    ok: !checks.some((c) => c.severity === 'error'),
    checks,
    columns: columnsOf(analysis),
  };
}

// ─── Test runs ───────────────────────────────────────────────────────────────

const TEST_BUDGET_MS = 60_000;

const warningsOf = (output: NodeOutput | undefined): string[] => {
  const tables = !output
    ? []
    : Array.isArray((output as DataTable).rows)
      ? [output as DataTable]
      : Object.values(output as Record<string, DataTable>);
  return [
    ...new Set(tables.flatMap((t) => (t.meta?.warnings ?? []).map((w) => say(w.key, w.vars)))),
  ];
};
const SAMPLE_ROWS = 10;

/**
 * Runs a draft as the member: reads ERP records and datasets (masked as in
 * the app), writes nothing (the write nodes report what they would write).
 * The rows shown are a few of each final step's.
 */
export async function testRun(
  executor: Executor,
  identity: RequestIdentity,
  workspaceId: string,
  graph: WorkflowGraph
) {
  const deadline = Date.now() + TEST_BUDGET_MS;
  const outcome = await executeWorkflow(graph, {
    deadline,
    ctx: readingContext(executor, identity, workspaceId, '/api/mcp/test', deadline),
  });
  const steps = summarize(outcome.results);
  const finals = graph.nodes.filter(
    (n) => !graph.edges.some((e) => e.source === n.id) && outcome.results[n.id]?.output
  );
  return {
    status: outcome.status,
    error_code: outcome.errorCode ?? null,
    checks: checksOf({ nodes: {}, issues: outcome.issues, order: null }),
    steps: graph.nodes
      .filter((n) => steps[n.id])
      .map((n) => {
        const s = steps[n.id];
        return {
          node_id: n.id,
          label: n.data.label,
          ok: s.ok,
          ...(s.skipped ? { skipped: true } : {}),
          ms: s.ms,
          rows: s.rows ?? null,
          columns: s.cols ?? null,
          ...(warningsOf(outcome.results[n.id]?.output).length
            ? { warnings: warningsOf(outcome.results[n.id]?.output) }
            : {}),
          ...(s.error ? { error: say(s.error.key, s.error.vars) } : {}),
        };
      }),
    samples: finals.map((n) => {
      const ports = RUNTIME[String(n.data.type)]?.outputs ?? [];
      const table = outputFor(outcome.results[n.id], ports.length > 1 ? ports[0] : 'out');
      return {
        node_id: n.id,
        columns: table?.columns ?? [],
        rows: (table?.rows ?? []).slice(0, SAMPLE_ROWS),
        total_rows: table?.meta?.count ?? table?.rows.length ?? 0,
      };
    }),
  };
}
