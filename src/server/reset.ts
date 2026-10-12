import { beginAsUser, getCatalog, type RequestIdentity } from '@/server/db/execute';
import type { Executor } from '@/server/db/executor';
import { verifyPassword, type AuthDeps, type SessionInfo } from '@/server/auth/service';

export type ResetScope = 'transactions' | 'all';

export type ResetResult =
  | { ok: true; removed: Record<string, number> }
  | { ok: false; error: 'invalid' | 'wrong_password' | 'rate_limited' | 'forbidden' | 'failed' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resetWorkspace(
  deps: { auth: AuthDeps; executor: Executor },
  session: SessionInfo,
  identity: RequestIdentity,
  input: { scope: unknown; workspaceId: unknown; password: unknown; ip: string | null }
): Promise<ResetResult> {
  const scope = input.scope === 'transactions' || input.scope === 'all' ? input.scope : null;
  const workspaceId =
    input.workspaceId === null || input.workspaceId === undefined || input.workspaceId === ''
      ? null
      : input.workspaceId;
  if (
    !scope ||
    (workspaceId !== null && (typeof workspaceId !== 'string' || !UUID.test(workspaceId)))
  ) {
    return { ok: false, error: 'invalid' };
  }
  if (typeof input.password !== 'string' || !input.password)
    return { ok: false, error: 'wrong_password' };

  const checked = await verifyPassword(deps.auth, session, input.password, input.ip);
  if (checked === 'rate_limited') return { ok: false, error: 'rate_limited' };
  if (!checked) return { ok: false, error: 'wrong_password' };

  try {
    const catalog = await getCatalog(deps.executor);
    const removed = await deps.executor.transaction(async (tx) => {
      await beginAsUser(tx, identity, '/account/reset', 'POST', catalog);
      const { rows } = await tx.query(
        'SELECT public.erp_reset_workspace($1::uuid, $2) AS removed',
        [workspaceId, scope]
      );
      return rows[0].removed as Record<string, number>;
    });
    console.info(
      `[reset] user=${session.userId} workspace=${workspaceId ?? 'personal'} scope=${scope}`
    );
    return { ok: true, removed };
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.error('[reset]', code || 'error');
    return { ok: false, error: code === '42501' ? 'forbidden' : 'failed' };
  }
}

export type DeleteErpResult =
  | { ok: true; name: string; emptied: boolean }
  | {
      ok: false;
      error:
        | 'invalid'
        | 'name_mismatch'
        | 'wrong_password'
        | 'rate_limited'
        | 'forbidden'
        | 'personal'
        | 'failed';
    };

class NameMismatch extends Error {}

export async function deleteCreatedErp(
  deps: { auth: AuthDeps; executor: Executor; removeFiles: (workspaceId: string) => Promise<void> },
  session: SessionInfo,
  identity: RequestIdentity,
  input: { workspaceId: unknown; confirmName: unknown; password: unknown; ip: string | null }
): Promise<DeleteErpResult> {
  if (typeof input.workspaceId !== 'string' || !UUID.test(input.workspaceId)) {
    return { ok: false, error: 'invalid' };
  }
  const workspaceId = input.workspaceId;
  if (typeof input.confirmName !== 'string' || !input.confirmName.trim()) {
    return { ok: false, error: 'name_mismatch' };
  }
  const confirmName = input.confirmName.trim();
  if (typeof input.password !== 'string' || !input.password)
    return { ok: false, error: 'wrong_password' };

  const checked = await verifyPassword(deps.auth, session, input.password, input.ip);
  if (checked === 'rate_limited') return { ok: false, error: 'rate_limited' };
  if (!checked) return { ok: false, error: 'wrong_password' };

  let name: string;
  let emptied = false;
  try {
    const catalog = await getCatalog(deps.executor);
    name = await deps.executor.transaction(async (tx) => {
      await beginAsUser(tx, identity, '/account/delete-erp', 'POST', catalog);
      // The person typed the ERP's name: a deletion cannot hit another ERP by mistake.
      const named = await tx.query(
        'SELECT name, is_personal FROM public.erp_my_workspaces() WHERE workspace_id = $1::uuid',
        [workspaceId]
      );
      const erp = named.rows[0];
      if (erp?.name !== confirmName) throw new NameMismatch();
      if (erp.is_personal === true) {
        emptied = true;
        await tx.query('SELECT public.erp_empty_erp($1::uuid)', [workspaceId]);
        return String(erp.name);
      }
      const { rows } = await tx.query('SELECT public.erp_delete_erp($1::uuid) AS name', [
        workspaceId,
      ]);
      return String(rows[0].name);
    });
  } catch (error) {
    if (error instanceof NameMismatch) return { ok: false, error: 'name_mismatch' };
    const e = error as { code?: string; hint?: string };
    console.error('[delete-erp]', e.code || 'error');
    if (e.code === 'P0001' && e.hint === 'personal') return { ok: false, error: 'personal' };
    return { ok: false, error: e.code === '42501' ? 'forbidden' : 'failed' };
  }
  console.info(
    `[delete-erp] user=${session.userId} workspace=${workspaceId} ${emptied ? 'emptied' : 'deleted'}`
  );
  // After the commit: a failure here leaves unreferenced files, never a dangling ERP.
  await deps.removeFiles(workspaceId).catch(() => console.error('[delete-erp] files not removed'));
  return { ok: true, name, emptied };
}
