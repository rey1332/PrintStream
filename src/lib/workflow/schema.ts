import { CATALOG, type FieldType } from '@/lib/analytics/catalog';
import { resultColumns, validateQuery } from '@/lib/analytics/query';
import { summaryColumns, validateSummary } from '@/lib/analytics/summary';
import { joinKeyProblem } from '@/lib/analytics/join';
import { ExpressionError, parseExpression } from '@/lib/analytics/expression';
import {
  BRANCH_HANDLES,
  LEGACY_SOURCES,
  RUNTIME,
  erpSourceSpec,
  legacySourceSpec,
  listOf,
  renameMap,
  summaryErrorKey,
  summarySpecOf,
  variablesOf,
} from './runtime';
import type { ColumnLineage, WorkflowGraph } from './types';
import { UNIFY_COLUMN_KEYS, UNIFY_LIST_KEYS, UNIFY_REQUIRED_KEYS, unifySchema } from './unifyNodes';

export interface SchemaColumn {
  name: string;
  type?: FieldType;
  lineage?: ColumnLineage;
  repeated?: boolean;
}

export type Schema = SchemaColumn[] | null;

export interface GraphIssue {
  nodeId?: string;
  severity: 'error' | 'warning';
  key: string;
  vars?: Record<string, string | number>;
}

export interface NodeSchemaInfo {
  inputs: Schema[];
  outputs: Record<string, Schema>;
  issues: GraphIssue[];
}

export const GRAPH_LIMITS = { maxNodes: 100, maxEdges: 300 } as const;

const num = (name: string): SchemaColumn => ({ name, type: 'number' });

function has(schema: Schema, column: string) {
  return schema === null || schema.some((c) => c.name === column);
}

function typeOf(schema: Schema, column: string): FieldType | undefined {
  return schema?.find((c) => c.name === column)?.type;
}

const COLUMN_KEYS: Record<string, string[]> = {
  'tf.filter': ['column'],
  'tf.sort': ['column'],
  'tf.aggregate': ['groupBy', 'aggregateColumn'],
  'tf.mapColumn': ['colA', 'colB'],
  'tf.branch': ['column'],
  'an.describe': ['column'],
  'an.fitDistribution': ['column'],
  'out.barChart': ['categoryColumn', 'valueColumn'],
  'out.lineChart': ['xColumn', 'yColumn'],
  'out.kpi': ['column'],
  ...UNIFY_COLUMN_KEYS,
};

const LIST_KEYS: Record<string, string[]> = {
  'tf.select': ['columns'],
  'tf.validate': ['requiredColumns', 'numericColumns', 'dateColumns', 'uniqueKey'],
  ...UNIFY_LIST_KEYS,
};

const NUMERIC_KEYS: Record<string, string[]> = {
  'tf.aggregate': ['aggregateColumn'],
  'an.describe': ['column'],
  'out.kpi': ['column'],
  'out.barChart': ['valueColumn'],
};

const MEASURE_KEYS: Record<string, { column: string; op?: string }> = {
  'tf.aggregate': { column: 'aggregateColumn', op: 'operation' },
  'out.kpi': { column: 'column', op: 'operation' },
  'out.barChart': { column: 'valueColumn', op: 'aggregation' },
  'an.describe': { column: 'column' },
};

const REQUIRED_KEYS: Record<string, string[]> = {
  'tf.join': ['leftKey', 'rightKey'],
  'tf.calc': ['newColumn', 'formula'],
  'tf.branch': ['column'],
  'an.describe': ['column'],
  'out.kpi': ['column'],
  ...UNIFY_REQUIRED_KEYS,
};

