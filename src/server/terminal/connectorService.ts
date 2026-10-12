// TERMINAL connections and syncs for the app's routes (20261012000041, 042, 046-048).
// Secrets typed into the form are sealed here (src/server/vault.ts) and go to
// the database only as ciphertext; they are never read back by the app.

import {
  CONNECTORS,
  OBJECT_COLUMNS,
  fieldShown,
  isConnectorKind,
  isObjectKey,
} from '@/lib/terminal/connectors';
import { datasetColumns, dbSourceLabel, parseDbSource } from '@/lib/terminal/dbSource';
import {
  headerLinesOk,
  isEndpointPath,
  parseRestSource,
  restSourceLabel,
} from '@/lib/terminal/restSource';
import { parseWebSource, webSourceLabel } from '@/lib/terminal/webSource';
import { mcpSourceLabel, parseMcpSource } from '@/lib/terminal/mcpSource';
import { nextRun, scheduleProblem, type ScheduleKind } from '@/lib/terminal/schedule';
import { sealJson } from '@/server/vault';
import type { SqlTx } from '@/server/db/executor';
import { TerminalError, asUser, isUuid } from './session';
import type { TerminalContext } from './service';

const run = <T>(ctx: TerminalContext, fn: (tx: SqlTx) => Promise<T>) =>
  asUser(ctx.executor, ctx.identity, '/terminal/connectors', fn);
const uuid = (v: unknown) => {
  if (!isUuid(v)) throw new TerminalError('invalid');
  return v;
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export async function listConnections(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) => {
    const connections = (
      await tx.query(
        `SELECT id, kind, name, config, status, last_tested_at, last_error_key, has_secret, created_at, updated_at
           FROM public.ps_connections WHERE workspace_id = $1 ORDER BY lower(name)`,
        [ws]
      )
    ).rows.map((c: any) => ({
      ...c,
      last_tested_at: iso(c.last_tested_at),
      created_at: iso(c.created_at),
      updated_at: iso(c.updated_at),
    }));
    const syncs = (
      await tx.query(
        `SELECT s.id, s.connection_id, s.object, s.dataset_id, d.name AS dataset_name, s.enabled, s.schedule_kind, s.schedule_spec,
                s.timezone, s.next_run_at, s.last_run_at, s.last_status, s.last_error_key, s.last_rows, s.last_removed,
                s.full_every_days, s.last_full_at, s.source, s.label
           FROM public.ps_syncs s LEFT JOIN public.ps_datasets d ON d.id = s.dataset_id
          WHERE s.workspace_id = $1 ORDER BY s.created_at`,
        [ws]
      )
    ).rows.map((s: any) => ({
      ...s,
      next_run_at: iso(s.next_run_at),
      last_run_at: iso(s.last_run_at),
      last_full_at: iso(s.last_full_at),
    }));
    return { connections, syncs };
  });
}

const URL_RE = /^https?:\/\/[^\s]{1,490}$/;
const FINGERPRINT_RE = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$|^\[?[0-9A-Fa-f:.]{2,45}\]?$/;
const PEM_RE = /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/;
const KEY_RE =
  /^-----BEGIN ([A-Z]+ )?PRIVATE KEY-----[\s\S]+-----END ([A-Z]+ )?PRIVATE KEY-----\s*$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

/** Field checks beyond required, URL and option (true when the value is wrong). */
function fieldProblem(key: string, v: string): boolean {
  if (key === 'tls_fingerprint') return !FINGERPRINT_RE.test(v);
  if (key === 'host') return v.length > 253 || !HOST_RE.test(v);
  if (key === 'port') return !/^\d{1,5}$/.test(v) || Number(v) < 1 || Number(v) > 65535;
  if (key === 'ca_pem' || key === 'client_cert_pem') return !PEM_RE.test(v);
  if (key === 'client_key_pem') return !KEY_RE.test(v);
  if (key === 'headers' || key === 'secret_headers' || key === 'hmac_headers')
    return !headerLinesOk(v);
  if (key === 'api_key_name') return !HEADER_NAME_RE.test(v);
  if (key === 'test_path') return !isEndpointPath(v);
  return false;
}

/**
 * Adds or changes a connection. Non-secret fields go to its settings; secret
 * fields, when any is typed, replace the sealed secret (all required ones
 * must then be given again).
 */
