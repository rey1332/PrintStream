export type FilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'is'
  | 'in'
  | 'cs'
  | 'or';

export interface Filter {
  column: string;
  op: FilterOp;
  value: unknown;
  negate?: boolean;
}

export interface Order {
  column: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

interface Base {
  filters: Filter[];
  order: Order[];
  range?: { from: number; to: number };
  limit?: number;
  single?: 'one' | 'maybe';
  count?: 'exact';
  head?: boolean;
}

export interface SelectSpec extends Base {
  kind: 'select';
  table: string;
  select: string;
}

export interface MutationSpec extends Base {
  kind: 'insert' | 'upsert' | 'update' | 'delete';
  table: string;
  values?: Record<string, unknown> | Record<string, unknown>[];
  onConflict?: string;
  ignoreDuplicates?: boolean;
  returning?: string;
}

export interface RpcSpec extends Base {
  kind: 'rpc';
  fn: string;
  args: Record<string, unknown>;
}

export type RequestSpec = SelectSpec | MutationSpec | RpcSpec;

export interface RestError {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
}

export interface RestResult<T = unknown> {
  data: T | null;
  error: RestError | null;
  count: number | null;
  status: number;
}

export type SelectItem =
  | { type: 'star' }
  | { type: 'column'; name: string; alias: string }
  | {
      type: 'embed';
      table: string;
      alias: string;
      hint: string | null;
      inner: boolean;
      items: SelectItem[];
    };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 63 && IDENT.test(value);
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth < 0) throw new SelectParseError('Unbalanced parentheses in select');
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (depth !== 0) throw new SelectParseError('Unbalanced parentheses in select');
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export class SelectParseError extends Error {}

export function parseSelect(input: string): SelectItem[] {
  const text = (input ?? '').trim() || '*';
  if (text.length > 4000) throw new SelectParseError('Select is too long');
  return splitTopLevel(text).map(parseItem);
}

function parseItem(raw: string): SelectItem {
  if (raw === '*') return { type: 'star' };
  const open = raw.indexOf('(');
  if (open === -1) {
    const [alias, name] = raw.includes(':') ? raw.split(':').map((s) => s.trim()) : [raw, raw];
    if (!isIdentifier(alias) || !isIdentifier(name))
      throw new SelectParseError(`Invalid select item: ${raw}`);
    return { type: 'column', name, alias };
  }
  if (!raw.endsWith(')')) throw new SelectParseError(`Invalid embedded resource: ${raw}`);
  const head = raw.slice(0, open).trim();
  const inside = raw.slice(open + 1, -1);
  const colon = head.indexOf(':');
  const alias = colon === -1 ? null : head.slice(0, colon).trim();
  const [table, ...hints] = (colon === -1 ? head : head.slice(colon + 1))
    .split('!')
    .map((s) => s.trim());
  if (!isIdentifier(table) || (alias !== null && !isIdentifier(alias))) {
    throw new SelectParseError(`Invalid embedded resource: ${raw}`);
  }
  let hint: string | null = null;
  let inner = false;
  for (const h of hints) {
    if (h === 'inner') inner = true;
    else if (h === 'left') inner = false;
    else if (isIdentifier(h) && hint === null) hint = h;
    else throw new SelectParseError(`Invalid embed hint: ${raw}`);
  }
  return {
    type: 'embed',
    table,
    alias: alias ?? table,
    hint,
    inner,
    items: parseSelect(inside || '*'),
  };
}

// ─── Validation of specs received over HTTP ──────────────────────────────────

const OPS: FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'cs'];
const MAX_OR = 10;

