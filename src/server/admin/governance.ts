// Platform governance in the admin panel: staff access sessions, retention
// bounds and legal holds, company termination, storage quotas and the
// data-access log. Every call goes through the etna_platform functions
// (20261012000032-34), which check the admin role, two-factor and, for
// changes, a fresh re-authentication, and write the security log.

import type { SessionInfo } from '@/server/auth/service';
import type { Executor } from '@/server/db/executor';
import { asAdmin, type RequestMeta } from './service';

type Ctx = { executor: Executor; session: SessionInfo; meta: RequestMeta };

const call = <T>(
  ctx: Ctx,
  path: string,
  sql: string,
  params: unknown[],
  pick: (rows: any[]) => T
) =>
  asAdmin(ctx.executor, ctx.session, path, ctx.meta, async (tx) =>
    pick((await tx.query(sql, params)).rows)
  );

// ─── Staff access ────────────────────────────────────────────────────────────

export interface StaffSession {
  id: string;
  admin_email: string | null;
  workspace_id: string;
  workspace_name: string | null;
  reason: string;
  ticket_ref: string;
  starts_at: string;
  ends_at: string;
  ended_at: string | null;
  live: boolean;
}

export const staffSessions = (ctx: Ctx, workspaceId: string | null) =>
  call<StaffSession[]>(
    ctx,
    '/admin/governance',
    'select * from etna_platform.admin_staff_access_sessions($1::uuid, 100)',
    [workspaceId],
    (rows) => rows
  );

export const startStaffAccess = (
  ctx: Ctx,
  workspaceId: string,
  input: { reason: string; ticket: string; hours: number }
) =>
  call<{
    session_id: string;
    ends_at: string;
    workspace_name: string;
    owner_email: string | null;
    admin_email: string | null;
  }>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_start_staff_access($1::uuid, $2, $3, $4::int) as r',
    [workspaceId, input.reason, input.ticket, input.hours],
    (rows) => rows[0].r
  );

export const endStaffAccess = (ctx: Ctx, sessionId: string) =>
  call<void>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_end_staff_access($1::uuid)',
    [sessionId],
    () => undefined
  );

// ─── Retention and legal holds ───────────────────────────────────────────────

export interface RetentionPolicy {
  log_type: string;
  min_days: number;
  max_days: number | null;
  default_days: number | null;
  updated_at: string;
}

export const retentionPolicies = (ctx: Ctx) =>
  call<RetentionPolicy[]>(
    ctx,
    '/admin/governance',
    'select * from etna_platform.admin_retention_policies()',
    [],
    (rows) => rows
  );

export const setRetentionPolicy = (
  ctx: Ctx,
  input: { logType: string; minDays: number; maxDays: number | null; defaultDays: number | null }
) =>
  call<void>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_set_retention_policy($1, $2::int, $3::int, $4::int)',
    [input.logType, input.minDays, input.maxDays, input.defaultDays],
    () => undefined
  );

export interface LegalHold {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  reason: string;
  set_by_email: string | null;
  set_at: string;
  until: string | null;
  released_at: string | null;
  release_reason: string | null;
}

export const legalHolds = (ctx: Ctx, workspaceId: string | null) =>
  call<LegalHold[]>(
    ctx,
    '/admin/governance',
    'select * from etna_platform.admin_legal_holds($1::uuid)',
    [workspaceId],
    (rows) => rows
  );

export const setLegalHold = (ctx: Ctx, workspaceId: string, reason: string, until: string | null) =>
  call<string>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_set_legal_hold($1::uuid, $2, $3::date) as id',
    [workspaceId, reason, until],
    (rows) => rows[0].id
  );

export const releaseLegalHold = (ctx: Ctx, holdId: string, reason: string) =>
  call<void>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_release_legal_hold($1::uuid, $2)',
    [holdId, reason],
    () => undefined
  );

// ─── Termination ─────────────────────────────────────────────────────────────

export const workspaceTermination = (ctx: Ctx, workspaceId: string) =>
  call<Record<string, unknown> | null>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_workspace_termination($1::uuid) as t',
    [workspaceId],
    (rows) => rows[0].t ?? null
  );

export const terminateWorkspace = (
  ctx: Ctx,
  workspaceId: string,
  reason: string,
  graceDays: number
) =>
  call<{ export_until: string; workspace_name: string; owner_email: string | null }>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_terminate_workspace($1::uuid, $2, $3::int) as r',
    [workspaceId, reason, graceDays],
    (rows) => rows[0].r
  );

