// The tools an MCP client may call on /api/mcp: reading one Terminal's
// pipelines, their runs and its datasets, insights into a dataset, and, for
// connections allowed to write, building pipelines (drafts only: a person
// publishes them in the editor). Each call is one transaction as the member
// the access token belongs to (row-level security and the masking views
// decide what they see, as in the app); the Terminal is the token's,
// whatever the arguments say.

import type { Executor, SqlTx } from '@/server/db/executor';
import { asUser, isUuid, TerminalError, type RequestIdentity } from '@/server/terminal/session';
import { listDatasets, loadDataset, readRows, visibleColumns } from '@/server/terminal/datasets';
import { analyzeSeries, fillGaps, readProfile, readSeries } from '@/server/terminal/aiJobs';
import { healthOf } from '@/server/terminal/service';
import { parseInsightInput } from '@/lib/terminal/insights';
import { cleanGraph } from '@/lib/workflow/graph';
import type { WorkflowGraph } from '@/lib/workflow/types';
import { ToolError, type McpTool } from './protocol';
import {
  GraphShapeError,
  attachDatasets,
  check,
  erpFields,
  fromEditorGraph,
  graphInputSchema,
  nodeTypes,
  testRun,
  toEditorGraph,
} from './builder';

export interface McpContext {
  executor: Executor;
  identity: RequestIdentity;
  workspaceId: string;
  /** The access token used (the database checks it again for writes). */
  tokenId?: string;
  /** The connection may build pipelines (chosen when it was made). */
  canWrite?: boolean;
  /** A shared rate limit per token: false when the bucket is full. */
  allow?: (bucket: string, max: number, seconds: number) => Promise<boolean>;
}

/** The tools this connection may use: the writing ones only when it may write. */
export const toolsFor = (ctx: McpContext) =>
  ctx.canWrite ? MCP_TOOLS : MCP_TOOLS.filter((t) => !t.write);

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
      if (WRITE_ERRORS[error.code]) throw new ToolError(WRITE_ERRORS[error.code]);
      if (error.code === 'notFound') throw new ToolError('Not found in this Terminal.');
      if (error.code === 'forbidden' || error.code === 'mfaRequired')
        throw new ToolError('The access token does not allow this.');
      if (error.code === 'timeout') throw new ToolError('The database took too long.');
    }
    throw error;
  }
}

