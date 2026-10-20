// The Terminal worker (decision R-05): a separate process, signed in as the
// role etna_worker, that runs the job queue (public.ps_jobs).
//
//   * Jobs are claimed under a 60-second lease kept by a heartbeat; a lost
//     worker's jobs go back to the queue. At most one job per company runs at
//     a time, so a company's jobs run in the order they were asked for.
//   * A job runs with the rights of the user it belongs to (as_user, with the
//     two-factor level they had when they asked): their claims, role
//     authenticated, the ERP's rules. The worker's own role only reaches the
//     queue and the fixed functions in ps_worker and ps_admin.
//   * Schedules are checked every 30 seconds; maintenance runs daily.
//
// Started by scripts/server/worker.mjs (the server manager runs it beside the app).

import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import pg from 'pg';
import { createGzip } from 'node:zlib';
import { nextRun, type ScheduleKind } from '@/lib/terminal/schedule';
import { companyFolder } from '@/server/documents/storage';
import { poolExecutor, type Executor, type SqlTx } from '@/server/db/executor';
import {
  analyzeImport,
  commitImport,
  importFilePath,
  readOptionsOf,
  type ImportRecord,
} from './imports';
import {
  describe,
  finishOauth,
  runSync,
  testConnection,
  type ConnectorJobEnv,
} from './connectorJobs';
import { runAnalysis, testProvider, type AiJobEnv } from './aiJobs';
import { runPipelineJob, type PipelineJob } from './pipelines';
import { runSqlJob } from './sqlJobs';
import { TerminalError, asUser, terminalErrorOf, type RequestIdentity } from './session';

export interface WorkerOptions {
  databaseUrl: string;
  workerId: string;
  version: string;
  concurrency?: number;
  log?: (line: string) => void;
}

interface Job {
  id: string;
  workspace_id: string | null;
  kind: string;
  payload: any;
  as_user: string | null;
  as_aal: 'aal1' | 'aal2';
  trigger: 'manual' | 'schedule' | 'chain' | 'system';
  attempts: number;
  max_attempts: number;
}

interface Context {
  executor: Executor;
  workerId: string;
  log: (line: string) => void;
}

class LeaseLost extends Error {}

/** Errors worth another attempt: the moment, not the request, was wrong. */
const RETRYABLE = new Set([
  'failed',
  'timeout',
  'datasetNotReady',
  'runNotStarted',
  'remoteDown',
  'rateLimited',
]);

// ─── Database helpers ────────────────────────────────────────────────────────

const one = async (ctx: Context, sql: string, params: unknown[] = []) =>
  ctx.executor.transaction(async (tx) => (await tx.query(sql, params)).rows);

/** As the worker, with the job owner's claims (for ps_admin, which checks them). */
async function withClaims<T>(
  ctx: Context,
  identity: RequestIdentity,
  fn: (tx: SqlTx) => Promise<T>
): Promise<T> {
  return ctx.executor.transaction(async (tx) => {
    await tx.query(
      `select set_config('request.jwt.claims', $1, true), set_config('statement_timeout', '600s', true)`,
      [
        JSON.stringify({
          sub: identity.userId,
          email: identity.email,
          role: 'authenticated',
          aal: identity.aal,
        }),
      ]
    );
    return fn(tx);
  });
}

