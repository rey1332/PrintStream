// The tools an MCP client may call on /api/mcp: reading one Terminal's
// pipelines, their runs and its datasets. Each call is one read-only
// transaction as the member the access token belongs to (row-level security
// and the masking views decide what they see, as in the app); the Terminal
// is the token's, whatever the arguments say.

import type { Executor, SqlTx } from '@/server/db/executor';
import { asUser, isUuid, TerminalError, type RequestIdentity } from '@/server/terminal/session';
import { listDatasets, loadDataset, readRows } from '@/server/terminal/datasets';
import { ToolError, type McpTool } from './protocol';

export interface McpContext {
  executor: Executor;
  identity: RequestIdentity;
  workspaceId: string;
}

const PATH = '/api/mcp';
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

async function read<T>(ctx: McpContext, fn: (tx: SqlTx) => Promise<T>): Promise<T> {
  try {
    // Only reads (a dataset preview also writes its line in the data-access log).
    // A ToolError is the tool's answer to the model, not a failed transaction.
    let answer: ToolError | null = null;
    const result = await asUser(
      ctx.executor,
      ctx.identity,
      PATH,
      async (tx) => {
        try {
          return await fn(tx);
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          answer = error;
          return null as T;
        }
      },
      { timeout: '10s' }
    );
    if (answer) throw answer;
    return result;
  } catch (error) {
    if (error instanceof TerminalError) {
      if (error.code === 'notFound') throw new ToolError('Not found in this Terminal.');
      if (error.code === 'forbidden' || error.code === 'mfaRequired')
        throw new ToolError('The access token does not allow this.');
      if (error.code === 'timeout') throw new ToolError('The database took too long.');
    }
    throw error;
  }
}

const uuidArg = (args: Record<string, unknown>, name: string): string => {
  const v = args[name];
  if (!isUuid(v)) throw new ToolError(`${name} must be the id (a UUID) from a list tool.`);
  return v;
};
const limitArg = (args: Record<string, unknown>, fallback: number, max: number) => {
  const n = Number(args.limit ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), max) : fallback;
};

/** A pipeline of the token's Terminal that the member may see, or not found. */
async function pipelineRow(tx: SqlTx, ctx: McpContext, id: string) {
  const { rows } = await tx.query(
    `SELECT w.id, w.name, w.description, w.enabled, w.access, w.graph, w.updated_at, w.published_version_id,
            v.version AS published_version
       FROM public.workflows w
       LEFT JOIN public.workflow_versions v ON v.id = w.published_version_id
      WHERE w.id = $1 AND w.workspace_id = $2`,
    [id, ctx.workspaceId]
  );
  if (!rows[0]) throw new ToolError('Pipeline not found in this Terminal.');
  return rows[0];
}

// Node data as the editor stores it, without what only the editor needs
// (cached previews, statuses, positions).
function describeGraph(graph: any) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  return {
    nodes: nodes.map((n: any) => ({
      id: String(n.id),
      type: String(n.data?.type ?? n.type ?? ''),
      label: String(n.data?.label ?? ''),
      config: n.data?.config ?? {},
      ...(n.data?.disabled ? { disabled: true } : {}),
    })),
    edges: edges.map((e: any) => ({
      from: String(e.source),
      to: String(e.target),
      ...(e.sourceHandle ? { fromPort: String(e.sourceHandle) } : {}),
      ...(e.targetHandle ? { toPort: String(e.targetHandle) } : {}),
    })),
  };
}