function outputSchema(
  type: string,
  cfg: any,
  inputs: Schema[],
  issues: GraphIssue[],
  nodeId: string
): Record<string, Schema> {
  const issue = (
    key: string,
    vars?: GraphIssue['vars'],
    severity: GraphIssue['severity'] = 'error'
  ) => issues.push({ nodeId, severity, key, vars });
  const [input, right] = inputs;

  if (type === 'src.erp') {
    const v = validateQuery(erpSourceSpec(cfg));
    if (!v.ok) {
      for (const e of v.errors) issue(`cat.err.${e.code}`, { detail: e.detail ?? '' });
      return { out: null };
    }
    return {
      out: resultColumns(v.spec).map((c) => ({
        name: c.name,
        type: c.type,
        lineage: {
          entity: c.entity,
          field: c.field,
          ...(c.relation ? { relation: c.relation } : {}),
        },
        ...(c.relation ? { repeated: true } : {}),
      })),
    };
  }
  if (type === 'src.erpSummary') {
    const v = validateSummary(summarySpecOf(cfg));
    if (!v.ok) {
      for (const e of v.errors)
        issue(summaryErrorKey(e.code), { detail: e.detail ?? '', max: 1000 });
      return { out: null };
    }
    return {
      out: summaryColumns(v.spec).map((c) => ({
        name: c.name,
        type: c.type,
        lineage: Object.fromEntries(
          Object.entries({
            entity: c.entity,
            field: c.field,
            relation: c.relation,
            op: c.op,
            bucket: c.bucket,
          }).filter(([, x]) => x !== undefined)
        ) as unknown as ColumnLineage,
      })),
    };
  }
  // The dataset's columns, as the editor stored them when the dataset was picked.
  if (type === 'src.psDataset') {
    const cols = Array.isArray(cfg?.columns) ? cfg.columns : null;
    if (!cfg?.datasetId) issue('wf.err.pickDataset');
    return {
      out: cols
        ? cols
            .filter((c: any) => typeof c?.name === 'string')
            .map((c: any) => ({ name: c.name, type: c.type as FieldType }))
        : null,
    };
  }
  if (LEGACY_SOURCES[type]) {
    const spec = legacySourceSpec(LEGACY_SOURCES[type]);
    return {
      out: spec.fields.map((f) => ({
        name: f,
        type: CATALOG[spec.entity].fields.find((x) => x.key === f)!.type,
        lineage: { entity: spec.entity, field: f },
      })),
    };
  }

  const unified = unifySchema(type, cfg, inputs);
  if (unified) return unified;

  switch (type) {
    case 'tf.filter':
    case 'tf.sort':
    case 'tf.limit':
    case 'tf.validate':
      return { out: input };
    case 'tf.branch':
      return Object.fromEntries(BRANCH_HANDLES.map((h) => [h, input]));
    case 'tf.aggregate': {
      if (!cfg.groupBy || !cfg.aggregateColumn) return { out: input };
      const group = input?.find((c) => c.name === cfg.groupBy);
      return {
        out: [
          {
            name: cfg.groupBy,
            type: typeOf(input, cfg.groupBy),
            ...(group?.lineage ? { lineage: group.lineage } : {}),
          },
          cfg.operation === 'count'
            ? { name: `${cfg.operation}_${cfg.aggregateColumn}`, type: 'integer' }
            : num(`${cfg.operation}_${cfg.aggregateColumn}`),
          { name: 'record_count', type: 'integer' },
        ],
      };
    }
    case 'tf.mapColumn': {
      try {
        parseExpression(String(cfg.formula ?? ''), ['a', 'b']);
      } catch (e) {
        issue('wf.err.formula', { detail: e instanceof ExpressionError ? e.detail || e.code : '' });
      }
      const repeated = [cfg.colA, cfg.colB].some((c) => input?.find((x) => x.name === c)?.repeated);
      return {
        out: input && [
          ...input.filter((c) => c.name !== cfg.newColumn),
          { ...num(cfg.newColumn), ...(repeated ? { repeated } : {}) },
        ],
      };
    }
    case 'tf.calc': {
      let repeated = false;
      if (input && cfg.formula) {
        try {
          const reads = variablesOf(
            parseExpression(
              String(cfg.formula),
              input.map((c) => c.name)
            )
          );
          repeated = input.some((c) => c.repeated && reads.has(c.name));
        } catch (e) {
          issue('wf.err.formula', {
            detail: e instanceof ExpressionError ? e.detail || e.code : '',
          });
        }
      }
      const name = String(cfg.newColumn ?? '').trim();
      return {
        out:
          input && name
            ? [
                ...input.filter((c) => c.name !== name),
                { ...num(name), ...(repeated ? { repeated } : {}) },
              ]
            : input,
      };
    }
    case 'tf.select': {
      if (!input) return { out: null };
      const keep = listOf(cfg.columns);
      const rename = renameMap(cfg.rename);
      for (const c of Object.keys(rename))
        if (!has(input, c)) issue('wf.err.unknownColumn', { column: c });
      const chosen = keep.length ? input.filter((c) => keep.includes(c.name)) : input;
      const names = chosen.map((c) => rename[c.name] ?? c.name);
      if (new Set(names).size !== names.length) issue('wf.err.duplicateColumn');
      return { out: chosen.map((c, i) => ({ ...c, name: names[i] })) };
    }
    case 'tf.join': {
      if (!input || !right) return { out: null };
      if (cfg.leftKey && !has(input, cfg.leftKey))
        issue('wf.err.joinKeyMissing', { column: cfg.leftKey, side: 'left' });
      if (cfg.rightKey && !has(right, cfg.rightKey))
        issue('wf.err.joinKeyMissing', { column: cfg.rightKey, side: 'right' });
      const l = input.find((c) => c.name === cfg.leftKey);
      const r = right.find((c) => c.name === cfg.rightKey);
      if (l && r && joinKeyProblem(l, r))
        issue('wf.err.joinKeyMismatch', { left: cfg.leftKey, right: cfg.rightKey });
      const leftNames = new Set(input.map((c) => c.name));
      const renamed = right.map((c) => ({
        ...c,
        name:
          c.name === cfg.rightKey && cfg.rightKey === cfg.leftKey
            ? c.name
            : leftNames.has(c.name)
              ? `right.${c.name}`
              : c.name,
      }));
      return { out: [...input, ...renamed.filter((c) => !leftNames.has(c.name))] };
    }
    case 'an.describe':
      return {
        out: ['column', 'count', 'mean', 'stdDev', 'median', 'min', 'max', 'p25', 'p75'].map((n) =>
          n === 'column' ? { name: n, type: 'text' as FieldType } : num(n)
        ),
      };
    case 'an.fitDistribution':
      return { out: null };
    default:
      return {};
  }
}

