// Terminal pipelines outside the editor: a published version run by the
// worker (Run now in the background, schedules, chains), as the user the job
// runs for. The same executor as the editor's runs; here the "Write to
// dataset" node really writes.

import { createHash } from 'node:crypto';
import {
  QueryExecutionError,
  executeQuery,
  resolveScope,
  resolveScopeFor,
} from '@/lib/analytics/server';
import { summaryEntities } from '@/lib/analytics/summary';
import { RestClient } from '@/lib/db/rest-client';
import { WorkflowError } from '@/lib/workflow/errors';
import { executeWorkflow, outputRowCount, summarize } from '@/lib/workflow/executor';
import { cleanGraph, stableStringify } from '@/lib/workflow/graph';
import type { RuntimeContext } from '@/lib/workflow/runtime';
import { buildSummarySql, shapeSummary } from '@/server/analytics/summary-sql';
import { executeSpec } from '@/server/db/execute';
import type { Executor } from '@/server/db/executor';
import { asDataTable, loadDataset, readRows, writeTable } from './datasets';
import { TerminalError, asUser, type RequestIdentity } from './session';
import { erpWorkspaceFor, writeErpList } from './erpLinks';

/** A data client like the routes' one, acting as the user. */
export function userClient(executor: Executor, identity: RequestIdentity) {
  const rest = new RestClient((spec) => executeSpec(executor, identity, spec));
  return {
    from: (table: string) => rest.from(table),
    rpc: (
      fn: string,
      args?: Record<string, unknown>,
      options?: { count?: 'exact'; head?: boolean }
    ) => rest.rpc(fn, args, options),
    auth: {
      async getUser() {
        return {
          data: { user: { id: identity.userId, email: identity.email } as any },
          error: null,
        };
      },
    },
  };
}

const asWorkflowError = (error: unknown) => {
  if (error instanceof QueryExecutionError)
    return new WorkflowError(error.code === 'timeout' ? 'wf.err.timeout' : `cat.err.${error.code}`);
  if (error instanceof TerminalError) return new WorkflowError(`ps.err.${error.code}`, error.vars);
  return error;
};

/** Reading datasets in a run (editor and worker alike). */
export function datasetReader(
  executor: Executor,
  identity: RequestIdentity,
  path: string
): RuntimeContext['readDataset'] {
  return async ({ datasetId, limit }) => {
    try {
      return await asUser(executor, identity, path, async (tx) => {
        const ds = await loadDataset(tx, datasetId);
        if (ds.status !== 'ready' && ds.status !== 'altering')
          throw new TerminalError('datasetNotReady');
        return asDataTable(ds, await readRows(tx, ds, { limit, operation: 'query' }));
      });
    } catch (error) {
      throw asWorkflowError(error);
    }
  };
}

/**
 * What a run reads (ERP records, summaries, datasets), as the user; without
 * the writes, a run only shows what it would write (the editor, MCP test runs).
 */
export function readingContext(
  executor: Executor,
  identity: RequestIdentity,
  workspaceId: string,
  path: string,
  deadline: number
): RuntimeContext {
  const db = userClient(executor, identity);
  return {
    query: async (spec, erp) => {
      try {
        const ws = await erpWorkspaceFor(db as any, workspaceId, erp);
        const scope = await resolveScope(db as any, identity.userId, ws, spec);
        return await executeQuery(db as any, spec, scope, deadline);
      } catch (e) {
        throw asWorkflowError(e);
      }
    },
    summarize: async (spec, erp) => {
      try {
        const scope = await resolveScopeFor(
          db as any,
          identity.userId,
          await erpWorkspaceFor(db as any, workspaceId, erp),
          summaryEntities(spec)
        );
        const built = buildSummarySql(spec, scope);
        const raw = await asUser(
          executor,
          identity,
          '/analytics/summary',
          async (tx) => (await tx.query(built.sql, built.params)).rows
        );
        return { ...shapeSummary(spec, raw), fetchedAt: new Date().toISOString() };
      } catch (e) {
        throw asWorkflowError(e);
      }
    },
    readDataset: datasetReader(executor, identity, path),
  };
}

export interface PipelineJob {
  id: string;
  workspace_id: string;
  trigger: 'manual' | 'schedule' | 'chain' | 'system';
  payload: { pipeline_id?: string; version_id?: string };
}