export async function saveConnection(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  const kind = body.kind;
  if (!isConnectorKind(kind)) throw new TerminalError('invalid');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) throw new TerminalError('invalid');
  const values = body.values && typeof body.values === 'object' ? body.values : {};
  const config: Record<string, string> = {};
  const secret: Record<string, string> = {};
  // Selects that decide which other fields apply (REST sign-in) start at their first option.
  const shownBy: Record<string, string> = {};
  for (const f of CONNECTORS[kind].fields)
    if (f.kind === 'select' && f.options)
      shownBy[f.key] =
        typeof values[f.key] === 'string' && values[f.key] ? values[f.key] : f.options[0];
  const fields = CONNECTORS[kind].fields.filter((f) => fieldShown(f, shownBy));
  for (const f of fields) {
    const v = typeof values[f.key] === 'string' ? values[f.key].trim() : '';
    if (f.kind === 'select' && !v && f.required && f.options) {
      config[f.key] = f.options[0];
      continue;
    }
    if (f.kind === 'secret') {
      if (v && fieldProblem(f.key, v)) throw new TerminalError('fieldInvalid', { field: f.key });
      if (v) secret[f.key] = v.slice(0, f.multiline ? 8000 : 4000);
      continue;
    }
    if (f.required && !v) throw new TerminalError('fieldRequired', { field: f.key });
    if (f.kind === 'url' && v && !URL_RE.test(v))
      throw new TerminalError('fieldInvalid', { field: f.key });
    if (f.kind === 'select' && v && !f.options?.includes(v))
      throw new TerminalError('fieldInvalid', { field: f.key });
    if (v && fieldProblem(f.key, v)) throw new TerminalError('fieldInvalid', { field: f.key });
    if (v.length > (f.max ?? 500)) throw new TerminalError('fieldInvalid', { field: f.key });
    if (v) config[f.key] = v;
  }
  if (kind === 'postgres' && config.ssl === 'verify-ca' && !config.ca_pem)
    throw new TerminalError('fieldRequired', { field: 'ca_pem' });
  const typedSecret = Object.keys(secret).length > 0;
  const isNew = !isUuid(body.id);
  // A client certificate needs its key (typed now, as secrets are given together).
  if (config.client_cert_pem && (isNew || typedSecret) && !secret.client_key_pem)
    throw new TerminalError('fieldRequired', { field: 'client_key_pem' });
  return run(ctx, async (tx) => {
    // Another way of signing in needs its secrets typed again.
    let signInChanged = false;
    if (!isNew && (kind === 'rest' || kind === 'mcp')) {
      const { rows } = await tx.query('SELECT config FROM public.ps_connections WHERE id = $1', [
        body.id,
      ]);
      signInChanged = rows[0]?.config?.auth !== config.auth;
    }
    if (isNew || typedSecret || signInChanged) {
      const missing = fields.find((f) => f.kind === 'secret' && f.required && !secret[f.key]);
      if (missing) throw new TerminalError('fieldRequired', { field: missing.key });
    }
    const { rows } = await tx.query(
      'SELECT public.ps_save_connection($1, $2, $3, $4, $5::jsonb, $6) AS id',
      [
        ws,
        isNew ? null : body.id,
        kind,
        name,
        JSON.stringify(config),
        typedSecret ? sealJson(secret) : null,
      ]
    );
    const id = rows[0].id as string;
    // Checked straight away by the worker (except what is authorised first).
    if (!CONNECTORS[kind].oauth && config.auth !== 'oauth2_code')
      await tx.query(`SELECT public.ps_enqueue_job($1, 'connector.test', $2::jsonb)`, [
        ws,
        JSON.stringify({ connection_id: id }),
      ]);
    return { id };
  });
}

/** Picks the database of an Accurate connection (from the list its test found). */
export async function setConnectionOption(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      'SELECT workspace_id, kind, name, config FROM public.ps_connections WHERE id = $1',
      [id]
    );
    const c = rows[0];
    if (!c) throw new TerminalError('notFound');
    if (
      c.kind !== 'accurate' ||
      typeof body.databaseId !== 'string' ||
      !/^\d{1,20}$/.test(body.databaseId)
    )
      throw new TerminalError('invalid');
    await tx.query('SELECT public.ps_save_connection($1, $2, $3, $4, $5::jsonb, null)', [
      c.workspace_id,
      id,
      c.kind,
      c.name,
      JSON.stringify({ ...c.config, database_id: body.databaseId }),
    ]);
    await tx.query(`SELECT public.ps_enqueue_job($1, 'connector.test', $2::jsonb)`, [
      c.workspace_id,
      JSON.stringify({ connection_id: id }),
    ]);
  });
}

