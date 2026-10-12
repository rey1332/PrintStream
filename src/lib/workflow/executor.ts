import { RUNTIME, type NodeOutput, type QualityReport, type RuntimeContext } from './runtime';
import { analyzeGraph, incoming, type GraphIssue } from './schema';
import { WorkflowError, errorInfo, type ErrorInfo } from './errors';
import type { DataTable, WorkflowGraph } from './types';

export interface NodeRunResult {
  ok: boolean;
  output?: NodeOutput;
  error?: ErrorInfo;
  durationMs: number;
  skipped?: boolean;
}

export type NodeResultMap = Record<string, NodeRunResult>;

export type RunStatus = 'success' | 'failed' | 'cancelled';
export type RunErrorCode = 'invalidGraph' | 'nodeFailed' | 'timeout' | 'cancelled';

export interface RunOutcome {
  status: RunStatus;
  errorCode?: RunErrorCode;
  issues: GraphIssue[];
  results: NodeResultMap;
  quality: QualityReport | null;
}

export interface RunOptions {
  ctx: RuntimeContext;
  deadline: number;
  isCancelled?: () => Promise<boolean>;
  now?: () => number;
}

const tables = (output: NodeOutput | undefined): DataTable[] =>
  !output
    ? []
    : 'rows' in output && Array.isArray((output as DataTable).rows)
      ? [output as DataTable]
      : Object.values(output as Record<string, DataTable>);

export function outputFor(
  result: NodeRunResult | undefined,
  handle: string | null | undefined
): DataTable | undefined {
  const out = result?.output;
  if (!out) return undefined;
  if ('rows' in out && Array.isArray((out as DataTable).rows)) return out as DataTable;
  return (out as Record<string, DataTable>)[handle ?? 'out'];
}

function combineQuality(results: NodeResultMap): QualityReport | null {
  let total: QualityReport | null = null;
  for (const r of Object.values(results)) {
    for (const t of tables(r.output)) {
      const q = t.meta?.quality;
      if (!q) continue;
      total ??= {
        checkedRows: 0,
        invalidRows: 0,
        missingRequired: 0,
        invalidType: 0,
        duplicateKeys: 0,
        failedRelationships: 0,
      };
      for (const k of Object.keys(total) as (keyof QualityReport)[]) total[k] += q[k];
    }
  }
  return total;
}

