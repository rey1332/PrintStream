'use client';

import { createClient } from '@/lib/data/client';
import type { MessageKey } from '@/lib/i18n/messages';
import type { WorkspaceRole } from './erpRules';

export const SYNC_ENTITIES = [
  'customers',
  'suppliers',
  'products',
  'stock',
  'sales_orders',
  'purchase_orders',
  'invoices',
  'payments',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];
export type SyncDirection = 'push' | 'pull' | 'both';
export type SyncStatus = 'success' | 'partial' | 'failed';

export const DOCUMENT_ENTITIES: readonly SyncEntity[] = [
  'sales_orders',
  'purchase_orders',
  'invoices',
  'payments',
];

export interface SyncErp {
  id: string;
  name: string;
  role: WorkspaceRole | null;
  syncEnabled: boolean;
  canSync: boolean;
  baseCurrency: string;
  members: number;
  pendingInbox: number;
}

export interface SyncMessage {
  kind: 'ok' | 'skipped' | 'failed';
  item: string;
  message: string;
}

export interface SyncCounts {
  ok: number;
  skipped: number;
  failed: number;
  messages: SyncMessage[];
}

export interface SyncPair {
  source: string;
  target: string;
  entity: SyncEntity;
  lastSyncAt: string;
  lastStatus: SyncStatus;
  counts: Omit<SyncCounts, 'messages'>;
}

export interface SyncRun {
  id: string;
  source: string;
  targets: string[];
  direction: SyncDirection;
  entities: SyncEntity[];
  since: string | null;
  status: 'running' | SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string | null;
  result: Record<string, Partial<Record<SyncEntity, SyncCounts>>>;
}

export interface SyncOverview {
  erps: SyncErp[];
  pairs: SyncPair[];
  runs: SyncRun[];
}

export interface SyncProgress {
  done: number;
  total: number;
  target: string;
  entity: SyncEntity;
  counts?: SyncCounts;
}

export interface InboxItem {
  id: string;
  kind: 'invoice' | 'payment';
  sourceName: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'posted' | 'dismissed';
  postedId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string;
  createdAt: string;
}

export class SyncError extends Error {
  key: MessageKey;
  constructor(key: MessageKey) {
    super(key);
    this.key = key;
  }
}

const MESSAGES: [RegExp, MessageKey][] = [
  [/owner or admin of every ERP/, 'sync.err.notAllowed'],
  [/Only an owner or admin can change/, 'sync.err.notAllowed'],
  [/is not included in sync|no longer included in sync/, 'sync.err.disabled'],
  [/at least one other ERP/, 'sync.err.targets'],
  [/Choose what to sync/, 'sync.err.entities'],
  [/Post the invoice of this payment first/, 'sync.err.invoiceFirst'],
  [/Sync the purchase order of this payment first/, 'sync.err.orderFirst'],
  [/already handled/, 'sync.err.handled'],
  [/exchange rate|more than \d+ days/i, 'sync.err.fx'],
];

function fail(error: { code?: string; message?: string }): never {
  const found = MESSAGES.find(([pattern]) => pattern.test(error.message ?? ''));
  if (found) throw new SyncError(found[1]);
  if (error.code === '42501') throw new SyncError('sync.err.notAllowed');
  throw new SyncError('sync.err.failed');
}

async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().rpc(fn, args);
  if (error) fail(error);
  return data as T;
}

// Shapes the database functions return (snake_case JSON).
interface RawCounts {
  ok?: number;
  skipped?: number;
  failed?: number;
  messages?: SyncMessage[];
}

interface RawOverview {
  erps?: {
    id: string;
    name: string;
    role: WorkspaceRole | null;
    sync_enabled: boolean;
    can_sync: boolean;
    base_currency: string;
    members: number | string;
    pending_inbox: number | string;
  }[];
  pairs?: {
    source: string;
    target: string;
    entity: SyncEntity;
    last_sync_at: string;
    last_status: SyncStatus;
    counts: RawCounts;
  }[];
  runs?: {
    id: string;
    source: string;
    targets: string[] | null;
    direction: SyncDirection;
    entities: SyncEntity[] | null;
    since: string | null;
    status: SyncRun['status'];
    started_at: string;
    finished_at: string | null;
    started_by: string | null;
    result: Record<string, Record<string, RawCounts>> | null;
  }[];
}