export async function deleteConnection(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_delete_connection($1)', [uuid(body.id)]));
}

export async function testConnection(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      'SELECT workspace_id FROM public.ps_connections WHERE id = $1',
      [id]
    );
    if (!rows[0]) throw new TerminalError('notFound');
    const job = await tx.query(
      `SELECT public.ps_enqueue_job($1, 'connector.test', $2::jsonb) AS id`,
      [rows[0].workspace_id, JSON.stringify({ connection_id: id })]
    );
    return { jobId: job.rows[0].id as string };
  });
}

export async function createSync(ctx: TerminalContext, body: any) {
  const id = uuid(body.connectionId);
  if (!isObjectKey(body.object)) throw new TerminalError('invalid');
  const name = typeof body.datasetName === 'string' ? body.datasetName.trim().slice(0, 120) : '';
  if (!name) throw new TerminalError('invalid');
  return run(ctx, async (tx) => {
    const { rows } = await tx.query('SELECT kind FROM public.ps_connections WHERE id = $1', [id]);
    const kind: unknown = rows[0]?.kind;
    if (!isConnectorKind(kind) || !CONNECTORS[kind].objects.includes(body.object))
      throw new TerminalError('notFound');
    const sync = await tx.query('SELECT public.ps_create_sync($1, $2, $3, $4::jsonb) AS id', [
      id,
      body.object,
      name,
      JSON.stringify(OBJECT_COLUMNS[body.object as keyof typeof OBJECT_COLUMNS]),
    ]);
    return { id: sync.rows[0].id as string };
  });
}

/**
 * Asks the worker for a database connection's tables (no source), or the
 * columns of a table or query; for an API, its endpoints (from its OpenAPI
 * description) or one endpoint's columns and first rows. The answer is the
 * job's result (job.get).
 */
export async function describeConnection(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      'SELECT workspace_id, kind FROM public.ps_connections WHERE id = $1',
      [id]
    );
    const kind: unknown = rows[0]?.kind;
    if (
      !isConnectorKind(kind) ||
      !(
        CONNECTORS[kind].database ||
        CONNECTORS[kind].rest ||
        CONNECTORS[kind].web ||
        CONNECTORS[kind].mcp
      )
    )
      throw new TerminalError('notFound');
    const source =
      body.source == null
        ? null
        : CONNECTORS[kind].mcp
          ? parseMcpSource(body.source)
          : CONNECTORS[kind].web
            ? parseWebSource(body.source)
            : CONNECTORS[kind].rest
              ? parseRestSource(body.source)
              : parseDbSource(body.source);
    if ((body.source != null || CONNECTORS[kind].web) && !source)
      throw new TerminalError('invalid');
    const job = await tx.query(
      `SELECT public.ps_enqueue_job($1, 'connector.describe', $2::jsonb) AS id`,
      [rows[0].workspace_id, JSON.stringify({ connection_id: id, source })]
    );
    return { jobId: job.rows[0].id as string };
  });
}