function simpleFilterError(f: unknown): string | null {
  if (!isPlainObject(f) || typeof f.column !== 'string' || !OPS.includes(f.op as FilterOp))
    return 'Invalid filter';
  if (!isIdentifier(f.column)) return 'Invalid filter column';
  if (f.op === 'in' && !Array.isArray(f.value)) return 'in() needs a list';
  if (f.op === 'is' && !(f.value === null || f.value === true || f.value === false))
    return 'is() needs null, true or false';
  return null;
}
const KINDS = ['select', 'insert', 'upsert', 'update', 'delete', 'rpc'] as const;
const MAX_FILTERS = 50;
const MAX_ORDER = 10;
const MAX_VALUES_BYTES = 2_000_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateSpec(
  input: unknown
): { ok: true; spec: RequestSpec } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: 'Request must be an object' };
  const isKind = (value: unknown): value is RequestSpec['kind'] => KINDS.some((k) => k === value);
  const kind = input.kind;
  if (!isKind(kind)) return { ok: false, error: 'Unknown request kind' };

  const filters = input.filters ?? [];
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS)
    return { ok: false, error: 'Invalid filters' };
  for (const f of filters) {
    if (isPlainObject(f) && f.op === 'or') {
      if (
        f.column !== '' ||
        !Array.isArray(f.value) ||
        f.value.length === 0 ||
        f.value.length > MAX_OR
      )
        return { ok: false, error: 'Invalid or()' };
      for (const sub of f.value) {
        const error = simpleFilterError(sub);
        if (error) return { ok: false, error };
      }
      continue;
    }
    if (!isPlainObject(f) || typeof f.column !== 'string' || !OPS.includes(f.op as FilterOp))
      return { ok: false, error: 'Invalid filter' };
    const parts = f.column.split('.');
    if (parts.length > 2 || !parts.every(isIdentifier))
      return { ok: false, error: 'Invalid filter column' };
    if (f.op === 'in' && !Array.isArray(f.value)) return { ok: false, error: 'in() needs a list' };
    if (f.op === 'is' && !(f.value === null || f.value === true || f.value === false))
      return { ok: false, error: 'is() needs null, true or false' };
  }
  const order = input.order ?? [];
  if (!Array.isArray(order) || order.length > MAX_ORDER)
    return { ok: false, error: 'Invalid order' };
  for (const o of order) {
    if (!isPlainObject(o) || !isIdentifier(o.column) || typeof o.ascending !== 'boolean')
      return { ok: false, error: 'Invalid order' };
    if (o.nullsFirst !== undefined && typeof o.nullsFirst !== 'boolean')
      return { ok: false, error: 'Invalid order' };
  }
  if (input.range !== undefined) {
    const r = input.range;
    if (
      !isPlainObject(r) ||
      !Number.isInteger(r.from) ||
      !Number.isInteger(r.to) ||
      (r.from as number) < 0 ||
      (r.to as number) < (r.from as number)
    ) {
      return { ok: false, error: 'Invalid range' };
    }
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 0))
    return { ok: false, error: 'Invalid limit' };
  if (input.single !== undefined && input.single !== 'one' && input.single !== 'maybe')
    return { ok: false, error: 'Invalid single' };
  if (input.count !== undefined && input.count !== 'exact')
    return { ok: false, error: 'Invalid count' };
  if (input.head !== undefined && typeof input.head !== 'boolean')
    return { ok: false, error: 'Invalid head' };

  const base = {
    filters: filters as Filter[],
    order: order as Order[],
    range: input.range as Base['range'],
    limit: input.limit as number | undefined,
    single: input.single as Base['single'],
    count: input.count as Base['count'],
    head: input.head as boolean | undefined,
  };

  if (kind === 'rpc') {
    if (!isIdentifier(input.fn)) return { ok: false, error: 'Invalid function name' };
    const args = input.args ?? {};
    if (!isPlainObject(args) || !Object.keys(args).every(isIdentifier))
      return { ok: false, error: 'Invalid function arguments' };
    return { ok: true, spec: { ...base, kind: 'rpc', fn: input.fn, args } };
  }

  if (!isIdentifier(input.table)) return { ok: false, error: 'Invalid table name' };
  if (kind === 'select') {
    if (typeof input.select !== 'string') return { ok: false, error: 'Invalid select' };
    try {
      parseSelect(input.select);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
    return {
      ok: true,
      spec: { ...base, kind: 'select', table: input.table, select: input.select },
    };
  }

  const values = input.values;
  if (kind !== 'delete') {
    const rows = Array.isArray(values) ? values : [values];
    if (
      rows.length === 0 ||
      !rows.every((row) => isPlainObject(row) && Object.keys(row).every(isIdentifier))
    ) {
      return { ok: false, error: 'Invalid values' };
    }
    if (JSON.stringify(values).length > MAX_VALUES_BYTES)
      return { ok: false, error: 'Request is too large' };
  }
  if (input.onConflict !== undefined) {
    if (
      typeof input.onConflict !== 'string' ||
      !input.onConflict
        .split(',')
        .map((s) => s.trim())
        .every(isIdentifier)
    ) {
      return { ok: false, error: 'Invalid onConflict' };
    }
  }
  if (input.returning !== undefined) {
    if (typeof input.returning !== 'string') return { ok: false, error: 'Invalid returning' };
    try {
      parseSelect(input.returning);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }
  return {
    ok: true,
    spec: {
      ...base,
      kind,
      table: input.table,
      values: values as MutationSpec['values'],
      onConflict: input.onConflict as string | undefined,
      ignoreDuplicates: input.ignoreDuplicates === true,
      returning: input.returning as string | undefined,
    },
  };
}