export const MCP_TOOLS: McpTool<McpContext>[] = [
  {
    name: 'list_pipelines',
    title: 'List pipelines',
    description:
      'The pipelines of this Terminal: id, name, description, whether enabled, published version, schedule (next run) and the last run (status, when).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (ctx) =>
      read(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT w.id, w.name, w.description, w.enabled, w.updated_at, v.version AS published_version,
                  s.kind AS schedule_kind, s.spec AS schedule_spec, s.timezone AS schedule_timezone,
                  s.enabled AS schedule_enabled, s.next_run_at, s.disabled_reason,
                  (SELECT jsonb_build_object('id', r.id, 'status', r.status, 'started_at', r.started_at,
                                             'finished_at', r.finished_at, 'triggered_by', r.triggered_by)
                     FROM public.workflow_runs r WHERE r.workflow_id = w.id ORDER BY r.started_at DESC LIMIT 1) AS last_run
             FROM public.workflows w
             LEFT JOIN public.workflow_versions v ON v.id = w.published_version_id
             LEFT JOIN public.ps_schedules s ON s.pipeline_id = w.id
            WHERE w.workspace_id = $1
            ORDER BY lower(w.name)
            LIMIT 500`,
          [ctx.workspaceId]
        );
        return {
          pipelines: rows.map((r: any) => ({
            id: r.id,
            name: r.name,
            description: r.description ?? '',
            enabled: r.enabled,
            published_version: r.published_version,
            updated_at: iso(r.updated_at),
            schedule: r.schedule_kind
              ? {
                  kind: r.schedule_kind,
                  spec: r.schedule_spec,
                  timezone: r.schedule_timezone,
                  enabled: r.schedule_enabled,
                  next_run_at: iso(r.next_run_at),
                  disabled_reason: r.disabled_reason,
                }
              : null,
            last_run: r.last_run,
          })),
        };
      }),
  },
  {
    name: 'get_pipeline',
    title: 'Read a pipeline',
    description:
      "One pipeline's steps (nodes: id, type, label, configuration) and how they connect (edges), the draft or a published version, with its schedule and the pipelines it starts or that start it.",
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'From list_pipelines.' },
        version: {
          description: '"draft" (default), "published", or a version number.',
          oneOf: [
            { type: 'string', enum: ['draft', 'published'] },
            { type: 'integer', minimum: 1 },
          ],
        },
      },
      required: ['pipeline_id'],
      additionalProperties: false,
    },
    run: (ctx, args) =>
      read(ctx, async (tx) => {
        const w = await pipelineRow(tx, ctx, uuidArg(args, 'pipeline_id'));
        let graph = w.graph;
        let version: number | 'draft' = 'draft';
        const wanted = args.version ?? 'draft';
        if (wanted !== 'draft') {
          const n = wanted === 'published' ? w.published_version : Number(wanted);
          if (!n) throw new ToolError('This pipeline has no published version.');
          const { rows } = await tx.query(
            'SELECT version, graph FROM public.workflow_versions WHERE workflow_id = $1 AND version = $2',
            [w.id, n]
          );
          if (!rows[0]) throw new ToolError(`Version ${n} not found.`);
          graph = rows[0].graph;
          version = rows[0].version;
        }
        const versions = (
          await tx.query(
            'SELECT version, note, created_at FROM public.workflow_versions WHERE workflow_id = $1 ORDER BY version DESC LIMIT 20',
            [w.id]
          )
        ).rows.map((v: any) => ({
          version: v.version,
          note: v.note,
          created_at: iso(v.created_at),
        }));
        const chains = (
          await tx.query(
            `SELECT t.upstream_id, u.name AS upstream, t.downstream_id, d.name AS downstream, t.enabled
               FROM public.ps_triggers t
               JOIN public.workflows u ON u.id = t.upstream_id
               JOIN public.workflows d ON d.id = t.downstream_id
              WHERE t.workspace_id = $1 AND (t.upstream_id = $2 OR t.downstream_id = $2)`,
            [ctx.workspaceId, w.id]
          )
        ).rows;
        const schedule = (
          await tx.query(
            'SELECT kind, spec, timezone, enabled, next_run_at, last_run_at, disabled_reason FROM public.ps_schedules WHERE pipeline_id = $1',
            [w.id]
          )
        ).rows[0];
        return {
          id: w.id,
          name: w.name,
          description: w.description ?? '',
          enabled: w.enabled,
          version,
          published_version: w.published_version,
          versions,
          ...describeGraph(graph),
          schedule: schedule
            ? {
                ...schedule,
                next_run_at: iso(schedule.next_run_at),
                last_run_at: iso(schedule.last_run_at),
              }
            : null,
          starts: chains
            .filter((c: any) => c.upstream_id === w.id)
            .map((c: any) => ({ id: c.downstream_id, name: c.downstream, enabled: c.enabled })),
          started_by: chains
            .filter((c: any) => c.downstream_id === w.id)
            .map((c: any) => ({ id: c.upstream_id, name: c.upstream, enabled: c.enabled })),
        };
      }),
  },
  {
    name: 'list_pipeline_runs',
    title: 'List runs of a pipeline',
    description:
      'The latest runs of a pipeline: status, start and end, duration, what started it, version, output rows and the error code of a failed run.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'From list_pipelines.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['pipeline_id'],
      additionalProperties: false,
    },
    run: (ctx, args) =>
      read(ctx, async (tx) => {
        const w = await pipelineRow(tx, ctx, uuidArg(args, 'pipeline_id'));
        const { rows } = await tx.query(
          `SELECT id, status, started_at, finished_at, duration_ms, triggered_by, run_kind, version, row_count, error_code
             FROM public.workflow_runs WHERE workflow_id = $1 ORDER BY started_at DESC LIMIT $2`,
          [w.id, limitArg(args, 20, 100)]
        );
        return {
          pipeline: { id: w.id, name: w.name },
          runs: rows.map((r: any) => ({
            ...r,
            started_at: iso(r.started_at),
            finished_at: iso(r.finished_at),
          })),
        };
      }),
  },
  {
    name: 'get_pipeline_run',
    title: 'Read a pipeline run',
    description:
      'One run step by step: for each node whether it worked, how long it took, rows and columns out, warnings and the error code. Row data is not included.',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string', description: 'From list_pipeline_runs.' } },
      required: ['run_id'],
      additionalProperties: false,
    },
    run: (ctx, args) =>
      read(ctx, async (tx) => {
        const { rows } = await tx.query(
          `SELECT r.id, r.workflow_id, w.name AS pipeline, r.status, r.started_at, r.finished_at, r.duration_ms,
                  r.triggered_by, r.run_kind, r.version, r.version_id, r.row_count, r.error_code, r.quality, r.node_results,
                  COALESCE(v.graph, w.graph) AS graph
             FROM public.workflow_runs r
             JOIN public.workflows w ON w.id = r.workflow_id
             LEFT JOIN public.workflow_versions v ON v.id = r.version_id
            WHERE r.id = $1 AND w.workspace_id = $2`,
          [uuidArg(args, 'run_id'), ctx.workspaceId]
        );
        const r = rows[0];
        if (!r) throw new ToolError('Run not found in this Terminal.');
        const nodes = describeGraph(r.graph).nodes as { id: string; label: string; type: string }[];
        const labels = new Map(nodes.map((n) => [n.id, n]));
        const results = (r.node_results ?? {}) as Record<string, any>;
        // In the pipeline's order, then any step no longer in the graph.
        const order = [
          ...nodes.map((n) => n.id).filter((id) => id in results),
          ...Object.keys(results).filter((id) => !labels.has(id)),
        ];
        return {
          id: r.id,
          pipeline: { id: r.workflow_id, name: r.pipeline },
          status: r.status,
          started_at: iso(r.started_at),
          finished_at: iso(r.finished_at),
          duration_ms: r.duration_ms,
          triggered_by: r.triggered_by,
          run_kind: r.run_kind,
          version: r.version,
          output_rows: r.row_count,
          error_code: r.error_code,
          quality: r.quality,
          steps: order
            .map((id) => [id, results[id]] as const)
            .map(([id, s]) => ({
              node_id: id,
              label: labels.get(id)?.label ?? null,
              type: labels.get(id)?.type ?? null,
              ok: s?.ok ?? null,
              skipped: s?.skipped ?? false,
              ms: s?.ms ?? null,
              rows: s?.rows ?? null,
              columns: s?.cols ?? null,
              warnings: s?.warnings ?? [],
              error: s?.error ?? null,
            })),
        };
      }),
  },
  {
    name: 'list_datasets',
    title: 'List datasets',
    description:
      'The datasets of this Terminal (what pipelines read and write): id, name, folder, status, row count, last change and columns (name, type, key, sensitive).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (ctx) =>
      read(ctx, async (tx) => ({
        datasets: (await listDatasets(tx, ctx.workspaceId)).map((d) => ({
          id: d.id,
          name: d.name,
          folder: d.folder,
          description: d.description,
          status: d.status,
          rows: d.rowCount,
          updated_at: d.updatedAt,
          columns: d.columns
            .filter((c) => !c.hidden)
            .map((c) => ({
              name: c.label,
              type: c.type,
              key: c.key,
              sensitive: c.sensitive,
              unit: c.unit || undefined,
            })),
        })),
      })),
  },
  {
    name: 'preview_dataset',
    title: 'Preview a dataset',
    description:
      'The first rows of a dataset (at most 50), as the member sees them: sensitive columns stay masked unless they may see them. Reads are in the data-access log.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string', description: 'From list_datasets.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      required: ['dataset_id'],
      additionalProperties: false,
    },
    run: (ctx, args) =>
      read(ctx, async (tx) => {
        const ds = await loadDataset(tx, uuidArg(args, 'dataset_id'));
        if (ds.workspaceId !== ctx.workspaceId)
          throw new ToolError('Dataset not found in this Terminal.');
        if (ds.status !== 'ready' && ds.status !== 'altering')
          return { id: ds.id, name: ds.name, status: ds.status, rows: [] };
        const page = await readRows(tx, ds, {
          limit: limitArg(args, 20, 50),
          operation: 'preview',
        });
        const names = new Map(page.columns.map((c) => [c.physical, c.label]));
        return {
          id: ds.id,
          name: ds.name,
          total_rows: page.total,
          columns: page.columns.map((c) => ({ name: c.label, type: c.type })),
          rows: page.rows.map((row) =>
            Object.fromEntries(
              Object.entries(row)
                .filter(([k]) => names.has(k))
                .map(([k, v]) => [names.get(k)!, v])
            )
          ),
        };
      }),
  },
];