export const cancelTermination = (ctx: Ctx, workspaceId: string, reason: string) =>
  call<void>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_cancel_termination($1::uuid, $2)',
    [workspaceId, reason],
    () => undefined
  );

export const confirmTermination = (ctx: Ctx, workspaceId: string, confirmName: string) =>
  call<void>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_confirm_termination($1::uuid, $2)',
    [workspaceId, confirmName],
    () => undefined
  );

// ─── Storage ─────────────────────────────────────────────────────────────────

export const workspaceStorage = (ctx: Ctx, workspaceId: string) =>
  call<Record<string, unknown>>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_workspace_storage($1::uuid) as s',
    [workspaceId],
    (rows) => rows[0].s
  );

export const setWorkspaceQuota = (
  ctx: Ctx,
  workspaceId: string,
  input: {
    quotaBytes: number | null;
    unlimited: boolean;
    maxUploadBytes: number | null;
    reason: string;
  }
) =>
  call<void>(
    ctx,
    '/admin/workspaces',
    'select etna_platform.admin_set_workspace_quota($1::uuid, $2::bigint, $3, $4::bigint, $5)',
    [workspaceId, input.quotaBytes, input.unlimited, input.maxUploadBytes, input.reason],
    () => undefined
  );

export const storageDefaults = (ctx: Ctx) =>
  call<{
    default_quota_bytes: number | null;
    default_max_upload_bytes: number;
    xlsx_max_upload_bytes: number;
  }>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_storage_defaults() as d',
    [],
    (rows) => rows[0].d
  );

export const connectorHosts = (ctx: Ctx) =>
  call<string[]>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_connector_private_hosts() as h',
    [],
    (rows) => rows[0].h ?? []
  );

export const setConnectorHosts = (ctx: Ctx, hosts: string[]) =>
  call<void>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_set_connector_private_hosts($1::text[])',
    [hosts],
    () => undefined
  );

// ─── Local AI endpoints (20261012000049) ─────────────────────────────────────

export const aiLocalEndpoints = (ctx: Ctx) =>
  call<string[]>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_ai_local_endpoints() as e',
    [],
    (rows) => rows[0].e ?? []
  );

export const setAiLocalEndpoints = (ctx: Ctx, endpoints: string[]) =>
  call<void>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_set_ai_local_endpoints($1::text[])',
    [endpoints],
    () => undefined
  );

// ─── Tunnels (20261012000046) ────────────────────────────────────────────────

export interface TunnelEntry {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  host: string;
  purpose: string;
  created_at: string;
}

export const tunnels = (ctx: Ctx) =>
  call<TunnelEntry[]>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_network_allowlist() as l',
    [],
    (rows) => rows[0].l ?? []
  );

export const addTunnel = (ctx: Ctx, workspaceId: string, host: string, purpose: string) =>
  call<string>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_add_network_allow($1, $2, $3) as id',
    [workspaceId, host, purpose],
    (rows) => rows[0].id
  );

export const removeTunnel = (ctx: Ctx, id: string) =>
  call<void>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_remove_network_allow($1)',
    [id],
    () => undefined
  );

export const setStorageDefaults = (
  ctx: Ctx,
  input: {
    defaultQuotaBytes: number | null;
    defaultMaxUploadBytes: number;
    xlsxMaxUploadBytes: number;
  }
) =>
  call<void>(
    ctx,
    '/admin/governance',
    'select etna_platform.admin_set_storage_defaults($1::bigint, $2::bigint, $3::bigint)',
    [input.defaultQuotaBytes, input.defaultMaxUploadBytes, input.xlsxMaxUploadBytes],
    () => undefined
  );

// ─── Data-access log ─────────────────────────────────────────────────────────

export interface AccessEntry {
  occurred_at: string;
  workspace_id: string | null;
  workspace_name: string | null;
  actor_email: string | null;
  actor_kind: string;
  object_kind: string;
  object_id: string | null;
  operation: string;
  rows: number | null;
  fields_unmasked: string[];
  ip: string | null;
}

export const dataAccessLog = (
  ctx: Ctx,
  filter: {
    workspaceId: string | null;
    actorId: string | null;
    actorKind: string | null;
    before: string | null;
    limit: number;
  }
) =>
  call<AccessEntry[]>(
    ctx,
    '/admin/access-log',
    'select * from etna_platform.admin_data_access_log($1::uuid, $2::uuid, $3::timestamptz, $4::int, $5)',
    [filter.workspaceId, filter.actorId, filter.before, filter.limit, filter.actorKind],
    (rows) => rows
  );