export async function executeWorkflow(
  graph: WorkflowGraph,
  options: RunOptions
): Promise<RunOutcome> {
  const now = options.now ?? Date.now;
  const analysis = analyzeGraph(graph);
  const errors = analysis.issues.filter((i) => i.severity === 'error');
  if (errors.length || !analysis.order) {
    return {
      status: 'failed',
      errorCode: 'invalidGraph',
      issues: analysis.issues,
      results: {},
      quality: null,
    };
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const results: NodeResultMap = {};
  let stop: RunErrorCode | null = null;

  for (const nodeId of analysis.order) {
    const node = nodeMap.get(nodeId)!;
    const runtime = RUNTIME[String(node.data.type)]!;

    if (!stop && now() > options.deadline) stop = 'timeout';
    if (!stop && options.isCancelled && (await options.isCancelled())) stop = 'cancelled';
    if (stop) {
      const key = stop === 'timeout' ? 'wf.err.timeout' : 'wf.err.cancelled';
      results[nodeId] = {
        ok: false,
        skipped: true,
        durationMs: 0,
        error: errorInfo(new WorkflowError(key)),
      };
      continue;
    }

    const edges = incoming(graph, nodeId);
    if (edges.some((e) => !results[e.source]?.ok)) {
      results[nodeId] = {
        ok: false,
        skipped: true,
        durationMs: 0,
        error: errorInfo(new WorkflowError('wf.err.upstreamFailed')),
      };
      continue;
    }
    const inputs = edges.map((e) => outputFor(results[e.source], e.sourceHandle));
    if (inputs.some((i) => !i)) {
      results[nodeId] = {
        ok: false,
        durationMs: 0,
        error: errorInfo(new WorkflowError('wf.err.missingInput')),
      };
      continue;
    }

    const t0 = now();
    try {
      const output = await runtime.run(node.data.config ?? {}, inputs as DataTable[], options.ctx);
      results[nodeId] = { ok: true, output, durationMs: Math.max(0, Math.round(now() - t0)) };
    } catch (error) {
      results[nodeId] = {
        ok: false,
        error: errorInfo(error),
        durationMs: Math.max(0, Math.round(now() - t0)),
      };
    }
  }

  const failed = Object.values(results).some((r) => !r.ok);
  const status: RunStatus = stop === 'cancelled' ? 'cancelled' : failed ? 'failed' : 'success';
  const errorCode: RunErrorCode | undefined = stop ?? (failed ? 'nodeFailed' : undefined);
  return { status, errorCode, issues: analysis.issues, results, quality: combineQuality(results) };
}

// ─── Shaping results ──────────────────────────────────────────────────────────

export function displayRowLimit(type: string, cfg: any): number {
  switch (type) {
    case 'out.table':
      return Math.min(Math.max(1, Number(cfg?.maxRows) || 200), 500);
    case 'out.csv':
      return 5000;
    case 'out.barChart':
      return 500;
    case 'out.lineChart':
      return 2000;
    case 'out.dataset':
      return 200;
    // Summary rows are few (≤ 1000 groups) and each opens its records.
    case 'src.erpSummary':
      return 1000;
    default:
      return 50;
  }
}

function capTable(t: DataTable, limit: number): DataTable {
  if (t.rows.length <= limit) return t;
  return {
    ...t,
    rows: t.rows.slice(0, limit),
    meta: { ...t.meta, count: t.meta?.count ?? t.rows.length, displayTruncated: true },
  };
}

export function forDisplay(graph: WorkflowGraph, results: NodeResultMap): NodeResultMap {
  const out: NodeResultMap = {};
  for (const node of graph.nodes) {
    const r = results[node.id];
    if (!r) continue;
    const limit = displayRowLimit(String(node.data.type), node.data.config);
    let output = r.output;
    if (output && 'rows' in output && Array.isArray((output as DataTable).rows))
      output = capTable(output as DataTable, limit);
    else if (output)
      output = Object.fromEntries(
        Object.entries(output).map(([h, t]) => [h, capTable(t as DataTable, limit)])
      );
    out[node.id] = { ...r, output };
  }
  return out;
}

export interface NodeSummary {
  ok: boolean;
  ms: number;
  rows?: number;
  cols?: number;
  skipped?: boolean;
  error?: { key?: string; vars?: Record<string, string | number> };
  warnings?: string[];
}

export function summarize(results: NodeResultMap): Record<string, NodeSummary> {
  return Object.fromEntries(
    Object.entries(results).map(([id, r]) => {
      const t = tables(r.output);
      const summary: NodeSummary = { ok: r.ok, ms: r.durationMs };
      if (t.length) {
        summary.rows = t.reduce((n, x) => n + (x.meta?.count ?? x.rows.length), 0);
        summary.cols = t[0].columns.length;
        const warnings = t.flatMap((x) => (x.meta?.warnings ?? []).map((w) => w.key));
        if (warnings.length) summary.warnings = [...new Set(warnings)];
      }
      if (r.skipped) summary.skipped = true;
      if (r.error) summary.error = { key: r.error.key, vars: r.error.vars };
      return [id, summary];
    })
  );
}

export function outputRowCount(graph: WorkflowGraph, results: NodeResultMap): number {
  return graph.nodes
    .filter((n) => RUNTIME[String(n.data.type)]?.outputs.length === 0)
    .reduce(
      (sum, n) =>
        sum +
        tables(results[n.id]?.output).reduce(
          (s, t) => s + (t.meta?.sourceRows ?? t.meta?.count ?? t.rows.length),
          0
        ),
      0
    );
}