const WRITE_ERRORS: Record<string, string> = {
  conflict:
    'The draft changed since it was read (saved in the editor or by another assistant). Read it again with get_pipeline and apply the change to that.',
  not_owner:
    'Only pipelines this member made can be changed. Create a new pipeline instead (create_pipeline), for example an improved copy.',
  read_only: 'This connection may only read.',
  name: 'Give the pipeline a name.',
  graph: 'The graph is not valid (at most 100 nodes and 300 edges).',
  too_many: 'At most 100 pipelines a day through MCP.',
  no_write: 'The member may not build pipelines in this Terminal.',
};

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
            w.updated_at::text AS revision, w.user_id = auth.uid() AS mine, w.mcp_client, w.mcp_edited_at,
            v.version AS published_version, v.created_at AS published_at
       FROM public.workflows w
       LEFT JOIN public.workflow_versions v ON v.id = w.published_version_id
      WHERE w.id = $1 AND w.workspace_id = $2`,
    [id, ctx.workspaceId]
  );
  if (!rows[0]) throw new ToolError('Pipeline not found in this Terminal.');
  return rows[0];
}

/** An assistant's graph as the editor's, checked; unusable graphs are refused. */
async function shaped(
  tx: SqlTx,
  ctx: McpContext,
  args: Record<string, unknown>,
  previous: WorkflowGraph | null
) {
  let graph: WorkflowGraph;
  try {
    graph = toEditorGraph(args.nodes, args.edges ?? [], previous);
  } catch (error) {
    if (error instanceof GraphShapeError)
      throw new ToolError(`The graph cannot be used: ${error.message}`);
    throw error;
  }
  return { graph, result: check(graph, await attachDatasets(tx, ctx.workspaceId, graph)) };
}

const REVIEW =
  'Saved as a draft. Nothing runs on its own until a person opens it in the PrintStream editor, reviews it and publishes a version.';

/** A dataset of the token's Terminal that the member may query. */
async function queryableDataset(tx: SqlTx, ctx: McpContext, id: string) {
  const ds = await loadDataset(tx, id);
  if (ds.workspaceId !== ctx.workspaceId)
    throw new ToolError('Dataset not found in this Terminal.');
  const ok = await tx.query(`SELECT public.ps_can_access_dataset($1, 'query') AS ok`, [ds.id]);
  if (ok.rows[0]?.ok !== true) throw new ToolError('The member may not query this dataset.');
  if (ds.status !== 'ready' && ds.status !== 'altering')
    throw new ToolError(`The dataset is not ready (${ds.status}).`);
  return ds;
}

const logInsight = (
  tx: SqlTx,
  ds: { workspaceId: string; id: string; name: string; rowCount: number },
  kind: string
) =>
  tx.query(
    `SELECT public.erp_log_data_access($1::uuid, 'dataset', $2, 'query', $3, '{}'::text[], null, $4::jsonb)`,
    [
      ds.workspaceId,
      ds.id,
      ds.rowCount,
      JSON.stringify({ name: ds.name, insight: kind, via: 'mcp' }),
    ]
  );

const graphArgs = {
  type: 'object',
  properties: { ...graphInputSchema },
  required: ['nodes'],
  additionalProperties: false,
} as const;

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
      "One pipeline's steps (nodes: id, type, label, configuration) and how they connect (edges), the draft or a published version, with its schedule and the pipelines it starts or that start it. The draft_revision is what update_pipeline needs.",
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
          draft_revision: w.revision,
          can_change: w.mine === true,
          last_changed_through_mcp: w.mcp_client
            ? { by: w.mcp_client, at: iso(w.mcp_edited_at) }
            : null,
          draft_unpublished_changes:
            !w.published_at || new Date(w.updated_at) > new Date(w.published_at),
          ...fromEditorGraph(graph),
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
        const nodes = fromEditorGraph(r.graph).nodes as {
          id: string;
          label: string;
          type: string;
        }[];
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

  // ─── Building pipelines ─────────────────────────────────────────────────────
  {
    name: 'list_node_types',
    title: 'List pipeline steps',
    description:
      'The kinds of steps (nodes) a pipeline can have: sources (ERP records, datasets), transforms, combining and cleaning, matching, reshaping, quality checks, analysis and outputs. For each: inputs, output ports, the default configuration and notes on the configuration. Read this before building a pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [
            'source',
            'transform',
            'combine',
            'match',
            'reshape',
            'quality',
            'analysis',
            'output',
          ],
        },
      },
      additionalProperties: false,
    },
    run: async (_ctx, args) => ({
      format:
        'A pipeline is nodes {id, type, label, config} and edges {from, to, from_port?}. Rows flow along the edges; each node gets the columns of the nodes before it. Lists of columns in config are comma-separated text.',
      node_types: nodeTypes(typeof args.category === 'string' ? args.category : undefined),
    }),
  },
  {
    name: 'list_erp_fields',
    title: 'List ERP records and fields',
    description:
      'What an "ERP Data" or "ERP Summary" source can read: the record kinds (entities) and, for one entity, its fields (key, type, allowed values), relations and date field.',
    inputSchema: {
      type: 'object',
      properties: { entity: { type: 'string', description: 'One entity, with its fields.' } },
      additionalProperties: false,
    },
    run: async (_ctx, args) => {
      const entities = erpFields(typeof args.entity === 'string' ? args.entity : undefined);
      if (args.entity && !entities.length)
        throw new ToolError('Unknown entity (see list_erp_fields).');
      return { entities };
    },
  },
  {
    name: 'validate_pipeline',
    title: 'Check a pipeline',
    description:
      "Checks a pipeline (nodes and edges) the way the editor does, without saving it: missing inputs or settings, unknown columns, cycles, datasets that are not this Terminal's. Returns the problems and the columns each step puts out.",
    inputSchema: graphArgs,
    run: (ctx, args) => read(ctx, async (tx) => (await shaped(tx, ctx, args, null)).result),
  },
  {
    name: 'test_pipeline',
    title: 'Test-run a pipeline',
    description:
      'Runs a draft once, as the member, and writes nothing: steps that write (to a dataset or an ERP list) say how many rows they would write. Give pipeline_id to run its saved draft, or nodes and edges to run a graph before saving it. Returns each step (rows, columns, warnings, errors) and a few rows of each final step. At most 10 test runs per 10 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'From list_pipelines; its draft is run.' },
        ...graphInputSchema,
      },
      additionalProperties: false,
    },
    run: async (ctx, args) => {
      if (ctx.allow && !(await ctx.allow('mcp_test', 10, 600)))
        throw new ToolError('Too many test runs; wait a few minutes.');
      const prepared = await read(ctx, async (tx) => {
        if (args.pipeline_id !== undefined) {
          const w = await pipelineRow(tx, ctx, uuidArg(args, 'pipeline_id'));
          const graph = cleanGraph(w.graph);
          return { graph, result: check(graph, await attachDatasets(tx, ctx.workspaceId, graph)) };
        }
        if (args.nodes === undefined) throw new ToolError('Give pipeline_id, or nodes and edges.');
        return shaped(tx, ctx, args, null);
      });
      if (!prepared.result.ok) return { status: 'not_run', ...prepared.result };
      return testRun(ctx.executor, ctx.identity, ctx.workspaceId, prepared.graph);
    },
  },
  {
    name: 'create_pipeline',
    title: 'Create a pipeline (draft)',
    write: true,
    description:
      'Saves a new pipeline in this Terminal as a draft, owned by the member: nodes and edges as in validate_pipeline. It is checked first; a graph with problems is saved too (as a draft to finish), and the problems are returned. It does not run, and is not published: a person reviews it in the editor and publishes it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 120 },
        description: { type: 'string', maxLength: 2000 },
        ...graphInputSchema,
      },
      required: ['name', 'nodes'],
      additionalProperties: false,
    },
    run: (ctx, args) =>
      read(ctx, async (tx) => {
        const { graph, result } = await shaped(tx, ctx, args, null);
        const { rows } = await tx.query(
          `SELECT id, updated_at::text AS revision FROM public.ps_mcp_pipeline_create($1, $2, $3, $4, $5::jsonb)`,
          [
            ctx.tokenId ?? null,
            ctx.workspaceId,
            String(args.name ?? ''),
            typeof args.description === 'string' ? args.description : null,
            JSON.stringify(graph),
          ]
        );
        return {
          id: rows[0].id,
          draft_revision: rows[0].revision,
          editor_path: `/pipelines/${rows[0].id}`,
          ...result,
          next: REVIEW,
        };
      }),
  },
  {
    name: 'update_pipeline',
    title: 'Change a pipeline draft',
    write: true,
    description:
      'Changes the draft of a pipeline the member made: give the whole new nodes and edges (steps with the same id keep their place on the canvas), and/or a new name or description. draft_revision from get_pipeline is required, so that changes saved since in the editor are not overwritten. Published versions stay as they are; a person publishes the new draft after reviewing it.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
        draft_revision: { type: 'string', description: 'From get_pipeline.' },
        name: { type: 'string', maxLength: 120 },
        description: { type: 'string', maxLength: 2000 },
        ...graphInputSchema,
      },
      required: ['pipeline_id', 'draft_revision'],
      additionalProperties: false,
    },
    run: (ctx, args) =>
      read(ctx, async (tx) => {
        const w = await pipelineRow(tx, ctx, uuidArg(args, 'pipeline_id'));
        if (!w.mine) throw new ToolError(WRITE_ERRORS.not_owner);
        const previous = cleanGraph(w.graph);
        const next =
          args.nodes === undefined
            ? { ...fromEditorGraph(previous) }
            : { nodes: args.nodes, edges: args.edges ?? [] };
        const { graph, result } = await shaped(tx, ctx, next, previous);
        const { rows } = await tx.query(
          `SELECT public.ps_mcp_pipeline_update($1, $2, $3::timestamptz, $4::jsonb, $5, $6)::text AS revision`,
          [
            ctx.tokenId ?? null,
            w.id,
            typeof args.draft_revision === 'string' ? args.draft_revision : null,
            JSON.stringify(graph),
            typeof args.name === 'string' ? args.name : null,
            typeof args.description === 'string' ? args.description : null,
          ]
        );
        return {
          id: w.id,
          draft_revision: rows[0].revision,
          editor_path: `/pipelines/${w.id}`,
          ...result,
          next: REVIEW,
        };
      }),
  },

  // ─── Insights ───────────────────────────────────────────────────────────────
  {
    name: 'profile_dataset',
    title: 'Profile a dataset',
    description:
      'Every column of a dataset at a glance, computed over all its rows: filled and empty values, distinct values, minimum, maximum and mean, and the most common values of text columns (not of sensitive ones). In the data-access log.',
    inputSchema: {
      type: 'object',
      properties: { dataset_id: { type: 'string', description: 'From list_datasets.' } },
      required: ['dataset_id'],
      additionalProperties: false,
    },
    run: (ctx, args) =>
      read(ctx, async (tx) => {
        const ds = await queryableDataset(tx, ctx, uuidArg(args, 'dataset_id'));
        const profile = await readProfile(tx, ds);
        await logInsight(tx, ds, 'profile');
        return { id: ds.id, name: ds.name, rows: ds.rowCount, columns: profile };
      }),
  },
  {
    name: 'analyze_dataset',
    title: 'Trend, anomalies or forecast',
    description:
      'A measure of a dataset per period (sum, avg, count, min or max of a numeric column per day, week, month or quarter of a date column), with its trend, and either the unusual periods (anomalies: modified z-score) or a forecast (Holt, with a 95% interval and its accuracy on the history). The numbers are computed in PrintStream; explain them from the evidence given.',
    inputSchema: {
      type: 'object',
      properties: {
        dataset_id: { type: 'string' },
        kind: { type: 'string', enum: ['anomalies', 'forecast'] },
        date_column: { type: 'string', description: 'A date or timestamp column (its name).' },
        value_column: { type: 'string', description: 'A numeric column; not needed for count.' },
        measure: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'], default: 'sum' },
        period: { type: 'string', enum: ['day', 'week', 'month', 'quarter'], default: 'month' },
        horizon: { type: 'integer', minimum: 1, maximum: 36, default: 6 },
      },
      required: ['dataset_id', 'kind', 'date_column'],
      additionalProperties: false,
    },
    run: (ctx, args) =>
      read(ctx, async (tx) => {
        const ds = await queryableDataset(tx, ctx, uuidArg(args, 'dataset_id'));
        const columns = visibleColumns(ds).map((c) => ({
          label: c.label,
          type: c.type,
          sensitive: c.sensitive,
        }));
        const input = parseInsightInput({ ...args, provider_id: null }, columns);
        if ('problem' in input)
          throw new ToolError(
            input.problem === 'date_column'
              ? 'date_column must be a date or timestamp column of the dataset.'
              : input.problem === 'value_column'
                ? 'value_column must be a numeric column of the dataset (or use measure "count").'
                : `Invalid ${input.problem}.`
          );
        const points = fillGaps(await readSeries(tx, ds, input), input.period, input.measure);
        if (points.length < 3)
          throw new ToolError('Too few periods with values (at least 3) for an analysis.');
        const analysis = analyzeSeries(points, input);
        await logInsight(tx, ds, input.kind);
        return {
          dataset: { id: ds.id, name: ds.name },
          measure: `${input.measure}(${input.value_column ?? '*'}) per ${input.period} of ${input.date_column}`,
          method: analysis.method,
          confidence: analysis.confidence,
          evidence: analysis.evidence,
          ...(input.kind === 'forecast'
            ? { forecast: (analysis.output as { forecast: unknown }).forecast }
            : { anomalies: (analysis.output as { anomalies: unknown }).anomalies }),
          series_tail: points.slice(-36),
        };
      }),
  },
  {
    name: 'get_terminal_health',
    title: 'What needs attention',
    description:
      'What needs attention in this Terminal: whether the background worker is running, waiting and failed jobs, pipelines whose last run failed, late or stopped schedules, failing syncs and datasets that stopped changing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (ctx) => read(ctx, (tx) => healthOf(tx, ctx.workspaceId)),
  },
];
