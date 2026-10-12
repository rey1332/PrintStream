import type { ConsoleAccess, ConsoleDb } from './access';

type Mutation = PromiseLike<{ error: { code?: string } | null; count?: number | null }> & {
  eq(column: string, value: unknown): Mutation;
};
export interface ConsoleCommandDb extends ConsoleDb {
  from(
    table: string
  ): ReturnType<ConsoleDb['from']> & { delete(options?: { count?: 'exact' }): Mutation };
}

export const DELETE_TARGETS: Record<string, { label: string; table: string | null }> = {
  d_sp: { label: 'suppliers', table: 'erp_suppliers' },
  d_inv: { label: 'inventory/products', table: 'erp_products' },
  d_cust: { label: 'customers', table: 'erp_customers' },
  d_ts: { label: 'transactions', table: null },
  d_pay: { label: 'payments', table: null },
  d_po: { label: 'purchase orders', table: null },
  d_so: { label: 'sales orders', table: null },
  d_invcs: { label: 'invoices', table: null },
  d_aud: { label: 'audit logs', table: null },
  d_all: { label: 'ALL ERP DATA', table: null },
};

export const SERVER_COMMANDS = ['ver', 'whoami', 'delete'] as const;
export type ServerCommand = (typeof SERVER_COMMANDS)[number];

export interface CommandContext {
  db: ConsoleCommandDb;
  userId: string;
  displayName: string;
  access: Extract<ConsoleAccess, { allowed: true }>;
  version: string;
}

export type CommandResult = { ok: true; lines: string[] } | { ok: false; error: string };

const ROLE_NAMES = { owner: 'Owner', finance: 'Finance' } as const;

export function isServerCommand(value: unknown): value is ServerCommand {
  return typeof value === 'string' && (SERVER_COMMANDS as readonly string[]).includes(value);
}

export async function runConsoleCommand(
  command: ServerCommand,
  target: unknown,
  ctx: CommandContext
): Promise<CommandResult> {
  switch (command) {
    case 'ver':
      return { ok: true, lines: [`ETNA ${ctx.version}`] };
    case 'whoami':
      return { ok: true, lines: [`${ctx.displayName} · ${ROLE_NAMES[ctx.access.role]}`] };
    case 'delete': {
      const spec =
        typeof target === 'string' && Object.hasOwn(DELETE_TARGETS, target)
          ? DELETE_TARGETS[target]
          : null;
      if (!spec) return { ok: false, error: 'Unknown data command.' };
      if (target === 'd_all') {
        return {
          ok: false,
          error:
            'Not allowed here. To reset an ERP, use Settings → Delete all data (owner, password required).',
        };
      }
      if (!spec.table) {
        return {
          ok: false,
          error: `Not allowed: ${spec.label} can only be changed through ERP actions.`,
        };
      }
      const { error, count } = await ctx.db
        .from(spec.table)
        .delete({ count: 'exact' })
        .eq('workspace_id', ctx.access.workspaceId);
      if (error) {
        console.info(
          `[console] user=${ctx.userId} delete=${target} refused code=${error.code ?? 'error'}`
        );
        return {
          ok: false,
          error:
            error.code === '23503'
              ? `Some ${spec.label} are still used by orders or invoices, so nothing was deleted.`
              : error.code === '42501'
                ? `Not allowed: your role cannot delete ${spec.label} in this workspace.`
                : 'The command could not be completed. Nothing was deleted.',
        };
      }
      const total = Number(count ?? 0);
      // Audit trail of who ran what (row changes are also in erp_audit_log).
      console.info(
        `[console] user=${ctx.userId} workspace=${ctx.access.workspaceId} delete=${target} rows=${total}`
      );
      return { ok: true, lines: [`[OK] Deleted ${total} rows.`] };
    }
  }
}