export interface PipelineRunResult {
  status: 'success' | 'failed' | 'cancelled';
  runId: string;
  rows: number;
  errorCode: string | null;
  written: number;
}

const RUN_BUDGET_MS = 2 * 60 * 60 * 1000;

// As the editor's run route (lib/workflow/server.ts, which needs Next.js).
const graphHash = (graph: unknown) =>
  createHash('sha256').update(stableStringify(graph)).digest('hex');

export async function runPipelineJob(
  executor: Executor,
  identity: RequestIdentity,
  job: PipelineJob,
  pipeline: { workspace_id: string; published_version_id: string | null },
  hooks: { beat: () => Promise<boolean> }
): Promise<PipelineRunResult> {
  const db = userClient(executor, identity);
  const pipelineId = job.payload.pipeline_id!;
  const versionId = job.payload.version_id ?? pipeline.published_version_id;
  if (!versionId) throw new TerminalError('notPublished');
  const { data: version, error } = await db
    .from('workflow_versions')
    .select('graph')
    .eq('id', versionId)
    .eq('workflow_id', pipelineId)
    .maybeSingle();
  if (error || !version) throw new TerminalError('notFound');
  const graph = cleanGraph(version.graph);

  const trigger =
    job.trigger === 'schedule' ? 'schedule' : job.trigger === 'chain' ? 'chain' : 'background';
  const { data: startRows, error: startError } = await db.rpc('workflow_run_start', {
    p_workflow_id: pipelineId,
    p_run_kind: job.payload.version_id ? 'version' : 'published',
    p_version_id: versionId,
    p_request_id: null,
    p_graph_hash: graphHash(graph),
    p_triggered_by: trigger,
  });
  if (startError)
    throw new TerminalError(startError.code === '42501' ? 'forbidden' : 'runNotStarted');
  const start = (Array.isArray(startRows) ? startRows[0] : startRows) as { run_id: string };

  const deadline = Date.now() + RUN_BUDGET_MS;
  const path = '/terminal/pipeline/run';
  let cancelled = false;
  let written = 0;
  const outcome = await executeWorkflow(graph, {
    deadline,
    ctx: {
      ...readingContext(executor, identity, pipeline.workspace_id, path, deadline),
      writeDataset: async ({ datasetId, mode }, table) => {
        try {
          const r = await writeTable(
            executor,
            identity,
            datasetId,
            table,
            mode,
            `job:${job.id}`,
            async () => {
              if (await hooks.beat()) cancelled = true;
            }
          );
          written += r.written;
          await asUser(executor, identity, path, (tx) =>
            tx.query(
              `SELECT public.ps_record_lineage($1, 'dataset', $2, 'dataset', $3, 'pipeline', $4::uuid, $5::uuid)`,
              [pipeline.workspace_id, pipelineId, datasetId, pipelineId, start.run_id]
            )
          );
          return { written: r.written, rejected: r.rejected };
        } catch (e) {
          throw asWorkflowError(e);
        }
      },
      writeErpList: async ({ erpId, list, mode }, table) => {
        try {
          return await writeErpList(
            executor,
            identity,
            pipeline.workspace_id,
            erpId,
            list,
            mode,
            table
          );
        } catch (e) {
          throw asWorkflowError(e);
        }
      },
    },
    isCancelled: async () => {
      if (await hooks.beat()) cancelled = true;
      return cancelled;
    },
  });

  const status = cancelled ? 'cancelled' : outcome.status;
  const firstError =
    Object.values(outcome.results).find((r) => r.error && !r.skipped)?.error ??
    outcome.issues.find((i) => i.severity === 'error');
  await db.rpc('workflow_run_finish', {
    p_run_id: start.run_id,
    p_status: status,
    p_node_results: summarize(outcome.results),
    p_quality: outcome.quality ?? {},
    p_row_count: outputRowCount(graph, outcome.results),
    p_error_code: cancelled ? 'cancelled' : (outcome.errorCode ?? null),
    p_error: (firstError as { key?: string } | undefined)?.key ?? null,
  });
  return {
    status: status as PipelineRunResult['status'],
    runId: start.run_id,
    rows: outputRowCount(graph, outcome.results) ?? 0,
    errorCode: cancelled ? 'cancelled' : (outcome.errorCode ?? null),
    written,
  };
}