interface RawInboxRow {
  id: string;
  kind: InboxItem['kind'];
  source_name: string | null;
  payload: Record<string, unknown> | null;
  status: InboxItem['status'];
  posted_id: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  note: string | null;
  created_at: string;
}

const counts = (c: RawCounts | null | undefined): SyncCounts => ({
  ok: Number(c?.ok ?? 0),
  skipped: Number(c?.skipped ?? 0),
  failed: Number(c?.failed ?? 0),
  messages: Array.isArray(c?.messages) ? c.messages : [],
});

export const syncService = {
  async overview(): Promise<SyncOverview> {
    const o = await call<RawOverview | null>('erp_sync_overview');
    return {
      erps: (o?.erps ?? []).map((e) => ({
        id: e.id,
        name: e.name,
        role: e.role ?? null,
        syncEnabled: e.sync_enabled === true,
        canSync: e.can_sync === true,
        baseCurrency: e.base_currency,
        members: Number(e.members ?? 0),
        pendingInbox: Number(e.pending_inbox ?? 0),
      })),
      pairs: (o?.pairs ?? []).map((p) => ({
        source: p.source,
        target: p.target,
        entity: p.entity,
        lastSyncAt: p.last_sync_at,
        lastStatus: p.last_status,
        counts: counts(p.counts),
      })),
      runs: (o?.runs ?? []).map((r) => ({
        id: r.id,
        source: r.source,
        targets: r.targets ?? [],
        direction: r.direction,
        entities: r.entities ?? [],
        since: r.since ?? null,
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at ?? null,
        startedBy: r.started_by ?? null,
        result: Object.fromEntries(
          Object.entries(r.result ?? {}).map(([target, byEntity]) => [
            target,
            Object.fromEntries(Object.entries(byEntity).map(([k, c]) => [k, counts(c)])),
          ])
        ),
      })),
    };
  },

  async setEnabled(workspaceId: string, enabled: boolean): Promise<void> {
    await call('erp_sync_set_enabled', { p_workspace_id: workspaceId, p_enabled: enabled });
  },

  async run(
    input: {
      source: string;
      targets: string[];
      direction: SyncDirection;
      entities: SyncEntity[];
      since: string | null;
    },
    onProgress: (progress: SyncProgress) => void
  ): Promise<{ status: SyncStatus; totals: Omit<SyncCounts, 'messages'> }> {
    const entities = SYNC_ENTITIES.filter((e) => input.entities.includes(e));
    const runId = await call<string>('erp_sync_start', {
      p_source: input.source,
      p_targets: input.targets,
      p_direction: input.direction,
      p_entities: entities,
      p_since: input.since,
    });
    const total = input.targets.length * entities.length;
    let done = 0;
    let failure: unknown = null;
    try {
      for (const target of input.targets) {
        for (const entity of entities) {
          onProgress({ done, total, target, entity });
          const result = counts(
            await call('erp_sync_step', { p_run_id: runId, p_target: target, p_entity: entity })
          );
          done += 1;
          onProgress({ done, total, target, entity, counts: result });
        }
      }
    } catch (error) {
      failure = error;
    }
    // Closes the run even after a failed step (its result says how far it got).
    const finished = await call<{ status?: SyncStatus; totals?: RawCounts } | null>(
      'erp_sync_finish',
      {
        p_run_id: runId,
      }
    ).catch(() => null);
    if (failure) throw failure;
    if (!finished?.status) throw new SyncError('sync.err.failed');
    return { status: finished.status, totals: counts(finished.totals) };
  },

  async inbox(workspaceId: string): Promise<InboxItem[]> {
    const rows = await call<RawInboxRow[] | null>('erp_sync_inbox_list', {
      p_workspace_id: workspaceId,
    });
    return (rows ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      sourceName: r.source_name ?? '',
      payload: r.payload ?? {},
      status: r.status,
      postedId: r.posted_id ?? null,
      decidedBy: r.decided_by_email ?? null,
      decidedAt: r.decided_at ?? null,
      note: r.note ?? '',
      createdAt: r.created_at,
    }));
  },

  async post(itemId: string, fxRate: number | null): Promise<string> {
    return call<string>('erp_sync_inbox_post', { p_item_id: itemId, p_fx_rate: fxRate });
  },

  async dismiss(itemId: string, reason: string): Promise<void> {
    await call('erp_sync_inbox_dismiss', { p_item_id: itemId, p_reason: reason });
  },
};
