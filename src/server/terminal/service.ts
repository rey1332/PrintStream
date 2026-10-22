// Terminal for the app's routes: what the screens ask for, each request one
// transaction as the signed-in user. The database checks every permission;
// this layer shapes requests and answers and keeps inputs bounded.

import { parseScope } from '@/lib/terminal/mcpScope';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { nextRun, scheduleProblem, type ScheduleKind } from '@/lib/terminal/schedule';
import { COLUMN_TYPES } from '@/lib/terminal/tabular';
import type { Executor, SqlTx } from '@/server/db/executor';
import { companyFolder } from '@/server/documents/storage';
import {
  listDatasets,
  loadDataset,
  readRows,
  writeBatch,
  shapeRow,
  visibleColumns,
} from './datasets';
import { TerminalError, asUser, isUuid, type RequestIdentity } from './session';

export interface TerminalContext {
  executor: Executor;
  identity: RequestIdentity;
}

const PATH = '/terminal';
const run = <T>(ctx: TerminalContext, fn: (tx: SqlTx) => Promise<T>, path = PATH) =>
  asUser(ctx.executor, ctx.identity, path, fn);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const uuid = (v: unknown) => {
  if (!isUuid(v)) throw new TerminalError('invalid');
  return v;
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

// ─── Overview ────────────────────────────────────────────────────────────────

export async function overview(ctx: TerminalContext, workspaceId: unknown) {
  const ws = uuid(workspaceId);
  return run(ctx, async (tx) => {
    const datasets = await listDatasets(tx, ws);
    const imports = (
      await tx.query(
        `SELECT id, file_name, file_kind, size_bytes, status, rows_total, rows_ok, rows_rejected, error_key,
                target_dataset_id, target_erp_entity, created_by, created_at, finished_at
           FROM public.ps_imports WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [ws]
      )
    ).rows;
    const jobs = (
      await tx.query(
        `SELECT j.id, j.kind, j.status, j.trigger, j.attempts, j.max_attempts, j.error_key, j.progress, j.result,
                j.created_by, j.created_by = auth.uid() AS mine, j.cancelled_by, cp.email AS cancelled_by_email,
                j.retry_of, j.created_at, j.started_at, j.finished_at,
                j.payload ->> 'pipeline_id' AS pipeline_id, j.payload ->> 'dataset_id' AS dataset_id,
                j.payload ->> 'import_id' AS import_id, j.payload ->> 'connection_id' AS connection_id,
                j.payload ->> 'provider_id' AS provider_id
           FROM public.ps_jobs j
           LEFT JOIN public.user_profiles cp ON cp.id = j.cancelled_by
          WHERE j.workspace_id = $1 ORDER BY j.created_at DESC LIMIT 200`,
        [ws]
      )
    ).rows;
    const pipelines = (
      await tx.query(
        `SELECT w.id, w.name, w.description, w.enabled, w.access, w.user_id = auth.uid() AS mine, w.published_version_id,
                w.updated_at, s.kind AS schedule_kind, s.spec AS schedule_spec, s.timezone, s.enabled AS schedule_enabled,
                s.next_run_at, s.last_run_at, s.disabled_reason,
                (SELECT jsonb_build_object('status', r.status, 'started_at', r.started_at, 'triggered_by', r.triggered_by)
                   FROM public.workflow_runs r WHERE r.workflow_id = w.id ORDER BY r.started_at DESC LIMIT 1) AS last_run
           FROM public.workflows w
           LEFT JOIN public.ps_schedules s ON s.pipeline_id = w.id
          WHERE w.workspace_id = $1
          ORDER BY lower(w.name)
          LIMIT 500`,
        [ws]
      )
    ).rows;
    const triggers = (
      await tx.query(
        'SELECT id, upstream_id, downstream_id, enabled FROM public.ps_triggers WHERE workspace_id = $1',
        [ws]
      )
    ).rows;
    const permissions: string[] =
      (await tx.query('SELECT public.erp_my_permissions($1) AS p', [ws])).rows[0]?.p ?? [];
    const limits =
      (await tx.query('SELECT public.erp_upload_limits($1) AS l', [ws])).rows[0]?.l ?? null;
    const aal = (await tx.query('SELECT public.erp_session_aal() AS a')).rows[0]?.a ?? 'aal1';
    const health = await healthOf(tx, ws);
    return {
      datasets,
      imports: imports.map((i: any) => ({
        ...i,
        size_bytes: Number(i.size_bytes),
        created_at: iso(i.created_at),
        finished_at: iso(i.finished_at),
      })),
      jobs: jobs.map((j: any) => ({
        ...j,
        created_at: iso(j.created_at),
        started_at: iso(j.started_at),
        finished_at: iso(j.finished_at),
      })),
      pipelines: pipelines.map((p: any) => ({
        ...p,
        updated_at: iso(p.updated_at),
        next_run_at: iso(p.next_run_at),
        last_run_at: iso(p.last_run_at),
      })),
      triggers,
      permissions,
      limits,
      aal,
      health,
    };
  });
}

// What needs attention (the overview's health cards). Everything is read as
// the member: what they cannot see is not counted.
export async function healthOf(tx: SqlTx, ws: string) {
  const all = async (sql: string, params: unknown[] = [ws]) => (await tx.query(sql, params)).rows;
  const [worker] = await all('SELECT public.ps_worker_last_seen() AS seen', []);
  const [queue] = await all(
    `SELECT count(*) FILTER (WHERE status = 'queued' AND run_after < now() - interval '2 minutes')::int AS waiting,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'succeeded' AND finished_at > now() - interval '24 hours')::int AS succeeded_24h,
            count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS failed_24h,
            count(*) FILTER (WHERE status = 'cancelled' AND finished_at > now() - interval '24 hours')::int AS cancelled_24h
       FROM public.ps_jobs WHERE workspace_id = $1`
  );
  const failingPipelines = await all(
    `SELECT w.id, w.name, r.started_at, r.error_code
       FROM public.workflows w
       JOIN LATERAL (SELECT x.status, x.started_at, x.error_code FROM public.workflow_runs x
                      WHERE x.workflow_id = w.id ORDER BY x.started_at DESC LIMIT 1) r ON true
      WHERE w.workspace_id = $1 AND w.enabled AND r.status = 'failed'
      ORDER BY r.started_at DESC LIMIT 20`
  );
  const schedules = await all(
    `SELECT w.id, w.name, s.next_run_at, s.disabled_reason, s.enabled
       FROM public.ps_schedules s JOIN public.workflows w ON w.id = s.pipeline_id
      WHERE s.workspace_id = $1
        AND ((s.enabled AND s.next_run_at < now() - interval '15 minutes')
             OR (NOT s.enabled AND s.disabled_reason IS NOT NULL))
      ORDER BY w.name LIMIT 20`
  );
  const failingSyncs = await all(
    `SELECT y.id, y.object, y.enabled, y.failure_streak, y.last_error_key, y.last_run_at,
            c.name AS connection, d.name AS dataset, y.dataset_id
       FROM public.ps_syncs y
       JOIN public.ps_connections c ON c.id = y.connection_id
       LEFT JOIN public.ps_datasets d ON d.id = y.dataset_id
      WHERE y.workspace_id = $1 AND (y.last_status = 'failed' OR (NOT y.enabled AND y.failure_streak > 0))
      ORDER BY y.last_run_at DESC NULLS LAST LIMIT 20`
  );
  // Datasets something keeps up to date (a sync, a pipeline) that have not changed in a week.
  const staleDatasets = await all(
    `SELECT d.id, d.name, d.updated_at
       FROM public.ps_datasets d
      WHERE d.workspace_id = $1 AND d.deleted_at IS NULL AND d.status = 'ready'
        AND d.updated_at < now() - interval '7 days'
        AND (EXISTS (SELECT 1 FROM public.ps_syncs y WHERE y.dataset_id = d.id AND y.enabled)
             OR EXISTS (SELECT 1 FROM public.ps_lineage_edges l
                         WHERE l.to_kind = 'dataset' AND l.to_id = d.id::text AND l.via_kind = 'pipeline'))
      ORDER BY d.updated_at LIMIT 20`
  );
  const seen = worker?.seen ? new Date(worker.seen) : null;
  return {
    workerSeenAt: seen ? seen.toISOString() : null,
    // The worker reports every 30 seconds while it runs.
    workerOnline: seen !== null && Date.now() - seen.getTime() < 2 * 60_000,
    waitingJobs: queue.waiting as number,
    runningJobs: queue.running as number,
    last24h: {
      succeeded: queue.succeeded_24h as number,
      failed: queue.failed_24h as number,
      cancelled: queue.cancelled_24h as number,
    },
    failingPipelines: failingPipelines.map((p: any) => ({
      id: p.id as string,
      name: p.name as string,
      at: iso(p.started_at),
      errorCode: p.error_code as string | null,
    })),
    lateSchedules: schedules
      .filter((x: any) => x.enabled)
      .map((x: any) => ({ id: x.id as string, name: x.name as string, due: iso(x.next_run_at) })),
    stoppedSchedules: schedules
      .filter((x: any) => !x.enabled)
      .map((x: any) => ({
        id: x.id as string,
        name: x.name as string,
        reason: x.disabled_reason as string,
      })),
    failingSyncs: failingSyncs.map((y: any) => ({
      id: y.id as string,
      object: y.object as string,
      connection: y.connection as string,
      dataset: y.dataset as string | null,
      datasetId: (y.dataset_id as string | null) ?? null,
      enabled: y.enabled as boolean,
      streak: y.failure_streak as number,
      errorKey: y.last_error_key as string | null,
      at: iso(y.last_run_at),
    })),
    staleDatasets: staleDatasets.map((d: any) => ({
      id: d.id as string,
      name: d.name as string,
      updatedAt: iso(d.updated_at),
    })),
  };
}

export type TerminalHealth = Awaited<ReturnType<typeof healthOf>>;

// ─── Datasets ────────────────────────────────────────────────────────────────

function columnsOf(value: unknown) {
  if (!Array.isArray(value) || value.length > 500) throw new TerminalError('invalid');
  return value.map((c: any) => {
    if (!COLUMN_TYPES.includes(c?.type)) throw new TerminalError('invalid');
    return {
      label: text(c.label, 120).trim(),
      type: c.type,
      key: c.key === true,
      sensitive: c.sensitive === true,
      required: c.required === true,
      description: text(c.description, 500),
      unit: text(c.unit, 30),
    };
  });
}

export async function createDataset(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  const access = body.access === 'restricted' ? 'restricted' : 'workspace';
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      'SELECT public.ps_create_dataset($1, $2, $3, $4, $5::jsonb, $6, $7) AS id',
      [
        ws,
        text(body.name, 120),
        text(body.folder, 120),
        text(body.description, 2000),
        JSON.stringify(columnsOf(body.columns ?? [])),
        access,
        typeof body.erpArea === 'string' && body.erpArea ? body.erpArea : null,
      ]
    );
    return { id: rows[0].id as string };
  });
}

export async function getDataset(ctx: TerminalContext, body: any) {
  return run(ctx, async (tx) => {
    const ds = await loadDataset(tx, body.id);
    const ready = ds.status === 'ready' || ds.status === 'altering';
    const page = ready
      ? await readRows(tx, ds, {
          limit: Math.min(Math.max(Number(body.limit) || 100, 1), 500),
          offset: Number(body.offset) || 0,
          sort: typeof body.sort === 'string' ? body.sort : undefined,
          desc: body.desc === true,
        })
      : { columns: visibleColumns(ds), rows: [], total: 0, unmasked: false };
    const versions = (
      await tx.query(
        'SELECT version, change, created_at FROM public.ps_dataset_versions WHERE dataset_id = $1 ORDER BY version DESC LIMIT 50',
        [ds.id]
      )
    ).rows.map((v: any) => ({ ...v, created_at: iso(v.created_at) }));
    const lineage = (
      await tx.query(
        `SELECT from_kind, from_id, to_kind, to_id, via_kind, via_id, created_at FROM public.ps_lineage_edges
          WHERE workspace_id = $1 AND ((to_kind = 'dataset' AND to_id = $2) OR (from_kind = 'dataset' AND from_id = $2))
          ORDER BY created_at DESC LIMIT 100`,
        [ds.workspaceId, ds.id]
      )
    ).rows.map((l: any) => ({ ...l, created_at: iso(l.created_at) }));
    const grants = (
      await tx.query(
        `SELECT grantee_kind, grantee, permissions FROM public.ps_item_grants WHERE item_kind = 'dataset' AND item_id = $1`,
        [ds.id]
      )
    ).rows;
    const can = async (op: string) =>
      (await tx.query('SELECT public.ps_can_access_dataset($1, $2) AS ok', [ds.id, op])).rows[0]
        .ok === true;
    return {
      dataset: ds,
      page,
      versions,
      lineage,
      grants,
      can: {
        edit: await can('edit'),
        import: await can('import'),
        schema: await can('schema'),
        export: await can('export'),
        share: await can('share'),
        delete: await can('delete'),
      },
    };
  });
}

export async function alterDataset(ctx: TerminalContext, body: any) {
  const c = body.changes ?? {};
  const changes: Record<string, unknown> = {};
  for (const k of ['name', 'folder', 'description'] as const)
    if (typeof c[k] === 'string') changes[k] = text(c[k], k === 'description' ? 2000 : 120);
  if (c.access === 'workspace' || c.access === 'restricted') changes.access = c.access;
  if ('erpArea' in c) changes.erp_area = typeof c.erpArea === 'string' ? c.erpArea : '';
  if (Array.isArray(c.columns))
    changes.columns = c.columns.slice(0, 500).map((x: any) => ({
      physical_name: text(x.physical, 8),
      ...(typeof x.label === 'string' ? { label: text(x.label, 120) } : {}),
      ...(typeof x.sensitive === 'boolean' ? { sensitive: x.sensitive } : {}),
      ...(typeof x.hidden === 'boolean' ? { hidden: x.hidden } : {}),
      ...(typeof x.description === 'string' ? { description: text(x.description, 500) } : {}),
      ...(typeof x.unit === 'string' ? { unit: text(x.unit, 30) } : {}),
    }));
  if (Array.isArray(c.add) && c.add.length) changes.add = columnsOf(c.add);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query('SELECT public.ps_alter_dataset($1, $2::jsonb) AS v', [
      uuid(body.id),
      JSON.stringify(changes),
    ]);
    return { version: rows[0].v as number };
  });
}

export async function deleteDataset(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_delete_dataset($1)', [uuid(body.id)]));
}

export async function setItemAccess(ctx: TerminalContext, body: any) {
  const kind = body.kind === 'pipeline' ? 'pipeline' : 'dataset';
  const grants = Array.isArray(body.grants)
    ? body.grants.slice(0, 200).map((g: any) => ({
        kind: ['member', 'role', 'custom_role'].includes(g?.kind) ? g.kind : 'member',
        grantee: text(g?.grantee, 64),
        permissions: Array.isArray(g?.permissions)
          ? g.permissions.filter((p: unknown) => typeof p === 'string').slice(0, 50)
          : [],
      }))
    : [];
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_set_item_access($1, $2, $3, $4::jsonb)', [
      kind,
      uuid(body.id),
      body.access === 'restricted' ? 'restricted' : 'workspace',
      JSON.stringify(grants),
    ])
  );
}

export async function editRows(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    if (body.op === 'delete') {
      const ids = Array.isArray(body.rowIds)
        ? body.rowIds.map(Number).filter(Number.isSafeInteger).slice(0, 1000)
        : [];
      const { rows } = await tx.query('SELECT public.ps_rows_delete($1, $2::bigint[]) AS n', [
        id,
        ids,
      ]);
      return { changed: Number(rows[0].n) };
    }
    const ds = await loadDataset(tx, id);
    const cols = visibleColumns(ds);
    const values = body.values && typeof body.values === 'object' ? body.values : {};
    if (body.op === 'add') {
      const shaped = shapeRow(cols, (c) => values[c.physical], '.');
      if (!('row' in shaped)) throw new TerminalError(shaped.reason, { column: shaped.column });
      return {
        changed: await writeBatch(
          tx,
          id,
          [shaped.row],
          'append',
          'manual',
          `manual:${ctx.identity.userId}`,
          'edit'
        ),
      };
    }
    if (body.op === 'update') {
      const only = cols.filter((c) => Object.hasOwn(values, c.physical));
      const shaped = shapeRow(
        only.map((c) => ({ ...c, required: false, key: false })),
        (c) => values[c.physical],
        '.'
      );
      if (!('row' in shaped)) throw new TerminalError(shaped.reason, { column: shaped.column });
      await tx.query('SELECT public.ps_row_update($1, $2, $3::jsonb)', [
        id,
        Number(body.rowId),
        JSON.stringify(shaped.row),
      ]);
      return { changed: 1 };
    }
    throw new TerminalError('invalid');
  });
}

/** All rows as CSV (two-factor sessions with 'datasets.export'); at most 1,000,000 rows. */
export async function exportDataset(
  ctx: TerminalContext,
  id: unknown
): Promise<{ name: string; csv: string }> {
  if (ctx.identity.aal !== 'aal2') throw new TerminalError('mfaRequired');
  return run(
    ctx,
    async (tx) => {
      const ds = await loadDataset(tx, id);
      if (
        (await tx.query(`SELECT public.ps_can_access_dataset($1, 'export') AS ok`, [ds.id])).rows[0]
          .ok !== true
      )
        throw new TerminalError('forbidden');
      const page = await readRows(tx, ds, { limit: 1_000_000, operation: 'export' });
      const cell = (v: unknown) => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        // Spreadsheet formulas never run from an export.
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const lines = [page.columns.map((c) => cell(c.label)).join(',')];
      for (const r of page.rows) lines.push(page.columns.map((c) => cell(r[c.physical])).join(','));
      return { name: ds.name, csv: '﻿' + lines.join('\r\n') + '\r\n' };
    },
    '/terminal/export'
  );
}

// ─── Imports ─────────────────────────────────────────────────────────────────

export async function getImport(ctx: TerminalContext, body: any) {
  return run(ctx, async (tx) => {
    const { rows } = await tx.query('SELECT * FROM public.ps_imports WHERE id = $1', [
      uuid(body.id),
    ]);
    if (!rows[0]) throw new TerminalError('notFound');
    const rejects = (
      await tx.query(
        'SELECT row_number, reason, column_name, raw FROM public.ps_import_rejects WHERE import_id = $1 ORDER BY row_number LIMIT 200',
        [rows[0].id]
      )
    ).rows;
    const i = rows[0];
    return {
      import: {
        ...i,
        size_bytes: Number(i.size_bytes),
        created_at: iso(i.created_at),
        finished_at: iso(i.finished_at),
        updated_at: iso(i.updated_at),
      },
      rejects,
    };
  });
}

export async function commitImport(ctx: TerminalContext, body: any) {
  const m = body.mapping ?? {};
  const mapping = {
    target: ['dataset', 'new_dataset', 'erp'].includes(m.target) ? m.target : null,
    mode: ['append', 'upsert', 'replace'].includes(m.mode) ? m.mode : 'append',
    name: text(m.name, 120),
    folder: text(m.folder, 120),
    dataset_id: isUuid(m.datasetId) ? m.datasetId : null,
    erp_entity: text(m.erpEntity, 30) || null,
    columns: Array.isArray(m.columns)
      ? m.columns.slice(0, 500).map((c: any) => ({
          source: text(c.source, 120),
          target: text(c.target, 60) || null,
          label: text(c.label, 120),
          type: COLUMN_TYPES.includes(c.type) ? c.type : 'text',
          key: c.key === true,
          sensitive: c.sensitive === true,
          skip: c.skip === true,
        }))
      : [],
  };
  return run(ctx, async (tx) => {
    const { rows } = await tx.query('SELECT public.ps_commit_import($1, $2::jsonb) AS job', [
      uuid(body.id),
      JSON.stringify(mapping),
    ]);
    return { jobId: rows[0].job as string };
  });
}

export async function reanalyzeImport(ctx: TerminalContext, body: any) {
  const o = body.options ?? {};
  const options = {
    ...(typeof o.sheet === 'string' ? { sheet: text(o.sheet, 100) } : {}),
    ...(typeof o.header === 'boolean' ? { header: o.header } : {}),
    ...([',', ';', '\t', '|'].includes(o.delimiter) ? { delimiter: o.delimiter } : {}),
    ...(['utf-8', 'utf-16le', 'utf-16be', 'windows-1252'].includes(o.encoding)
      ? { encoding: o.encoding }
      : {}),
    ...(o.decimal === ',' || o.decimal === '.' ? { decimal: o.decimal } : {}),
  };
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_reanalyze_import($1, $2::jsonb)', [
      uuid(body.id),
      JSON.stringify(options),
    ])
  );
}

export async function cancelImport(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_cancel_import($1)', [uuid(body.id)]));
}

// ─── Jobs and pipelines ──────────────────────────────────────────────────────

export async function cancelJob(ctx: TerminalContext, body: any) {
  return run(ctx, async (tx) => ({
    status: (await tx.query('SELECT public.ps_cancel_job($1) AS s', [uuid(body.id)])).rows[0].s,
  }));
}

export async function retryJob(ctx: TerminalContext, body: any) {
  return run(ctx, async (tx) => ({
    jobId: (await tx.query('SELECT public.ps_retry_job($1) AS id', [uuid(body.id)])).rows[0]
      .id as string,
  }));
}

export async function runPipeline(ctx: TerminalContext, body: any) {
  const id = uuid(body.pipelineId);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query('SELECT workspace_id FROM public.workflows WHERE id = $1', [
      id,
    ]);
    if (!rows[0]?.workspace_id) throw new TerminalError('notFound');
    const job = await tx.query(
      `SELECT public.ps_enqueue_job($1, 'pipeline.run', $2::jsonb) AS id`,
      [
        rows[0].workspace_id,
        JSON.stringify({
          pipeline_id: id,
          ...(isUuid(body.versionId) ? { version_id: body.versionId } : {}),
        }),
      ]
    );
    return { jobId: job.rows[0].id as string };
  });
}

export async function saveSchedule(ctx: TerminalContext, body: any) {
  const kind = String(body.kind) as ScheduleKind;
  const schedule = {
    kind,
    spec: body.spec && typeof body.spec === 'object' ? body.spec : {},
    timezone: text(body.timezone, 64) || 'Asia/Jakarta',
  };
  const problem = scheduleProblem(schedule);
  if (problem) throw new TerminalError('schedule', { problem });
  const next = nextRun(schedule);
  if (!next) throw new TerminalError('schedule', { problem: 'never' });
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_save_schedule($1, $2, $3::jsonb, $4, $5, $6)', [
      uuid(body.pipelineId),
      kind,
      JSON.stringify(schedule.spec),
      schedule.timezone,
      next.toISOString(),
      body.enabled !== false,
    ])
  );
  return { nextRunAt: next.toISOString() };
}

export async function deleteSchedule(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_delete_schedule($1)', [uuid(body.pipelineId)]));
}

export async function saveChain(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_save_trigger($1, $2, true)', [
      uuid(body.upstreamId),
      uuid(body.downstreamId),
    ])
  );
}

export async function deleteChain(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_delete_trigger($1)', [uuid(body.id)]));
}

export async function setPipelineEnabled(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_set_pipeline_enabled($1, $2)', [
      uuid(body.pipelineId),
      body.enabled === true,
    ])
  );
}

// ─── Uploads ─────────────────────────────────────────────────────────────────

// Characters Windows refuses in file names, and control characters.
const UNSAFE_NAME = new RegExp(
  '[\\\\/:*?"<>|' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']',
  'g'
);

/**
 * New uploads: CSV files only (.csv). Excel files imported earlier stay
 * readable (their analysis can still be run again).
 */
export function importKindOf(fileName: string): 'csv' | null {
  return fileName.toLowerCase().endsWith('.csv') ? 'csv' : null;
}

/**
 * Stores an uploaded file in the company's imports folder and starts its
 * analysis. Room is reserved against the storage quota first; the body is
 * streamed to disk and never held in memory.
 */
export async function uploadImport(
  ctx: TerminalContext,
  input: {
    workspaceId: unknown;
    fileName: string;
    length: number;
    body: ReadableStream<Uint8Array>;
  }
): Promise<{ id: string }> {
  const ws = uuid(input.workspaceId);
  const name = input.fileName.replace(UNSAFE_NAME, '_').trim().slice(0, 255);
  const kind = importKindOf(name);
  if (!name || !kind) throw new TerminalError('fileType');
  if (!Number.isSafeInteger(input.length) || input.length <= 0) throw new TerminalError('empty');

  const prepared = await run(
    ctx,
    async (tx) => {
      const { rows: allowed } = await tx.query(
        `SELECT public.erp_has_permission($1, 'datasets.import') AS ok`,
        [ws]
      );
      if (allowed[0].ok !== true) throw new TerminalError('forbidden');
      const limits = (await tx.query('SELECT public.erp_upload_limits($1) AS l', [ws])).rows[0].l;
      const max = Number(limits.max_upload_bytes);
      if (input.length > max) throw new TerminalError('too_large', { max });
      const { rows: r } = await tx.query(
        `SELECT public.erp_reserve_storage($1, $2, 'import', 'file') AS id`,
        [ws, input.length]
      );
      const dir =
        (await tx.query('SELECT public.erp_workspace_storage_dir($1) AS d', [ws])).rows[0].d ??
        null;
      const id = (await tx.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
      return { reservation: r[0].id as string, dir, id };
    },
    '/terminal/upload'
  );

  const folder = companyFolder(ws, prepared.dir, 'imports');
  const final = path.join(folder, `${prepared.id}.${kind}`);
  const part = `${final}.part`;
  let written = 0;
  try {
    await fs.mkdir(folder, { recursive: true });
    const out = createWriteStream(part, { flags: 'wx' });
    const reader = input.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        // Never more than was announced (and reserved).
        if (written > input.length) throw new TerminalError('too_large');
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        out.end((e?: Error | null) => (e ? reject(e) : resolve()))
      );
    }
    if (written === 0) throw new TerminalError('empty');
    await fs.rename(part, final);
    await run(
      ctx,
      async (tx) => {
        await tx.query('SELECT public.ps_create_import($1, $2, $3, $4, $5)', [
          ws,
          prepared.id,
          name,
          kind,
          written,
        ]);
        await tx.query('SELECT public.erp_release_storage($1, $2)', [
          prepared.reservation,
          written,
        ]);
      },
      '/terminal/upload'
    );
    return { id: prepared.id };
  } catch (error) {
    await fs.rm(part, { force: true }).catch(() => undefined);
    await fs.rm(final, { force: true }).catch(() => undefined);
    await run(ctx, (tx) =>
      tx.query('SELECT public.erp_release_storage($1, 0)', [prepared.reservation])
    ).catch(() => undefined);
    throw error;
  }
}

// ─── Pipeline code (JavaScript steps, 20261012000061) ───────────────────────

export async function getPipelineCode(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT public.ps_pipeline_code_enabled($1) AS enabled,
              public.erp_has_permission($1, 'pipelines.code') AS can_write`,
      [ws]
    );
    return { enabled: rows[0]?.enabled === true, canWrite: rows[0]?.can_write === true };
  });
}

export async function setPipelineCode(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_set_pipeline_code($1, $2)', [ws, body.enabled === true])
  );
}