async function identityOf(ctx: Context, job: Job): Promise<RequestIdentity> {
  if (!job.as_user) throw new TerminalError('noUser');
  const [who] = await one(ctx, 'select * from ps_worker.identity($1)', [job.as_user]);
  if (!who) throw new TerminalError('noUser');
  if (!who.active) throw new TerminalError('accountDisabled');
  return { userId: who.user_id, email: who.email, aal: job.as_aal };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

type Beat = () => Promise<boolean>;
type Handler = (ctx: Context, job: Job, beat: Beat) => Promise<Record<string, unknown> | void>;

async function getImport(ctx: Context, id: unknown): Promise<ImportRecord> {
  const [row] = await one(ctx, 'select ps_worker.import_get($1) as r', [id]);
  if (!row?.r) throw new TerminalError('notFound');
  return row.r as ImportRecord;
}

const HANDLERS: Record<string, Handler> = {
  async 'dataset.provision'(ctx, job) {
    const identity = await identityOf(ctx, job);
    await withClaims(ctx, identity, (tx) =>
      tx.query('select ps_admin.provision_dataset($1)', [job.payload.dataset_id])
    );
  },
  async 'dataset.alter'(ctx, job) {
    const identity = await identityOf(ctx, job);
    await withClaims(ctx, identity, (tx) =>
      tx.query('select ps_admin.alter_dataset($1)', [job.payload.dataset_id])
    );
  },
  async 'dataset.purge'(ctx, job) {
    const [r] = await one(ctx, 'select ps_admin.purge_dataset($1) as done', [
      job.payload.dataset_id,
    ]);
    return { purged: r.done === true };
  },

  async 'import.analyze'(ctx, job, beat) {
    const identity = await identityOf(ctx, job);
    const rec = await getImport(ctx, job.payload.import_id);
    if (rec.status !== 'analyzing') return { skipped: rec.status };
    // The user must still be allowed to import into this company.
    await asUser(ctx.executor, identity, '/terminal/import/analyze', async (tx) => {
      const { rows } = await tx.query(
        `select public.erp_has_permission($1, 'datasets.import') as ok`,
        [rec.workspace_id]
      );
      if (rows[0].ok !== true) throw new TerminalError('forbidden');
    });
    const { analysis, rowsTotal } = await analyzeImport(
      rec,
      readOptionsOf(job.payload.options),
      async () => {
        await beat();
      }
    );
    await one(ctx, 'select ps_worker.import_analyzed($1, $2::jsonb, $3)', [
      rec.id,
      JSON.stringify(analysis),
      rowsTotal,
    ]);
    return { rows: rowsTotal };
  },

  async 'import.commit'(ctx, job, beat) {
    const identity = await identityOf(ctx, job);
    const rec = await getImport(ctx, job.payload.import_id);
    if (rec.status !== 'committing') return { skipped: rec.status };
    await one(ctx, 'select ps_worker.import_restart($1)', [rec.id]);
    const result = await commitImport(ctx.executor, identity, rec, {
      beat: async () => {
        if (await beat()) throw new TerminalError('cancelled');
      },
      progress: async (ok, rejected, rejects) => {
        await one(ctx, 'select ps_worker.import_progress($1, $2, $3, $4::jsonb)', [
          rec.id,
          ok,
          rejected,
          JSON.stringify(rejects),
        ]);
      },
    });
    await one(ctx, `select ps_worker.import_finished($1, 'committed', null)`, [rec.id]);
    return result;
  },

  async 'pipeline.run'(ctx, job, beat) {
    const identity = await identityOf(ctx, job);
    const [pipeline] = await one(ctx, 'select * from ps_worker.pipeline_for_run($1)', [
      job.payload.pipeline_id,
    ]);
    if (!pipeline) throw new TerminalError('notFound');
    if (!pipeline.enabled) return { skipped: 'disabled' };
    let result;
    try {
      result = await runPipelineJob(ctx.executor, identity, job as PipelineJob, pipeline, { beat });
    } finally {
      // A run left open by an error is closed; a finished one is untouched.
      await one(ctx, `select ps_worker.close_pipeline_run($1, 'failed')`, [job.id]).catch(
        () => undefined
      );
    }
    if (job.trigger === 'schedule')
      await one(ctx, 'select ps_worker.schedule_result($1, $2)', [
        pipeline.pipeline_id,
        result.status === 'success',
      ]);
    if (result.status === 'success') {
      // Chains: pipelines that run after this one, each as the user who linked it.
      const next = await one(ctx, 'select * from ps_worker.downstream($1)', [pipeline.pipeline_id]);
      for (const t of next)
        await one(
          ctx,
          `select ps_worker.enqueue($1, 'pipeline.run', $2::jsonb, $3, $4, 'chain', $5)`,
          [
            t.workspace_id,
            JSON.stringify({ pipeline_id: t.downstream_id, after_job: job.id }),
            t.run_as,
            t.run_as_aal,
            `chain-${job.id}-${t.downstream_id}`.slice(0, 100),
          ]
        );
    }
    if (result.status === 'failed') throw new TerminalError(result.errorCode ?? 'runFailed');
    if (result.status === 'cancelled') throw new TerminalError('cancelled');
    return { run_id: result.runId, rows: result.rows, written: result.written };
  },

  async 'maintenance.purge'(ctx) {
    await one(ctx, 'select etna_platform.purge_by_retention()');
    const [r] = await one(ctx, 'select ps_admin.purge_removed_rows() as n');
    // Uploaded files of finished imports (30 days) and cancelled ones.
    let files = 0;
    for (const f of await one(ctx, 'select * from ps_worker.import_files_to_remove(500)')) {
      await fs.rm(
        importFilePath({
          workspace_id: f.workspace_id,
          storage_dir: f.storage_dir,
          storage_key: f.storage_key,
        }),
        { force: true }
      );
      await one(ctx, 'select ps_worker.import_file_removed($1)', [f.import_id]);
      files += 1;
    }
    return { removedRows: Number(r.n), removedFiles: files };
  },
  async 'maintenance.partitions'(ctx) {
    await one(ctx, 'select etna_platform.ensure_data_access_partitions(3)');
  },
  async 'maintenance.storage'(ctx) {
    await one(ctx, 'select ps_worker.refresh_dataset_sizes()');
    const datasets = new Map(
      (await one(ctx, 'select * from ps_admin.measure_datasets()')).map((r: any) => [
        r.workspace_id,
        Number(r.bytes),
      ])
    );
    const erp = new Map(
      (await one(ctx, 'select * from etna_platform.measure_erp_estimate()')).map((r: any) => [
        r.workspace_id,
        Number(r.bytes),
      ])
    );
    let measured = 0;
    for (const w of await one(ctx, 'select * from ps_worker.workspaces()')) {
      let files = 0;
      for (const kind of ['documents', 'imports', 'artifacts', 'tmp'] as const)
        files += await folderBytes(companyFolder(w.workspace_id, w.storage_dir, kind));
      await one(ctx, 'select etna_platform.record_storage_measure($1, $2, $3, $4)', [
        w.workspace_id,
        datasets.get(w.workspace_id) ?? 0,
        files,
        erp.get(w.workspace_id) ?? 0,
      ]);
      measured += 1;
    }
    return { measured };
  },
  // The Owner's export of a company being terminated (20261012000040): every
  // ERP list and dataset into one gzip JSON file in the company's artifacts folder.
  async 'connector.test'(ctx, job, beat) {
    return testConnection(await connectorEnv(ctx, job, beat), job.payload);
  },
  async 'connector.oauth'(ctx, job, beat) {
    return finishOauth(await connectorEnv(ctx, job, beat), job.payload);
  },
  async 'connector.describe'(ctx, job, beat) {
    return describe(await connectorEnv(ctx, job, beat), job.payload);
  },
  async 'connector.sync'(ctx, job, beat) {
    return runSync(await connectorEnv(ctx, job, beat), job.payload, job.id);
  },
  async 'ai.test'(ctx, job, beat) {
    return testProvider(await aiEnv(ctx, job, beat), job.payload);
  },
  async 'ai.analyze'(ctx, job, beat) {
    return runAnalysis(await aiEnv(ctx, job, beat), job.payload);
  },
  async 'sql.datasets'(ctx, job, beat) {
    return runSqlJob(await connectorEnv(ctx, job, beat), job);
  },
  async 'sql.connection'(ctx, job, beat) {
    return runSqlJob(await connectorEnv(ctx, job, beat), job);
  },

  async 'workspace.export'(ctx, job, beat) {
    const [row] = await one(ctx, 'select ps_worker.export_get($1) as e', [job.payload.export_id]);
    const e = row?.e;
    if (!e) throw new TerminalError('notFound');
    if (e.status !== 'preparing') return { skipped: e.status };
    if (!e.window_open) throw new TerminalError('exportClosed');
    const dir = companyFolder(e.workspace_id, e.storage_dir, 'artifacts');
    const key = `company-export-${e.id}.json.gz`;
    const file = path.join(dir, key);
    await fs.mkdir(dir, { recursive: true });
    const gzip = createGzip();
    const out = createWriteStream(`${file}.part`);
    gzip.pipe(out);
    const write = async (text: string) => {
      if (!gzip.write(text)) await once(gzip, 'drain');
    };
    const PAGE = 2000;
    let rows = 0;
    try {
      await write(
        `{"format":"printstream-company-export","version":1,"company":${JSON.stringify(e.workspace_name)},"exported_at":${JSON.stringify(new Date().toISOString())},"tables":{`
      );
      const tables = await one(ctx, 'select table_name from ps_worker.export_tables()');
      for (const [i, { table_name: name }] of tables.entries()) {
        await write(`${i ? ',' : ''}${JSON.stringify(name)}:[`);
        for (let offset = 0, first = true; ; offset += PAGE) {
          const [{ page }] = await one(
            ctx,
            'select ps_worker.export_rows($1, $2, $3, $4) as page',
            [e.workspace_id, name, offset, PAGE]
          );
          for (const r of page as unknown[]) {
            await write(`${first ? '' : ','}${JSON.stringify(r)}`);
            first = false;
          }
          rows += page.length;
          await beat();
          if (page.length < PAGE) break;
        }
        await write(']');
      }
      await write('},"datasets":[');
      const [{ ds }] = await one(ctx, 'select ps_worker.export_datasets($1) as ds', [
        e.workspace_id,
      ]);
      for (const [i, d] of (ds as any[]).entries()) {
        const labels = new Map<string, string>(d.columns.map((c: any) => [c.physical, c.label]));
        await write(
          `${i ? ',' : ''}{"name":${JSON.stringify(d.name)},"folder":${JSON.stringify(d.folder)},"description":${JSON.stringify(d.description)},"columns":${JSON.stringify(d.columns.map((c: any) => ({ label: c.label, type: c.type, sensitive: c.sensitive, hidden: c.hidden })))},"rows":[`
        );
        for (let after = 0, first = true; ; ) {
          const [{ page }] = await one(
            ctx,
            'select ps_admin.export_dataset_rows($1, $2, $3) as page',
            [d.id, after, PAGE]
          );
          for (const r of page as Record<string, unknown>[]) {
            const named: Record<string, unknown> = {
              _loaded_at: r._loaded_at,
              _source: r._source_kind,
            };
            for (const [k, v] of Object.entries(r)) if (labels.has(k)) named[labels.get(k)!] = v;
            await write(`${first ? '' : ','}${JSON.stringify(named)}`);
            first = false;
            after = Number(r._id);
          }
          rows += page.length;
          await beat();
          if (page.length < PAGE) break;
        }
        await write(']}');
      }
      await write(']}');
      gzip.end();
      await once(out, 'finish');
      await fs.rename(`${file}.part`, file);
    } catch (error) {
      gzip.destroy();
      out.destroy();
      await fs.rm(`${file}.part`, { force: true }).catch(() => undefined);
      throw error;
    }
    const size = (await fs.stat(file)).size;
    await one(ctx, `select ps_worker.export_finished($1, 'ready', $2, $3, null)`, [
      e.id,
      key,
      size,
    ]);
    return { rows, bytes: size };
  },
  async 'maintenance.deletions'(ctx) {
    let deleted = 0;
    for (const { workspace_id } of await one(ctx, 'select * from ps_worker.pending_deletions()')) {
      const [dir] = await one(ctx, 'select ps_worker.company_dir($1) as d', [workspace_id]);
      // The company's files first (its own folder keeps its root: the server manager manages it).
      for (const kind of ['documents', 'imports', 'artifacts', 'tmp'] as const)
        await fs.rm(companyFolder(workspace_id, dir?.d ?? null, kind), {
          recursive: true,
          force: true,
        });
      if (!dir?.d)
        await fs
          .rm(path.dirname(companyFolder(workspace_id, null, 'imports')), {
            recursive: true,
            force: true,
          })
          .catch(() => undefined);
      await one(ctx, 'select etna_platform.run_workspace_deletion($1)', [workspace_id]);
      deleted += 1;
    }
    return { deleted };
  },
};

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(full);
    else if (e.isFile()) total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

// ─── One job ─────────────────────────────────────────────────────────────────

async function runJob(ctx: Context, job: Job): Promise<void> {
  const started = Date.now();
  let lost = false;
  let cancel = false;
  const beat: Beat = async () => {
    if (lost) throw new LeaseLost();
    try {
      const [r] = await one(ctx, 'select ps_worker.heartbeat($1, $2, null) as c', [
        job.id,
        ctx.workerId,
      ]);
      cancel = r.c === true;
    } catch (error) {
      if ((error as { hint?: string }).hint === 'lease_lost') {
        lost = true;
        throw new LeaseLost();
      }
      throw error;
    }
    return cancel;
  };
  const timer = setInterval(() => void beat().catch(() => undefined), 20_000);
  let status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded';
  let result: Record<string, unknown> | null = null;
  let errorKey: string | null = null;
  let retryable = false;
  try {
    const handler = HANDLERS[job.kind];
    if (!handler) throw new TerminalError('unknownJob');
    result = (await handler(ctx, job, beat)) ?? null;
  } catch (error) {
    if (error instanceof LeaseLost) {
      ctx.log(`job ${job.id} ${job.kind}: lease lost`);
      clearInterval(timer);
      return;
    }
    const e = terminalErrorOf(error);
    status = e.code === 'cancelled' ? 'cancelled' : 'failed';
    errorKey = e.code;
    // An ERP import is never repeated: rows it added would be added twice.
    retryable =
      RETRYABLE.has(e.code) && !(job.kind === 'import.commit' && e.code !== 'datasetNotReady');
    if (e.code === 'failed')
      ctx.log(
        `job ${job.id} ${job.kind}: ${(error as { code?: string })?.code ?? (error as Error)?.name ?? 'error'}`
      );
    // Messages can carry data: only on request, when looking into a problem.
    if (process.env.ETNA_WORKER_DEBUG === '1')
      ctx.log(`job ${job.id} detail: ${(error as Error)?.message}`);
  } finally {
    clearInterval(timer);
  }
  const [{ s: final }] = await one(
    ctx,
    'select ps_worker.finish($1, $2, $3, $4::jsonb, $5, null, $6) as s',
    [job.id, ctx.workerId, status, result ? JSON.stringify(result) : null, errorKey, retryable]
  );
  // Given up for good: what depended on the job is told.
  if (final === 'failed' || final === 'cancelled') await afterGivingUp(ctx, job, errorKey);
  ctx.log(
    `job ${job.id} ${job.kind} ${final}${errorKey ? ` (${errorKey})` : ''} in ${Date.now() - started} ms`
  );
}

async function afterGivingUp(ctx: Context, job: Job, errorKey: string | null) {
  const key = (errorKey ?? 'failed')
    .replace(/[^a-z_]/gi, '_')
    .toLowerCase()
    .slice(0, 40);
  if (job.kind === 'dataset.provision' || job.kind === 'dataset.alter')
    await one(ctx, 'select ps_worker.dataset_failed($1, $2)', [job.payload.dataset_id, key]).catch(
      () => undefined
    );
  if (job.kind === 'import.analyze' || job.kind === 'import.commit')
    await one(ctx, `select ps_worker.import_finished($1, 'failed', $2)`, [
      job.payload.import_id,
      key.replace(/_/g, '').length >= 2 ? key : 'failed',
    ]).catch(() => undefined);
  if (job.kind === 'pipeline.run')
    await one(ctx, 'select ps_worker.close_pipeline_run($1, $2)', [job.id, key]).catch(
      () => undefined
    );
  if (job.kind === 'workspace.export')
    await one(ctx, `select ps_worker.export_finished($1, 'failed', null, null, $2)`, [
      job.payload.export_id,
      key,
    ]).catch(() => undefined);
}

// ─── Schedules and maintenance ───────────────────────────────────────────────

async function connectorEnv(ctx: Context, job: Job, beat: Beat): Promise<ConnectorJobEnv> {
  return {
    db: (sql, params = []) => one(ctx, sql, params),
    executor: ctx.executor,
    identity: await identityOf(ctx, job),
    beat,
  };
}

async function aiEnv(ctx: Context, job: Job, beat: Beat): Promise<AiJobEnv> {
  return { ...(await connectorEnv(ctx, job, beat)), manual: job.trigger === 'manual' };
}

async function fireSchedules(ctx: Context): Promise<number> {
  return ctx.executor.transaction(async (tx) => {
    const { rows } = await tx.query('select * from ps_worker.due_schedules(50)');
    for (const s of rows) {
      const next = nextRun(
        { kind: s.kind as ScheduleKind, spec: s.spec, timezone: s.timezone },
        new Date()
      );
      const { rows: job } = await tx.query(
        `select ps_worker.enqueue($1, 'pipeline.run', $2::jsonb, $3, $4, 'schedule', $5) as id`,
        [
          s.workspace_id,
          JSON.stringify({ pipeline_id: s.pipeline_id, schedule_id: s.id }),
          s.run_as,
          s.run_as_aal,
          `sched-${s.id}-${new Date(s.next_run_at).toISOString()}`.slice(0, 100),
        ]
      );
      await tx.query('select ps_worker.schedule_fired($1, $2, $3)', [
        s.id,
        job[0].id,
        next ? next.toISOString() : null,
      ]);
    }
    // Connector syncs on a schedule, each as the person who scheduled it.
    const { rows: syncs } = await tx.query('select * from ps_worker.due_syncs(50)');
    for (const s of syncs) {
      const next = s.schedule_kind
        ? nextRun(
            {
              kind: s.schedule_kind as ScheduleKind,
              spec: s.schedule_spec ?? {},
              timezone: s.timezone,
            },
            new Date()
          )
        : null;
      await tx.query(
        `select ps_worker.enqueue($1, 'connector.sync', $2::jsonb, $3, $4, 'schedule', $5)`,
        [
          s.workspace_id,
          JSON.stringify({ sync_id: s.id }),
          s.run_as,
          s.run_as_aal,
          `sync-${s.id}-${new Date(s.next_run_at).toISOString()}`.slice(0, 100),
        ]
      );
      await tx.query('select ps_worker.sync_fired($1, $2)', [
        s.id,
        next ? next.toISOString() : null,
      ]);
    }
    return rows.length + syncs.length;
  });
}

const MAINTENANCE: [kind: string, everyHours: number][] = [
  ['maintenance.partitions', 24],
  ['maintenance.purge', 24],
  ['maintenance.deletions', 1],
  ['maintenance.storage', 6],
];

async function queueMaintenance(ctx: Context): Promise<void> {
  const now = new Date();
  for (const [kind, hours] of MAINTENANCE) {
    const slot = Math.floor(now.getTime() / (hours * 3_600_000));
    await one(ctx, `select ps_worker.enqueue(null, $1, '{}'::jsonb, null, 'aal1', 'system', $2)`, [
      kind,
      `${kind}-${slot}`,
    ]);
  }
}

// ─── The loop ────────────────────────────────────────────────────────────────

export async function runWorker(options: WorkerOptions): Promise<{ stop: () => Promise<void> }> {
  const log = options.log ?? ((line: string) => console.log(`[worker] ${line}`));
  const executor = poolExecutor(options.databaseUrl, {
    max: (options.concurrency ?? 2) * 2 + 2,
    application_name: 'etna-worker',
  });
  const ctx: Context = { executor, workerId: options.workerId, log };
  const concurrency = Math.min(Math.max(options.concurrency ?? 2, 1), 8);
  const running = new Set<Promise<void>>();
  let stopping = false;
  let wake: (() => void) | null = null;
  const poke = () => wake?.();

  // New jobs wake the loop at once (ps_enqueue_job notifies); polling covers the rest.
  const listener = new pg.Client({
    connectionString: options.databaseUrl,
    application_name: 'etna-worker-listen',
  });
  listener.on('notification', poke);
  listener.on('error', (e) => log(`listen: ${(e as { code?: string }).code ?? 'error'}`));
  await listener.connect();
  await listener.query('LISTEN ps_jobs');

  let lastTick = 0;
  const loop = (async () => {
    while (!stopping) {
      try {
        if (Date.now() - lastTick > 30_000) {
          lastTick = Date.now();
          await one(ctx, 'select ps_worker.heartbeat_worker($1, $2, $3)', [
            options.workerId,
            options.version,
            running.size,
          ]);
          await queueMaintenance(ctx);
          if (await fireSchedules(ctx)) continue;
        }
        while (!stopping && running.size < concurrency) {
          const [job] = await one(ctx, 'select * from ps_worker.claim($1, 1)', [options.workerId]);
          if (!job) break;
          const p: Promise<void> = runJob(ctx, job as Job)
            .catch((e) => log(`job ${job.id}: ${(e as { code?: string })?.code ?? 'error'}`))
            .finally(() => {
              running.delete(p);
              poke();
            });
          running.add(p);
        }
      } catch (error) {
        log(`loop: ${(error as { code?: string })?.code ?? (error as Error)?.message ?? 'error'}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 5000);
        wake = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
      });
    }
  })();

  return {
    async stop() {
      stopping = true;
      poke();
      await loop;
      // Running jobs get 30 seconds; after that their leases run out and another start picks them up.
      await Promise.race([
        Promise.allSettled([...running]),
        new Promise((r) => setTimeout(r, 30_000)),
      ]);
      await listener.end().catch(() => undefined);
      await (executor as Executor & { end(): Promise<void> }).end().catch(() => undefined);
    },
  };
}
