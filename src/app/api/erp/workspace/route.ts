import { NextResponse, type NextRequest } from 'next/server';
import { createRouteClient } from '@/server/db/route-client';
import { getAuthUserId } from '@/lib/api-safe';
import { clientIp, isSameOrigin } from '@/server/auth/request';
import { readLimitedText } from '@/server/http/body';
import { isPermission, isWellFormedAccessCode, isWorkspaceRole } from '@/app/erp/lib/erpRules';
import { MAX_ERPS_PER_ACCOUNT } from '@/lib/workspaces/limits';
import { linkTokenHash, newLinkToken } from '@/server/auth/service';
import { publicOrigin } from '@/server/admin/request';
import { mailConfigured, sendMail, workspaceInviteMail } from '@/server/mail/mailer';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INVALID_CODE = 'This access code is invalid, expired, or has already been used.';
const TOO_MANY = 'Too many attempts. Please wait 15 minutes and try again.';
const LIMIT_REACHED = `An account can belong to at most ${MAX_ERPS_PER_ACCOUNT} ERPs. Leave one before joining another.`;

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
    }
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' },
  });
}

function fail(status: number, error: string, code?: string) {
  return reply(status, code ? { success: false, error, code } : { success: false, error });
}

function rpcFailure(action: string, error: { code?: string; message?: string }) {
  // Log only the action and error code — never request bodies or codes.
  console.error('[workspace]', action, error.code || 'unknown');
  if (error.code === '42501' && /Two-factor/.test(error.message ?? ''))
    return fail(403, 'Confirm with two-factor first (Settings → Security).', 'mfa_required');
  if (error.code === '42501') return fail(403, 'You are not allowed to do that in this workspace.');
  if (error.code === '22023' && error.message) return fail(400, error.message);
  if (error.code === '23505') return fail(409, 'A role with this name already exists.');
  if (error.code === 'P0001' && error.message) return fail(400, error.message);
  if (error.code === 'PGRST202' || error.code === '42883') {
    return fail(503, 'Workspaces are not available on this database yet.');
  }
  return fail(500, 'The request could not be completed. Please try again.');
}

