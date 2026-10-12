// A TERMINAL on its own and the ERPs it is linked to (20261012000044):
// which workspace a pipeline's ERP node reads, and adding a pipeline's rows
// to an ERP's customers, suppliers or products. Everything runs as the
// person running the pipeline, with their rights in the ERP.

import { ERP_TARGETS, type ErpTarget } from '@/lib/terminal/erpTargets';
import { coerce } from '@/lib/terminal/tabular';
import { WorkflowError } from '@/lib/workflow/errors';
import type { ErpWriteMode } from '@/lib/workflow/runtime';
import type { DataTable } from '@/lib/workflow/types';
import type { Executor, SqlTx } from '@/server/db/executor';
import { asUser, type RequestIdentity } from './session';
import { isUuid } from './session';

type Db = { from: (table: string) => any };

/**
 * The workspace an ERP node reads: the pipeline's own, or an ERP its
 * TERMINAL is linked to (checked here; the person's rights there are checked
 * by the query itself).
 */
export async function erpWorkspaceFor(
  db: Db,
  pipelineWorkspace: string | null,
  erp: string | null | undefined
): Promise<string | null> {
  if (!erp) return pipelineWorkspace;
  if (!isUuid(erp) || !pipelineWorkspace) throw new WorkflowError('wf.err.erpNotLinked');
  if (erp === pipelineWorkspace) return erp;
  const { data, error } = await db
    .from('ps_erp_links')
    .select('id')
    .eq('workspace_id', pipelineWorkspace)
    .eq('erp_workspace_id', erp)
    .maybeSingle();
  if (error || !data) throw new WorkflowError('wf.err.erpNotLinked');
  return erp;
}

/** As the user; a pipeline's own error (WorkflowError) comes out as it is. */
async function userTx<T>(
  executor: Executor,
  identity: RequestIdentity,
  path: string,
  fn: (tx: SqlTx) => Promise<T>
): Promise<T> {
  let own: WorkflowError | null = null;
  try {
    return await asUser(executor, identity, path, async (tx) => {
      try {
        return await fn(tx);
      } catch (e) {
        if (e instanceof WorkflowError) own = e;
        throw e;
      }
    });
  } catch (e) {
    throw own ?? e;
  }
}

/** Most rows one run adds to an ERP list. */
export const ERP_WRITE_LIMIT = 20_000;
const BATCH = 500;

async function linkedTx(tx: SqlTx, pipelineWorkspace: string, erp: string) {
  if (erp === pipelineWorkspace) return;
  const { rows } = await tx.query(
    'SELECT 1 FROM public.ps_erp_links WHERE workspace_id = $1 AND erp_workspace_id = $2',
    [pipelineWorkspace, erp]
  );
  if (!rows.length) throw new WorkflowError('wf.err.erpNotLinked');
}

/**
 * Adds a table's rows to an ERP list. Columns are matched to the list's
 * fields by name (ignoring case); `name` is required. A row whose name (or,
 * for products, SKU) is already in the list is skipped, or updated with
 * "add or update". Each row is one statement: a row the ERP refuses is
 * counted and the others go in.
 */
export async function writeErpList(
  executor: Executor,
  identity: RequestIdentity,
  pipelineWorkspace: string,
  erp: string | null,
  list: ErpTarget,
  mode: ErpWriteMode,
  table: DataTable
): Promise<{ added: number; updated: number; skipped: number; rejected: number }> {
  const target = erp ?? pipelineWorkspace;
  const def = ERP_TARGETS[list];
  const byLower = new Map(table.columns.map((c) => [c.trim().toLowerCase(), c]));
  const fields = def.fields.filter((f) => byLower.has(f.key));
  if (!fields.some((f) => f.key === 'name')) throw new WorkflowError('wf.err.erpNameColumn');
  if (table.rows.length > ERP_WRITE_LIMIT)
    throw new WorkflowError('wf.err.erpTooMany', { max: ERP_WRITE_LIMIT });
  const matchBy = list === 'products' && fields.some((f) => f.key === 'sku') ? 'sku' : 'name';
  const path = '/terminal/pipeline/erp';
  const out = { added: 0, updated: 0, skipped: 0, rejected: 0 };

  // What the list has already (as this person sees it).
  const existing = await userTx(executor, identity, path, async (tx) => {
    await linkedTx(tx, pipelineWorkspace, target);
    const { rows } = await tx.query(
      `SELECT id, lower(btrim(${matchBy}::text)) AS k FROM public.${def.table} WHERE workspace_id = $1 AND ${matchBy} IS NOT NULL`,
      [target]
    );
    return new Map<string, string>(rows.map((r: any) => [r.k, r.id]));
  });

  for (let start = 0; start < table.rows.length; start += BATCH) {
    const batch = table.rows.slice(start, start + BATCH);
    await userTx(executor, identity, path, async (tx) => {
      await linkedTx(tx, pipelineWorkspace, target);
      for (const raw of batch) {
        const values: Record<string, unknown> = {};
        let bad = false;
        for (const f of fields) {
          const c = coerce(raw[byLower.get(f.key)!], f.type, '.');
          if (!c.ok || (f.max && c.value !== null && String(c.value).length > f.max)) {
            bad = true;
            break;
          }
          if (c.value !== null) values[f.key] = c.value;
        }
        const k = values[matchBy] === undefined ? '' : String(values[matchBy]).trim().toLowerCase();
        if (bad || !values.name) {
          out.rejected += 1;
          continue;
        }
        const id = k ? existing.get(k) : undefined;
        if (id && mode === 'add_new') {
          out.skipped += 1;
          continue;
        }
        const keys = Object.keys(values);
        await tx.query('SAVEPOINT erp_row');
        try {
          if (id) {
            // Field names come from ERP_TARGETS only; values are parameters.
            await tx.query(
              `UPDATE public.${def.table} SET ${keys.map((c, n) => `"${c}" = $${n + 3}`).join(', ')} WHERE id = $1 AND workspace_id = $2`,
              [id, target, ...keys.map((c) => values[c])]
            );
            out.updated += 1;
          } else {
            const { rows } = await tx.query(
              `INSERT INTO public.${def.table} (workspace_id, user_id, ${keys.map((c) => `"${c}"`).join(', ')})
               VALUES ($1, (SELECT w.owner_id FROM public.erp_workspaces w WHERE w.id = $1), ${keys.map((_, n) => `$${n + 2}`).join(', ')}) RETURNING id`,
              [target, ...keys.map((c) => values[c])]
            );
            if (k) existing.set(k, rows[0].id);
            out.added += 1;
          }
          await tx.query('RELEASE SAVEPOINT erp_row');
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT erp_row');
          if ((error as { code?: string }).code === '42501')
            throw new WorkflowError('wf.err.erpForbidden');
          out.rejected += 1;
        }
      }
    });
  }
  return out;
}