export function topoOrder(graph: WorkflowGraph): string[] | null {
  const inDegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const next = new Map(graph.nodes.map((n) => [n.id, [] as string[]]));
  for (const e of graph.edges) {
    if (!inDegree.has(e.source) || !inDegree.has(e.target)) continue;
    next.get(e.source)!.push(e.target);
    inDegree.set(e.target, inDegree.get(e.target)! + 1);
  }
  const queue = [...inDegree].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const t of next.get(id)!) {
      inDegree.set(t, inDegree.get(t)! - 1);
      if (inDegree.get(t) === 0) queue.push(t);
    }
  }
  return order.length === graph.nodes.length ? order : null;
}

export function incoming(graph: WorkflowGraph, nodeId: string) {
  return graph.edges.filter((e) => e.target === nodeId);
}

export interface GraphAnalysis {
  nodes: Record<string, NodeSchemaInfo>;
  issues: GraphIssue[];
  order: string[] | null;
}

export function analyzeGraph(graph: WorkflowGraph): GraphAnalysis {
  const issues: GraphIssue[] = [];
  const nodes: Record<string, NodeSchemaInfo> = {};
  if (graph.nodes.length > GRAPH_LIMITS.maxNodes || graph.edges.length > GRAPH_LIMITS.maxEdges) {
    issues.push({
      severity: 'error',
      key: 'wf.issue.tooLarge',
      vars: { nodes: GRAPH_LIMITS.maxNodes, edges: GRAPH_LIMITS.maxEdges },
    });
  }
  const order = topoOrder(graph);
  if (!order) issues.push({ severity: 'error', key: 'wf.err.cycles' });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  for (const nodeId of order ?? graph.nodes.map((n) => n.id)) {
    const node = byId.get(nodeId)!;
    const type = String(node.data?.type ?? '');
    const cfg = node.data?.config ?? {};
    const nodeIssues: GraphIssue[] = [];
    const runtime = RUNTIME[type];
    if (!runtime) {
      nodeIssues.push({ nodeId, severity: 'error', key: 'wf.err.unknownType', vars: { type } });
      nodes[nodeId] = { inputs: [], outputs: {}, issues: nodeIssues };
      issues.push(...nodeIssues);
      continue;
    }
    const edges = incoming(graph, nodeId);
    const inputs: Schema[] = edges.map((e) => {
      const up = nodes[e.source];
      if (!up) return null;
      return up.outputs[e.sourceHandle ?? 'out'] ?? up.outputs.out ?? null;
    });
    if (edges.length < runtime.inputs)
      nodeIssues.push({ nodeId, severity: 'error', key: 'wf.err.missingInput' });
    if (edges.length > runtime.inputs)
      nodeIssues.push({
        nodeId,
        severity: 'error',
        key: 'wf.issue.tooManyInputs',
        vars: { max: runtime.inputs },
      });

    for (const key of REQUIRED_KEYS[type] ?? []) {
      if (!String(cfg[key] ?? '').trim())
        nodeIssues.push({
          nodeId,
          severity: 'error',
          key: 'wf.err.missingConfig',
          vars: { field: key },
        });
    }
    const input = inputs[0] ?? null;
    for (const key of COLUMN_KEYS[type] ?? []) {
      const column = String(cfg[key] ?? '');
      if (column && !has(input, column))
        nodeIssues.push({
          nodeId,
          severity: 'error',
          key: 'wf.err.unknownColumn',
          vars: { column },
        });
    }
    for (const key of LIST_KEYS[type] ?? []) {
      for (const column of listOf(cfg[key])) {
        if (!has(input, column))
          nodeIssues.push({
            nodeId,
            severity: 'error',
            key: 'wf.err.unknownColumn',
            vars: { column },
          });
      }
    }
    for (const key of NUMERIC_KEYS[type] ?? []) {
      const t = typeOf(input, String(cfg[key] ?? ''));
      if (t && !['integer', 'number', 'money'].includes(t))
        nodeIssues.push({
          nodeId,
          severity: 'warning',
          key: 'wf.issue.notNumeric',
          vars: { column: String(cfg[key]) },
        });
    }
    const measure = MEASURE_KEYS[type];
    if (measure) {
      const column = String(cfg[measure.column] ?? '');
      const op = measure.op ? String(cfg[measure.op] ?? 'sum') : 'avg';
      if ((op === 'sum' || op === 'avg') && input?.find((c) => c.name === column)?.repeated) {
        nodeIssues.push({
          nodeId,
          severity: 'error',
          key: 'wf.err.repeatedValues',
          vars: { column },
        });
      }
    }
    const outputs = outputSchema(type, cfg, inputs, nodeIssues, nodeId);
    nodes[nodeId] = { inputs, outputs, issues: nodeIssues };
    issues.push(...nodeIssues);
  }

  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target))
      issues.push({ severity: 'error', key: 'wf.issue.danglingEdge' });
    const handles = RUNTIME[String(byId.get(e.source)?.data?.type ?? '')]?.outputs ?? [];
    if (handles.length > 1 && !handles.includes(String(e.sourceHandle)))
      issues.push({ nodeId: e.source, severity: 'error', key: 'wf.issue.badHandle' });
  }
  return { nodes, issues, order };
}

export function canConnect(graph: WorkflowGraph, source: string, target: string): boolean {
  if (source === target) return false;
  const targetType = String(graph.nodes.find((n) => n.id === target)?.data?.type ?? '');
  const runtime = RUNTIME[targetType];
  if (!runtime || incoming(graph, target).length >= runtime.inputs) return false;
  return (
    topoOrder({
      nodes: graph.nodes,
      edges: [...graph.edges, { id: '__probe', source, target }],
    }) !== null
  );
}
