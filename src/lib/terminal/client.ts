// Terminal in the browser: calls to /api/terminal and the shapes they return.

import type { DatasetColumn, DatasetInfo, RowPage } from '@/server/terminal/datasets';
import type { ColumnType } from './tabular';

export type { DatasetColumn, DatasetInfo, RowPage } from '@/server/terminal/datasets';

export class TerminalApiError extends Error {
  readonly code: string;
  readonly vars?: Record<string, string | number>;

  constructor(code: string, vars?: Record<string, string | number>) {
    super(code);
    this.code = code;
    this.vars = vars;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const json = await res.json().catch(() => null);
  if (!json?.success)
    throw new TerminalApiError(
      String(json?.error ?? (res.status === 401 ? 'forbidden' : 'failed')),
      json?.vars
    );
  return json.data as T;
}

export async function terminalApi<T = unknown>(
  action: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch('/api/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  return parse<T>(res);
}

/** Uploads an import file (streamed by the server); reports progress 0..1. */
export function uploadImportFile(
  workspaceId: string,
  file: File,
  onProgress?: (share: number) => void
): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({ workspaceId, name: file.name });
    xhr.open('POST', `/api/terminal/upload?${q}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new TerminalApiError('network'));
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText);
        if (json?.success) resolve(json.data);
        else reject(new TerminalApiError(String(json?.error ?? 'failed'), json?.vars));
      } catch {
        reject(new TerminalApiError(xhr.status === 413 ? 'too_large' : 'failed'));
      }
    };
    xhr.send(file);
  });
}

/** Downloads a dataset as CSV (needs a two-factor session). */
export async function downloadDatasetCsv(id: string, fallbackName: string): Promise<void> {
  const res = await fetch('/api/terminal/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('text/csv')) {
    const json = await res.json().catch(() => null);
    throw new TerminalApiError(String(json?.error ?? 'failed'));
  }
  const blob = await res.blob();
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    `${fallbackName}.csv`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface ImportSummary {
  id: string;
  file_name: string;
  file_kind: 'csv' | 'xlsx';
  size_bytes: number;
  status:
    | 'uploaded'
    | 'analyzing'
    | 'analyzed'
    | 'committing'
    | 'committed'
    | 'failed'
    | 'cancelled';
  rows_total: number | null;
  rows_ok: number;
  rows_rejected: number;
  error_key: string | null;
  target_dataset_id: string | null;
  target_erp_entity: string | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface JobSummary {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'awaiting_approval';
  trigger: 'manual' | 'schedule' | 'chain' | 'system';
  attempts: number;
  error_key: string | null;
  result: Record<string, unknown> | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  pipeline_id: string | null;
  dataset_id: string | null;
  import_id: string | null;
  connection_id: string | null;
  provider_id: string | null;
  max_attempts: number;
  mine: boolean;
  cancelled_by: string | null;
  cancelled_by_email: string | null;
  retry_of: string | null;
}

/** What needs attention (src/server/terminal/service.ts, healthOf). */
export interface TerminalHealth {
  workerSeenAt: string | null;
  workerOnline: boolean;
  waitingJobs: number;
  runningJobs: number;
  last24h: { succeeded: number; failed: number; cancelled: number };
  failingPipelines: { id: string; name: string; at: string | null; errorCode: string | null }[];
  lateSchedules: { id: string; name: string; due: string | null }[];
  stoppedSchedules: { id: string; name: string; reason: string }[];
  failingSyncs: {
    id: string;
    object: string;
    connection: string;
    dataset: string | null;
    enabled: boolean;
    streak: number;
    errorKey: string | null;
    at: string | null;
  }[];
  staleDatasets: { id: string; name: string; updatedAt: string | null }[];
}

export interface McpToken {
  id: string;
  name: string;
  prefix: string;
  mine: boolean;
  owner: string | null;
  aal: string;
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  uses: number;
  revokedAt: string | null;
}

/** An app connected through OAuth (Claude's connectors and others). */
export interface McpApp {
  id: string;
  name: string;
  host: string | null;
  mine: boolean;
  owner: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface PipelineSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  access: 'workspace' | 'restricted';
  mine: boolean;
  published_version_id: string | null;
  updated_at: string;
  schedule_kind: 'interval' | 'daily' | 'weekly' | 'monthly' | 'cron' | null;
  schedule_spec: Record<string, unknown> | null;
  timezone: string | null;
  schedule_enabled: boolean | null;
  next_run_at: string | null;
  last_run_at: string | null;
  disabled_reason: string | null;
  last_run: { status: string; started_at: string; triggered_by: string } | null;
}

export interface Overview {
  datasets: DatasetInfo[];
  imports: ImportSummary[];
  jobs: JobSummary[];
  pipelines: PipelineSummary[];
  triggers: { id: string; upstream_id: string; downstream_id: string; enabled: boolean }[];
  permissions: string[];
  limits: {
    max_upload_bytes: number;
    xlsx_max_upload_bytes: number;
    available_bytes: number | null;
  } | null;
  aal: 'aal1' | 'aal2';
  health: TerminalHealth;
}

export interface DatasetDetail {
  dataset: DatasetInfo;
  page: RowPage;
  versions: { version: number; change: Record<string, unknown>; created_at: string }[];
  lineage: {
    from_kind: string;
    from_id: string;
    to_kind: string;
    to_id: string;
    via_kind: string;
    via_id: string | null;
    created_at: string;
  }[];
  grants: {
    grantee_kind: 'member' | 'role' | 'custom_role';
    grantee: string;
    permissions: string[];
  }[];
  can: {
    edit: boolean;
    import: boolean;
    schema: boolean;
    export: boolean;
    share: boolean;
    delete: boolean;
  };
}

export interface AnalyzedImport {
  import: ImportSummary & {
    analysis: {
      encoding?: string;
      delimiter?: string;
      sheets?: string[];
      sheet?: string;
      header: boolean;
      decimal: '.' | ',';
      columns: { name: string; type: ColumnType; empty: number; samples: string[] }[];
      preview: (string | null)[][];
      options?: Record<string, unknown>;
    } | null;
    mapping: Record<string, unknown> | null;
  };
  rejects: {
    row_number: number;
    reason: string;
    column_name: string | null;
    raw: Record<string, unknown> | null;
  }[];
}

export const has = (overview: Pick<Overview, 'permissions'> | null, permission: string) =>
  !!overview?.permissions.includes(permission);

export type { DatasetColumn as Column };