// ─── MCP access tokens ───────────────────────────────────────────────────────
// The token is made here and shown once; the database keeps its SHA-256.

/** A scope from the access page, as JSON for the database (which checks it); null = all. */
function scopeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TerminalError('invalid');
  const json = JSON.stringify(value);
  if (json.length > 40_000) throw new TerminalError('invalid');
  return json;
}

export async function listMcpTokens(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) =>
    (await tx.query('SELECT * FROM public.ps_mcp_token_list_v3($1)', [ws])).rows.map((r: any) => ({
      id: r.id as string,
      name: r.name as string,
      prefix: r.token_prefix as string,
      mine: r.mine as boolean,
      owner: r.owner_email as string | null,
      aal: r.aal as string,
      createdAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
      lastUsedAt: iso(r.last_used_at),
      uses: Number(r.use_count),
      revokedAt: iso(r.revoked_at),
      canWrite: r.can_write === true,
      scope: parseScope(r.scope),
    }))
  );
}

export async function createMcpToken(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  const days = Math.floor(Number(body.days) || 90);
  const token = `psmcp_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const id = await run(
    ctx,
    async (tx) =>
      (
        await tx.query(
          'SELECT public.ps_mcp_token_create_v3($1, $2, $3, $4, $5, $6, $7::jsonb) AS id',
          [
            ws,
            text(body.name, 80),
            hash,
            token.slice(0, 12),
            days,
            body.canWrite === true,
            scopeJson(body.scope),
          ]
        )
      ).rows[0].id as string
  );
  return { id, token };
}

export async function setMcpTokenScope(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_mcp_token_set_scope($1, $2::jsonb)', [
      uuid(body.id),
      scopeJson(body.scope),
    ])
  );
}

export async function revokeMcpToken(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_mcp_token_revoke($1)', [uuid(body.id)]));
}

// ─── Connected apps (OAuth, db/migrations/20261012000056_mcp_oauth.sql) ──────

export async function listMcpApps(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) =>
    (await tx.query('SELECT * FROM public.ps_oauth_grant_list_v3($1)', [ws])).rows.map(
      (r: any) => ({
        id: r.id as string,
        name: r.client_name as string,
        host: r.redirect_host as string | null,
        mine: r.mine as boolean,
        owner: r.owner_email as string | null,
        createdAt: iso(r.created_at),
        lastUsedAt: iso(r.last_used_at),
        uses: Number(r.uses),
        expiresAt: iso(r.refresh_expires_at),
        revokedAt: iso(r.revoked_at),
        canWrite: r.can_write === true,
        scope: parseScope(r.scope),
      })
    )
  );
}

export async function setMcpAppScope(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_oauth_grant_set_scope($1, $2::jsonb)', [
      uuid(body.id),
      scopeJson(body.scope),
    ])
  );
}

export async function revokeMcpApp(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_oauth_grant_revoke($1)', [uuid(body.id)]));
}
