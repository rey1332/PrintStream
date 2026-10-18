// Browser client for the workflow API.

import type { Workflow, WorkflowGraph } from './types';
import type { NodeResultMap, NodeSummary, RunErrorCode, RunStatus } from './executor';
import type { EntityKey, FieldType } from '@/lib/analytics/catalog';
import type { GraphIssue } from './schema';
import type { QualityReport } from './runtime';
import { hasMessage } from '@/lib/i18n/labels';
import { tr } from '@/lib/i18n/translate';

const CODE_MESSAGES: Record<string, string> = {
  conflict: 'wf.ver.conflict',
  migrationRequired: 'wf.ver.migrationRequired',
  tooManyRuns: 'wf.run.tooMany',
  tooSoon: 'wf.auto.tooSoon',
  tooLarge: 'wf.issue.tooLarge',
  notPublished: 'wf.ver.notPublished',
  drillUnavailable: 'sum.drill.unavailable',
  invalidGroup: 'sum.drill.unavailable',
  forbidden: 'cat.err.forbidden',
  notMember: 'cat.err.notMember',
  queryFailed: 'cat.err.queryFailed',
  timeout: 'cat.err.queryFailed',
};

export class WorkflowApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function workflowApi<T>(
  path: string,
  method: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success) {
    const code = String(result?.error ?? '');
    const key = CODE_MESSAGES[code];
    const message =
      key && hasMessage(key)
        ? tr(key, { nodes: 100, edges: 300 })
        : code || tr('wf.err.request', { status: response.status });
    throw new WorkflowApiError(code, message);
  }
  return result.data as T;
}

const base = (id: string) => `/api/erp/workflows/${encodeURIComponent(id)}`;

export interface WorkflowSummary extends Workflow {
  canEdit: boolean;
  publishedVersion: number | null;
}

export interface WorkflowVersionInfo {
  id: string;
  version: number;
  note: string;
  created_at: string;
  byMe: boolean;
}

export interface WorkflowDetail extends Workflow {
  canEdit: boolean;
  versions: WorkflowVersionInfo[];
  published: { id: string; version: number; draftMatches: boolean } | null;
  versionsAvailable: boolean;
  /** Which MCP connection (an AI assistant) last wrote the draft, and when. */
  mcp_client?: string | null;
  mcp_edited_at?: string | null;
}

export interface RunResponse {
  runId: string;
  status: RunStatus | 'running';
  reused?: boolean;
  errorCode?: RunErrorCode | null;
  version?: number | null;
  issues?: GraphIssue[];
  quality?: QualityReport | null;
  results?: NodeResultMap;
  durationMs?: number;
}

export interface RunHistoryEntry {
  id: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  run_kind?: 'draft' | 'published' | 'version';
  version?: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  row_count?: number | null;
  quality?: Partial<QualityReport>;
  error_code?: string | null;
  error?: string | null;
  cancel_requested_at?: string | null;
  triggered_by?: string;
  node_results?: Record<string, NodeSummary>;
  byMe: boolean;
}

export interface DrillPage {
  entity: EntityKey;
  columns: { name: string; type: FieldType }[];
  rows: Record<string, unknown>[];
  offset: number;
  hasMore: boolean;
  fetchedAt: string;
}

export async function drillSummary(
  id: string,
  nodeId: string,
  group: Record<string, unknown>,
  offset: number,
  target: { target: 'draft' | 'published' | 'version'; versionId?: string } = { target: 'draft' }
) {
  return workflowApi<DrillPage>(`${base(id)}/drill`, 'POST', { nodeId, group, offset, ...target });
}

export async function listWorkflows(workspaceId?: string | null): Promise<WorkflowSummary[]> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  return (await workflowApi<WorkflowSummary[]>(`/api/erp/workflows${query}`, 'GET')) || [];
}

export async function getWorkflow(id: string): Promise<WorkflowDetail | null> {
  return workflowApi<WorkflowDetail | null>(base(id), 'GET');
}

export async function createWorkflow(name: string, workspaceId?: string | null): Promise<Workflow> {
  return workflowApi<Workflow>('/api/erp/workflows', 'POST', {
    name,
    workspaceId: workspaceId ?? null,
  });
}

export async function saveWorkflow(
  id: string,
  graph: WorkflowGraph,
  name: string,
  expectedUpdatedAt?: string
) {
  return workflowApi<{ updated_at: string }>(base(id), 'PATCH', { graph, name, expectedUpdatedAt });
}

export async function deleteWorkflow(id: string) {
  await workflowApi<void>(base(id), 'DELETE');
}

export async function duplicateWorkflow(id: string, name: string) {
  return workflowApi<{ id: string }>(`${base(id)}/duplicate`, 'POST', { name });
}

export async function saveVersion(id: string, note: string, publish: boolean) {
  return workflowApi<{ id: string; version: number }>(`${base(id)}/versions`, 'POST', {
    note,
    publish,
  });
}

export async function publishVersion(id: string, versionId: string) {
  await workflowApi<void>(`${base(id)}/versions`, 'POST', { action: 'publish', versionId });
}

export async function getVersion(id: string, versionId: string) {
  return workflowApi<{ id: string; version: number; name: string; graph: WorkflowGraph }>(
    `${base(id)}/versions?versionId=${encodeURIComponent(versionId)}`,
    'GET'
  );
}

export async function runWorkflow(
  id: string,
  target: { target: 'draft' | 'published' | 'version'; versionId?: string },
  requestId: string,
  signal?: AbortSignal,
  trigger: 'manual' | 'auto_refresh' = 'manual'
) {
  return workflowApi<RunResponse>(
    `${base(id)}/run`,
    'POST',
    { ...target, requestId, trigger },
    signal
  );
}

export async function listRuns(id: string, includeAuto = true) {
  return (
    (await workflowApi<RunHistoryEntry[]>(
      `${base(id)}/runs${includeAuto ? '' : '?auto=0'}`,
      'GET'
    )) || []
  );
}

export async function cancelRun(id: string, ref: { runId?: string; requestId?: string }) {
  return workflowApi<{ status: string }>(`${base(id)}/runs`, 'POST', { action: 'cancel', ...ref });
}
