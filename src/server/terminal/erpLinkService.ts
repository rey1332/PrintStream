// The ERPs a Terminal on its own is linked to (20261012000044), for the
// Terminal screen and the pipeline editor's ERP nodes.

import type { SqlTx } from '@/server/db/executor';
import { TerminalError, asUser, isUuid } from './session';
import type { TerminalContext } from './service';

const run = <T>(ctx: TerminalContext, fn: (tx: SqlTx) => Promise<T>) =>
  asUser(ctx.executor, ctx.identity, '/terminal/erp-links', fn);
const uuid = (v: unknown) => {
  if (!isUuid(v)) throw new TerminalError('invalid');
  return v;
};

export async function listErpLinks(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT l.id, l.erp_workspace_id, l.erp_name, l.created_at,
              public.erp_workspace_role(l.erp_workspace_id) IS NOT NULL AS member
         FROM public.ps_erp_links l WHERE l.workspace_id = $1 ORDER BY lower(l.erp_name)`,
      [ws]
    );
    return rows.map((r: any) => ({
      id: r.id as string,
      erpId: r.erp_workspace_id as string,
      name: r.erp_name as string,
      // Whether the person asking may read it (pipelines run with their rights).
      member: r.member === true,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  });
}

export async function addErpLink(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  const erp = uuid(body.erpWorkspaceId);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query('SELECT public.ps_link_erp($1, $2) AS id', [ws, erp]);
    return { id: rows[0].id as string };
  });
}

export async function removeErpLink(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_unlink_erp($1)', [uuid(body.id)]));
}
