import type { NextRequest } from 'next/server';
import { isSameOrigin } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import {
  addTunnel,
  aiLocalEndpoints,
  setAiLocalEndpoints,
  connectorHosts,
  legalHolds,
  setConnectorHosts,
  retentionPolicies,
  setRetentionPolicy,
  setStorageDefaults,
  staffSessions,
  storageDefaults,
  removeTunnel,
  tunnels,
} from '@/server/admin/governance';
import { readAdminBody, text } from '@/server/admin/body';
import {
  adminFailure,
  adminFromRequest,
  adminNotFound,
  adminReply,
  requestMeta,
} from '@/server/admin/request';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MB = 1024 ** 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GB = 1024 ** 3;

const days = (value: unknown): number | null | 'invalid' => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 36_500 ? n : 'invalid';
};

// Platform-wide: retention bounds, storage defaults, staff sessions, legal holds.
export async function GET(request: NextRequest) {
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const ctx = { executor: getAppExecutor(), session: admin.session, meta: requestMeta(request) };
  try {
    const [policies, defaults, sessions, holds, hosts, tunnelList, aiLocal] = await Promise.all([
      retentionPolicies(ctx),
      storageDefaults(ctx),
      staffSessions(ctx, null),
      legalHolds(ctx, null),
      connectorHosts(ctx),
      tunnels(ctx),
      aiLocalEndpoints(ctx),
    ]);
    return adminReply({
      success: true,
      data: { policies, defaults, sessions, holds, hosts, tunnels: tunnelList, aiLocal },
    });
  } catch (error) {
    return adminFailure(error);
  }
}

// { action: 'set_retention', logType, minDays, maxDays, defaultDays }
// | { action: 'set_storage_defaults', defaultQuotaGb, defaultMaxUploadMb, xlsxMaxUploadMb }
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return adminReply({ success: false, error: 'forbidden' }, 403);
  const admin = await adminFromRequest(request);
  if (!admin) return adminNotFound();
  const body = await readAdminBody(request);
  const ctx = { executor: getAppExecutor(), session: admin.session, meta: requestMeta(request) };
  try {
    if (body.action === 'set_retention') {
      const minDays = days(body.minDays);
      const maxDays = days(body.maxDays);
      const defaultDays = days(body.defaultDays);
      if (
        minDays === null ||
        minDays === 'invalid' ||
        maxDays === 'invalid' ||
        defaultDays === 'invalid'
      )
        return adminReply({ success: false, error: 'invalid' }, 400);
      await setRetentionPolicy(ctx, {
        logType: text(body.logType, 30),
        minDays,
        maxDays,
        defaultDays,
      });
      return adminReply({ success: true });
    }
    if (body.action === 'set_storage_defaults') {
      const quotaGb =
        body.defaultQuotaGb === '' || body.defaultQuotaGb == null
          ? null
          : Number(body.defaultQuotaGb);
      const uploadMb = Number(body.defaultMaxUploadMb);
      const xlsxMb = Number(body.xlsxMaxUploadMb);
      if (
        (quotaGb !== null && (!Number.isFinite(quotaGb) || quotaGb <= 0)) ||
        !Number.isInteger(uploadMb) ||
        !Number.isInteger(xlsxMb)
      )
        return adminReply({ success: false, error: 'invalid' }, 400);
      await setStorageDefaults(ctx, {
        defaultQuotaBytes: quotaGb === null ? null : Math.round(quotaGb * GB),
        defaultMaxUploadBytes: uploadMb * MB,
        xlsxMaxUploadBytes: xlsxMb * MB,
      });
      return adminReply({ success: true });
    }
    // Internal hosts and networks TERMINAL connectors may reach (one per line).
    if (body.action === 'set_connector_hosts') {
      const hosts = String(body.hosts ?? '')
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean);
      if (hosts.length > 50 || hosts.some((h) => !/^[A-Za-z0-9.:/_-]{1,255}$/.test(h)))
        return adminReply({ success: false, error: 'invalid' }, 400);
      await setConnectorHosts(ctx, hosts);
      return adminReply({ success: true });
    }
    // Local AI servers on ETNA's own machine (Ollama…), as host:port.
    if (body.action === 'set_ai_local_endpoints') {
      const endpoints = String(body.endpoints ?? '')
        .split(/[\s,]+/)
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      if (
        endpoints.length > 10 ||
        endpoints.some((h) => !/^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(h))
      )
        return adminReply({ success: false, error: 'invalid' }, 400);
      await setAiLocalEndpoints(ctx, endpoints);
      return adminReply({ success: true });
    }
    // One company's tunnel: the host:port it arrives at, for that company only.
    if (body.action === 'add_tunnel') {
      const workspaceId = text(body.workspaceId, 40);
      const host = text(body.host, 300).toLowerCase();
      const purpose = text(body.purpose, 200);
      if (!UUID_RE.test(workspaceId) || !host || !purpose)
        return adminReply({ success: false, error: 'invalid' }, 400);
      await addTunnel(ctx, workspaceId, host, purpose);
      return adminReply({ success: true });
    }
    if (body.action === 'remove_tunnel') {
      const id = text(body.id, 40);
      if (!UUID_RE.test(id)) return adminReply({ success: false, error: 'invalid' }, 400);
      await removeTunnel(ctx, id);
      return adminReply({ success: true });
    }
    return adminReply({ success: false, error: 'invalid' }, 400);
  } catch (error) {
    return adminFailure(error);
  }
}