/** A job the person started: its state and result (for answers like describe's). */
export async function getJob(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT status, result, error_key FROM public.ps_jobs WHERE id = $1 AND created_by = auth.uid()`,
      [id]
    );
    if (!rows[0]) throw new TerminalError('notFound');
    return rows[0] as { status: string; result: unknown; error_key: string | null };
  });
}

/** Revokes a REST API's OAuth tokens (at the provider too, when it can) and forgets them. */
export async function revokeConnection(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  if (ctx.identity.aal !== 'aal2') throw new TerminalError('mfaRequired');
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      'SELECT workspace_id, kind, config FROM public.ps_connections WHERE id = $1',
      [id]
    );
    const c = rows[0];
    if (!c || (c.kind !== 'rest' && c.kind !== 'mcp') || c.config?.auth !== 'oauth2_code')
      throw new TerminalError('notFound');
    const job = await tx.query(
      `SELECT public.ps_enqueue_job($1, 'connector.oauth', $2::jsonb) AS id`,
      [c.workspace_id, JSON.stringify({ connection_id: id, revoke: true })]
    );
    return { jobId: job.rows[0].id as string };
  });
}

/** A sync of a database's table or query, or an API endpoint, into a new dataset. */
export async function createSourceSync(ctx: TerminalContext, body: any) {
  const id = uuid(body.connectionId);
  const source =
    body.source?.mode === 'rest'
      ? parseRestSource(body.source)
      : body.source?.mode === 'web'
        ? parseWebSource(body.source)
        : body.source?.mode === 'mcp'
          ? parseMcpSource(body.source)
          : parseDbSource(body.source);
  if (!source) throw new TerminalError('invalid');
  const columns = datasetColumns(
    body.columns,
    source.key,
    source.mode === 'web' || source.mode === 'mcp' ? null : source.changed
  );
  if (!columns) throw new TerminalError('invalid');
  const name = typeof body.datasetName === 'string' ? body.datasetName.trim().slice(0, 120) : '';
  if (!name) throw new TerminalError('invalid');
  return run(ctx, async (tx) => {
    const sync = await tx.query(
      'SELECT public.ps_create_source_sync($1, $2::jsonb, $3, $4, $5::jsonb) AS id',
      [
        id,
        JSON.stringify(source),
        source.mode === 'rest'
          ? restSourceLabel(source)
          : source.mode === 'web'
            ? webSourceLabel(source)
            : source.mode === 'mcp'
              ? mcpSourceLabel(source)
              : dbSourceLabel(source),
        name,
        JSON.stringify(columns),
      ]
    );
    return { id: sync.rows[0].id as string };
  });
}

/** An MCP connection's tools as last listed, with whether each is approved as it is now. */
export async function listMcpTools(ctx: TerminalContext, body: any) {
  const id = uuid(body.connectionId);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT id, name, title, description, input_schema, read_only, seen_at,
              approved_hash IS NOT NULL AS was_approved, approved_hash = schema_hash AS approved, approved_at
         FROM public.ps_mcp_tools WHERE connection_id = $1 ORDER BY lower(name)`,
      [id]
    );
    return rows.map((r: any) => ({
      ...r,
      seen_at: iso(r.seen_at),
      approved_at: iso(r.approved_at),
    }));
  });
}

/** Approves a tool as it is now (or withdraws the approval): managers with two-factor. */
export async function approveMcpTool(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_approve_mcp_tool($1, $2)', [id, body.approve !== false])
  );
}

export async function runSyncNow(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query('SELECT workspace_id FROM public.ps_syncs WHERE id = $1', [id]);
    if (!rows[0]) throw new TerminalError('notFound');
    const job = await tx.query(
      `SELECT public.ps_enqueue_job($1, 'connector.sync', $2::jsonb) AS id`,
      [rows[0].workspace_id, JSON.stringify({ sync_id: id })]
    );
    return { jobId: job.rows[0].id as string };
  });
}

export async function scheduleSync(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  let kind: ScheduleKind | null = null;
  let spec: Record<string, unknown> | null = null;
  let next: Date | null = null;
  const timezone =
    typeof body.timezone === 'string' && body.timezone
      ? body.timezone.slice(0, 64)
      : 'Asia/Jakarta';
  if (body.kind) {
    kind = String(body.kind) as ScheduleKind;
    spec = body.spec && typeof body.spec === 'object' ? body.spec : {};
    const problem = scheduleProblem({ kind, spec: spec!, timezone });
    if (problem) throw new TerminalError('schedule', { problem });
    next = nextRun({ kind, spec: spec!, timezone });
  }
  const days = Number(body.fullEveryDays);
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_set_sync($1, $2, $3, $4::jsonb, $5, $6, $7)', [
      id,
      body.enabled !== false,
      kind,
      spec ? JSON.stringify(spec) : null,
      timezone,
      next ? next.toISOString() : null,
      Number.isInteger(days) && days >= 1 && days <= 90 ? days : null,
    ])
  );
  return { nextRunAt: next ? next.toISOString() : null };
}

export async function deleteSync(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_delete_sync($1)', [uuid(body.id)]));
}