function str(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A role from the request: a built-in role (not Owner), or 'custom' with its id. */
function roleFrom(body: any): { role: string; customRoleId: string | null } | null {
  if (body?.role === 'custom') {
    const id = str(body?.customRoleId, 64);
    return UUID.test(id) ? { role: 'custom', customRoleId: id } : null;
  }
  return isWorkspaceRole(body?.role) && body.role !== 'owner'
    ? { role: body.role, customRoleId: null }
    : null;
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return fail(403, 'Cross-site request refused');
  const userId = await getAuthUserId(request);
  if (!userId) return fail(401, 'Please sign in first.');

  const body = await readLimitedText(request, 64 * 1024)
    .then((text) => JSON.parse(text || '{}'))
    .catch(() => ({}));
  const action = str(body?.action, 40);
  if (!allow(`ws:${userId}`, 60, 60_000)) return fail(429, TOO_MANY);

  const db = createRouteClient(request);
  const workspaceId = str(body?.workspaceId, 64);
  const needsWorkspace = [
    'create_invitation',
    'list_invitations',
    'list_members',
    'update_role',
    'remove_member',
    'audit',
    'invite_email',
    'list_roles',
    'save_role',
    'delete_role',
  ];
  if (needsWorkspace.includes(action) && !UUID.test(workspaceId))
    return fail(400, 'Choose a workspace first.');

  switch (action) {
    case 'redeem': {
      if (
        !allow(`redeem:${userId}`, 5, 15 * 60_000) ||
        !allow(`redeem-ip:${clientIp(request) ?? userId}`, 30, 15 * 60_000)
      ) {
        return fail(429, TOO_MANY);
      }
      const code = str(body?.code, 64);
      if (!isWellFormedAccessCode(code)) return fail(400, INVALID_CODE);
      const { data, error } = await db.rpc('erp_redeem_workspace_invitation', { p_code: code });
      if (error) return rpcFailure(action, error);
      if (data?.ok) {
        return reply(200, {
          success: true,
          data: {
            workspaceId: data.workspace_id,
            role: data.role,
            alreadyMember: !!data.already_member,
          },
        });
      }
      if (data?.error === 'workspace_limit') return fail(409, LIMIT_REACHED, 'workspace_limit');
      return data?.error === 'rate_limited' ? fail(429, TOO_MANY) : fail(400, INVALID_CODE);
    }

    case 'create_invitation': {
      if (!allow(`invite:${userId}`, 20, 60 * 60_000))
        return fail(429, 'Too many invitations created. Try again later.');
      const chosen = roleFrom(body);
      const hours = Number(body?.expiresInHours);
      if (!chosen) return fail(400, 'Choose a role for the invitation.');
      if (!Number.isInteger(hours) || hours < 1 || hours > 168)
        return fail(400, 'Choose how long the code stays valid.');
      const { data, error } = await db.rpc('erp_create_workspace_invitation_v2', {
        p_workspace_id: workspaceId,
        p_role: chosen.role,
        p_expires_in_hours: hours,
        p_label: str(body?.label, 120),
        p_custom_role_id: chosen.customRoleId,
      });
      if (error) return rpcFailure(action, error);
      const row = Array.isArray(data) ? data[0] : data;
      return reply(200, {
        success: true,
        data: {
          invitationId: row.invitation_id,
          accessCode: row.access_code,
          expiresAt: row.expires_at,
        },
      });
    }

    case 'invite_email': {
      if (!allow(`invite:${userId}`, 20, 60 * 60_000))
        return fail(429, 'Too many invitations created. Try again later.');
      const chosen = roleFrom(body);
      const hours = Number(body?.expiresInHours);
      const email = str(body?.email, 254).trim().toLowerCase();
      if (!chosen) return fail(400, 'Choose a role for the invitation.');
      if (!EMAIL.test(email)) return fail(400, 'Give a valid e-mail address.');
      if (!Number.isInteger(hours) || hours < 1 || hours > 168)
        return fail(400, 'Choose how long the code stays valid.');
      // Since 20261012000062 only existing accounts are invited (ETNA creates accounts), so
      // new_account is false; the token is kept for the function's signature.
      const token = newLinkToken();
      const { data, error } = await db.rpc('erp_invite_by_email', {
        p_workspace_id: workspaceId,
        p_email: email,
        p_role: chosen.role,
        p_custom_role_id: chosen.customRoleId,
        p_expires_in_hours: hours,
        p_token_hash: linkTokenHash(token),
      });
      if (error) return rpcFailure(action, error);
      const origin = publicOrigin(request);
      let emailed: 'sent' | 'failed' | 'off' = 'off';
      if (mailConfigured()) {
        const { data: ws } = await db
          .from('erp_workspaces')
          .select('name')
          .eq('id', workspaceId)
          .maybeSingle();
        const { data: me } = await db
          .from('user_profiles')
          .select('email, full_name')
          .eq('id', userId)
          .maybeSingle();
        const message = workspaceInviteMail({
          workspace: (ws as any)?.name ?? 'PrintStream',
          inviter: (me as any)?.full_name || (me as any)?.email || 'PrintStream',
          code: data.access_code,
          joinUrl: `${origin}/erp#join=${encodeURIComponent(data.access_code)}`,
          expiresAt: data.expires_at,
          passwordUrl: data.new_account ? `${origin}/reset-password#token=${token}` : undefined,
          passwordExpiresAt: data.link_expires_at,
        });
        const sent = await sendMail({ to: email, ...message });
        emailed = sent.ok ? 'sent' : 'failed';
        await db.rpc('erp_invitation_mail_result', {
          p_invitation_id: data.invitation_id,
          p_sent: sent.ok,
        });
      }
      return reply(200, {
        success: true,
        data: {
          invitationId: data.invitation_id,
          accessCode: data.access_code,
          expiresAt: data.expires_at,
          newAccount: !!data.new_account,
          // Without e-mail the admin passes the code (and the password link) on.
          passwordLink:
            data.new_account && emailed !== 'sent'
              ? `${origin}/reset-password#token=${token}`
              : null,
          emailed,
        },
      });
    }

    case 'list_roles': {
      const { data, error } = await db.rpc('erp_list_custom_roles', {
        p_workspace_id: workspaceId,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true, data: data || [] });
    }

    case 'save_role': {
      const roleId = str(body?.roleId, 64);
      const name = str(body?.name, 60).trim();
      const permissions = Array.isArray(body?.permissions) ? body.permissions : [];
      if (roleId && !UUID.test(roleId)) return fail(400, 'Role not found.');
      if (!name) return fail(400, 'Give the role a name.');
      if (permissions.length > 64 || !permissions.every(isPermission))
        return fail(400, 'Unknown permission.');
      const { data, error } = await db.rpc('erp_save_custom_role', {
        p_workspace_id: workspaceId,
        p_role_id: roleId || null,
        p_name: name,
        p_description: str(body?.description, 300),
        p_permissions: permissions,
        p_requires_mfa: body?.requiresMfa !== false,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true, data: { id: data } });
    }

    case 'delete_role': {
      const roleId = str(body?.roleId, 64);
      if (!UUID.test(roleId)) return fail(400, 'Role not found.');
      const { error } = await db.rpc('erp_delete_custom_role', {
        p_workspace_id: workspaceId,
        p_role_id: roleId,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true });
    }

    case 'revoke_invitation': {
      const invitationId = str(body?.invitationId, 64);
      if (!UUID.test(invitationId)) return fail(400, 'Invitation not found.');
      const { error } = await db.rpc('erp_revoke_workspace_invitation', {
        p_invitation_id: invitationId,
        p_reason: str(body?.reason),
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true });
    }

    case 'list_invitations': {
      const { data, error } = await db.rpc('erp_list_workspace_invitations', {
        p_workspace_id: workspaceId,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true, data: data || [] });
    }

    case 'list_members': {
      const { data, error } = await db.rpc('erp_list_workspace_members_v2', {
        p_workspace_id: workspaceId,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true, data: data || [] });
    }

    case 'update_role': {
      const memberId = str(body?.userId, 64);
      const chosen = roleFrom(body);
      if (!UUID.test(memberId) || !chosen) return fail(400, 'Choose a member and a role.');
      const { error } = await db.rpc('erp_update_workspace_member_role_v2', {
        p_workspace_id: workspaceId,
        p_user_id: memberId,
        p_role: chosen.role,
        p_reason: str(body?.reason),
        p_custom_role_id: chosen.customRoleId,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true });
    }

    case 'remove_member': {
      const memberId = str(body?.userId, 64);
      if (!UUID.test(memberId)) return fail(400, 'Member not found.');
      const { error } = await db.rpc('erp_remove_workspace_member', {
        p_workspace_id: workspaceId,
        p_user_id: memberId,
        p_reason: str(body?.reason),
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true });
    }

    case 'audit': {
      const { data, error } = await db.rpc('erp_list_workspace_audit', {
        p_workspace_id: workspaceId,
        p_limit: 30,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true, data: data || [] });
    }

    case 'security': {
      const { data, error } = await db.rpc('erp_workspace_security', {
        p_workspace_id: workspaceId,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true, data: (Array.isArray(data) ? data[0] : data) ?? null });
    }

    case 'member_security': {
      const { data, error } = await db.rpc('erp_list_workspace_member_security', {
        p_workspace_id: workspaceId,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true, data: data || [] });
    }

    case 'set_require_mfa': {
      if (typeof body?.required !== 'boolean') return fail(400, 'Choose on or off.');
      const { error } = await db.rpc('erp_set_workspace_require_mfa', {
        p_workspace_id: workspaceId,
        p_required: body.required,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true });
    }

    case 'rename': {
      const name = str(body?.name, 120).trim();
      if (!name || name.length > 80) return fail(400, 'Workspace name must be 1 to 80 characters');
      const { error } = await db.rpc('erp_rename_workspace', {
        p_workspace_id: workspaceId,
        p_name: name,
      });
      if (error) return rpcFailure(action, error);
      return reply(200, { success: true });
    }

    default:
      return fail(400, 'Unknown action.');
  }
}
