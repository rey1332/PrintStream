import type {
  Filter,
  MutationSpec,
  Order,
  RequestSpec,
  RpcSpec,
  SelectItem,
  SelectSpec,
} from '@/lib/db/spec';
import { parseSelect } from '@/lib/db/spec';
import type { Catalog, ColumnInfo, ForeignKey, FunctionInfo, TableInfo } from './catalog';

export const MAX_ROWS = 1000;

export class CompileError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface Compiled {
  sql: string;
  params: unknown[];
  shape: 'rows' | 'value' | 'none';
  countSql?: string;
  countParams?: unknown[];
}

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function tableInfo(catalog: Catalog, name: string): TableInfo {
  const table = catalog.tables.get(name);
  if (!table)
    throw new CompileError(
      `Could not find the table 'public.${name}' in the schema cache`,
      '42P01',
      404
    );
  return table;
}

function columnInfo(table: TableInfo, name: string): ColumnInfo {
  const column = table.columns.get(name);
  if (!column) throw new CompileError(`column ${table.name}.${name} does not exist`, '42703');
  return column;
}

// ─── Relationships (embedded resources) ──────────────────────────────────────

interface Relation {
  kind: 'many-to-one' | 'one-to-many';
  fk: ForeignKey;
}

function resolveRelation(
  catalog: Catalog,
  parent: string,
  child: string,
  hint: string | null
): Relation {
  const candidates: Relation[] = [];
  for (const fk of catalog.foreignKeys) {
    if (fk.table === parent && fk.refTable === child && parent !== child)
      candidates.push({ kind: 'many-to-one', fk });
    else if (fk.table === child && fk.refTable === parent && parent !== child)
      candidates.push({ kind: 'one-to-many', fk });
  }
  const matching = hint
    ? candidates.filter(
        (r) => r.fk.name === hint || r.fk.columns.includes(hint) || r.fk.refColumns.includes(hint)
      )
    : candidates;
  if (matching.length === 0) {
    throw new CompileError(
      `Could not find a relationship between '${parent}' and '${child}' in the schema cache`,
      'PGRST200'
    );
  }
  if (matching.length > 1) {
    throw new CompileError(
      `Could not embed because more than one relationship was found for '${parent}' and '${child}'`,
      'PGRST201',
      300
    );
  }
  return matching[0];
}

function joinCondition(relation: Relation, parentAlias: string, childAlias: string): string {
  const { fk } = relation;
  // many-to-one: parent.fk_col = child.ref_col; one-to-many: child.fk_col = parent.ref_col
  return fk.columns
    .map((col, i) =>
      relation.kind === 'many-to-one'
        ? `${childAlias}.${quote(fk.refColumns[i])} = ${parentAlias}.${quote(col)}`
        : `${childAlias}.${quote(col)} = ${parentAlias}.${quote(fk.refColumns[i])}`
    )
    .join(' AND ');
}

// ─── Filters ─────────────────────────────────────────────────────────────────

function likePattern(value: unknown): string {
  return String(value).replace(/\\\*|\*/g, (m) => (m === '*' ? '%' : '*'));
}

function filterSql(filter: Filter, column: ColumnInfo, ref: string, params: Params): string {
  const compare = (op: string) => `${ref} ${op} ${params.add(filter.value)}`;
  let sql: string;
  switch (filter.op) {
    case 'eq':
      sql = compare('=');
      break;
    case 'neq':
      sql = compare('<>');
      break;
    case 'gt':
      sql = compare('>');
      break;
    case 'gte':
      sql = compare('>=');
      break;
    case 'lt':
      sql = compare('<');
      break;
    case 'lte':
      sql = compare('<=');
      break;
    case 'like':
      sql = `${ref} LIKE ${params.add(likePattern(filter.value))}`;
      break;
    case 'ilike':
      sql = `${ref} ILIKE ${params.add(likePattern(filter.value))}`;
      break;
    case 'is':
      sql =
        filter.value === null
          ? `${ref} IS NULL`
          : filter.value === true
            ? `${ref} IS TRUE`
            : `${ref} IS FALSE`;
      break;
    case 'in': {
      const values = filter.value as unknown[];
      sql = values.length === 0 ? 'false' : `${ref} = ANY(${params.add(values)})`;
      break;
    }
    case 'cs':
      if (column.isJson) sql = `${ref} @> ${params.add(JSON.stringify(filter.value))}::jsonb`;
      else if (column.isArray) sql = `${ref} @> ${params.add(filter.value)}`;
      else
        throw new CompileError(`contains() needs a JSON or array column (${column.name})`, '42883');
      break;
    default:
      throw new CompileError('Unsupported filter', 'PGRST100');
  }
  return filter.negate ? `NOT (${sql})` : sql;
}

function splitFilters(filters: Filter[]): { own: Filter[]; byEmbed: Map<string, Filter[]> } {
  const own: Filter[] = [];
  const byEmbed = new Map<string, Filter[]>();
  for (const f of filters) {
    const dot = f.column.indexOf('.');
    if (dot === -1) {
      own.push(f);
    } else {
      const alias = f.column.slice(0, dot);
      const list = byEmbed.get(alias) ?? [];
      list.push({ ...f, column: f.column.slice(dot + 1) });
      byEmbed.set(alias, list);
    }
  }
  return { own, byEmbed };
}

function whereSql(table: TableInfo, alias: string, filters: Filter[], params: Params): string[] {
  return filters.map((f) => {
    if (f.op === 'or') {
      // Validated as simple filters on own columns (validateSpec).
      const any = (f.value as Filter[])
        .map((s) =>
          filterSql(s, columnInfo(table, s.column), `${alias}.${quote(s.column)}`, params)
        )
        .join(' OR ');
      return f.negate ? `NOT (${any})` : `(${any})`;
    }
    return filterSql(f, columnInfo(table, f.column), `${alias}.${quote(f.column)}`, params);
  });
}

// ─── Select lists ────────────────────────────────────────────────────────────

interface SelectContext {
  catalog: Catalog;
  params: Params;
  depth: number;
}

function selectList(
  ctx: SelectContext,
  table: TableInfo,
  alias: string,
  items: SelectItem[],
  embedFilters: Map<string, Filter[]>
): { list: string; innerConditions: string[] } {
  const parts: string[] = [];
  const innerConditions: string[] = [];
  const knownEmbeds = new Set(
    items.filter((i) => i.type === 'embed').map((i) => (i as { alias: string }).alias)
  );
  for (const alias of embedFilters.keys()) {
    if (!knownEmbeds.has(alias))
      throw new CompileError(`'${alias}' is not an embedded resource in this request`, 'PGRST108');
  }

  for (const item of items) {
    if (item.type === 'star') {
      parts.push(`${alias}.*`);
    } else if (item.type === 'column') {
      columnInfo(table, item.name);
      parts.push(`${alias}.${quote(item.name)} AS ${quote(item.alias)}`);
    } else {
      const child = tableInfo(ctx.catalog, item.table);
      const relation = resolveRelation(ctx.catalog, table.name, child.name, item.hint);
      const childAlias = `t${ctx.depth + 1}`;
      const filters = embedFilters.get(item.alias) ?? [];
      const inner = selectList(
        { ...ctx, depth: ctx.depth + 1 },
        child,
        childAlias,
        item.items,
        new Map()
      );
      const conditions = [
        joinCondition(relation, alias, childAlias),
        ...whereSql(child, childAlias, filters, ctx.params),
        ...inner.innerConditions,
      ];
      const from = `FROM public.${quote(child.name)} ${childAlias} WHERE ${conditions.join(' AND ')}`;
      const rowAlias = `_e${ctx.depth + 1}`;
      parts.push(
        relation.kind === 'many-to-one'
          ? `(SELECT row_to_json(${rowAlias}) FROM (SELECT ${inner.list} ${from}) ${rowAlias}) AS ${quote(item.alias)}`
          : `(SELECT coalesce(json_agg(${rowAlias}), '[]'::json) FROM (SELECT ${inner.list} ${from}) ${rowAlias}) AS ${quote(item.alias)}`
      );
      if (item.inner) innerConditions.push(`EXISTS (SELECT 1 ${from})`);
    }
  }
  return { list: parts.join(', '), innerConditions };
}

function orderSql(table: TableInfo | null, alias: string, order: Order[]): string {
  if (order.length === 0) return '';
  const parts = order.map((o) => {
    if (table) columnInfo(table, o.column);
    const nulls = o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
    return `${alias}.${quote(o.column)} ${o.ascending ? 'ASC' : 'DESC'}${nulls}`;
  });
  return ` ORDER BY ${parts.join(', ')}`;
}

function limitSql(spec: { range?: { from: number; to: number }; limit?: number }): string {
  const requested = spec.range ? spec.range.to - spec.range.from + 1 : spec.limit;
  const limit = Math.min(requested ?? MAX_ROWS, MAX_ROWS);
  const offset = spec.range?.from ?? 0;
  return ` LIMIT ${limit}${offset > 0 ? ` OFFSET ${offset}` : ''}`;
}

// ─── Statements ──────────────────────────────────────────────────────────────

function compileSelect(catalog: Catalog, spec: SelectSpec): Compiled {
  const table = tableInfo(catalog, spec.table);
  const { own, byEmbed } = splitFilters(spec.filters);
  const items = parseSelect(spec.select);

  const build = () => {
    const params = new Params();
    const { list, innerConditions } = selectList(
      { catalog, params, depth: 0 },
      table,
      't0',
      items,
      byEmbed
    );
    const where = [...whereSql(table, 't0', own, params), ...innerConditions];
    const from = `FROM public.${quote(table.name)} t0${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    return { params, list, from };
  };

  const main = build();
  const compiled: Compiled = spec.head
    ? { sql: 'SELECT NULL::text AS body', params: [], shape: 'none' }
    : {
        sql: `SELECT coalesce(json_agg(_r), '[]'::json)::text AS body FROM (SELECT ${main.list} ${main.from}${orderSql(table, 't0', spec.order)}${limitSql(spec)}) _r`,
        params: main.params.values,
        shape: 'rows',
      };
  if (spec.count === 'exact') {
    const counting = new Params();
    // Only !inner embeds restrict which parent rows are counted.
    const innerItems = items.filter((i) => i.type === 'embed' && i.inner);
    const innerAliases = new Set(innerItems.map((i) => (i as { alias: string }).alias));
    const innerFilters = new Map([...byEmbed].filter(([alias]) => innerAliases.has(alias)));
    const where = [
      ...whereSql(table, 't0', own, counting),
      ...selectList({ catalog, params: counting, depth: 0 }, table, 't0', innerItems, innerFilters)
        .innerConditions,
    ];
    compiled.countSql = `SELECT count(*)::bigint AS n FROM public.${quote(table.name)} t0${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
    compiled.countParams = counting.values;
  }
  return compiled;
}

function payloadColumns(table: TableInfo, values: MutationSpec['values']): string[] {
  const rows = Array.isArray(values) ? values : values ? [values] : [];
  if (rows.length === 0) throw new CompileError('Empty or invalid json', 'PGRST102');
  const keys = new Set<string>();
  // Like supabase-js: a single object sends its defined keys; an array the union of all keys.
  if (Array.isArray(values)) rows.forEach((row) => Object.keys(row).forEach((k) => keys.add(k)));
  else
    Object.entries(rows[0]).forEach(([k, v]) => {
      if (v !== undefined) keys.add(k);
    });
  if (keys.size === 0) throw new CompileError('Empty or invalid json', 'PGRST102');
  for (const key of keys) columnInfo(table, key);
  return [...keys];
}

function returningPart(
  catalog: Catalog,
  table: TableInfo,
  spec: MutationSpec,
  params: Params
): { returning: string; select: string | null } {
  if (spec.returning !== undefined) {
    const { list } = selectList(
      { catalog, params, depth: 0 },
      table,
      't0',
      parseSelect(spec.returning),
      new Map()
    );
    return { returning: ' RETURNING *', select: list };
  }
  if (spec.count === 'exact' || spec.single)
    return { returning: ' RETURNING 1 AS one', select: null };
  return { returning: '', select: null };
}

function compileMutation(catalog: Catalog, spec: MutationSpec): Compiled {
  const table = tableInfo(catalog, spec.table);
  const params = new Params();
  const t = `public.${quote(table.name)}`;
  let statement: string;

  if (spec.kind === 'insert' || spec.kind === 'upsert') {
    if (spec.filters.length > 0)
      throw new CompileError('Filters are not allowed on insert', 'PGRST100');
    const cols = payloadColumns(table, spec.values);
    const colList = cols.map(quote).join(', ');
    const rows = Array.isArray(spec.values) ? spec.values : [spec.values];
    const source = `SELECT ${colList} FROM json_populate_recordset(NULL::${t}, ${params.add(JSON.stringify(rows))}::json)`;
    let conflict = '';
    if (spec.kind === 'upsert') {
      const target = spec.onConflict
        ? spec.onConflict.split(',').map((s) => s.trim())
        : table.primaryKey;
      if (target.length === 0)
        throw new CompileError(`Table ${table.name} has no primary key for upsert`, 'PGRST100');
      target.forEach((c) => columnInfo(table, c));
      const updates = cols.filter((c) => !target.includes(c));
      conflict =
        spec.ignoreDuplicates || updates.length === 0
          ? ` ON CONFLICT (${target.map(quote).join(', ')}) DO NOTHING`
          : ` ON CONFLICT (${target.map(quote).join(', ')}) DO UPDATE SET ${updates.map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', ')}`;
    }
    const { returning, select } = returningPart(catalog, table, spec, params);
    statement = `INSERT INTO ${t} AS t0 (${colList}) ${source}${conflict}${returning}`;
    return wrapMutation(statement, select, params, returning !== '');
  }

  const own = spec.filters;
  if (own.some((f) => f.column.includes('.')))
    throw new CompileError('Filters on embedded resources are not allowed here', 'PGRST100');
  const where = whereSql(table, 't0', own, params);
  const whereText = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  if (spec.kind === 'update') {
    const cols = payloadColumns(table, spec.values);
    const valuesParam = params.add(JSON.stringify(spec.values));
    const set = cols.map((c) => `${quote(c)} = _v.${quote(c)}`).join(', ');
    const { returning, select } = returningPart(catalog, table, spec, params);
    statement = `UPDATE ${t} t0 SET ${set} FROM json_populate_record(NULL::${t}, ${valuesParam}::json) _v${whereText}${returning.replace('RETURNING *', 'RETURNING t0.*')}`;
    return wrapMutation(statement, select, params, returning !== '');
  }

  // delete
  const { returning, select } = returningPart(catalog, table, spec, params);
  statement = `DELETE FROM ${t} t0${whereText}${returning.replace('RETURNING *', 'RETURNING t0.*')}`;
  return wrapMutation(statement, select, params, returning !== '');
}

function wrapMutation(
  statement: string,
  select: string | null,
  params: Params,
  hasReturning: boolean
): Compiled {
  if (!hasReturning) return { sql: `${statement}`, params: params.values, shape: 'none' };
  if (select === null) {
    return {
      sql: `WITH _m AS (${statement}) SELECT NULL::text AS body, (SELECT count(*) FROM _m)::bigint AS n`,
      params: params.values,
      shape: 'none',
    };
  }
  return {
    sql: `WITH _m AS (${statement}) SELECT coalesce(json_agg(_r), '[]'::json)::text AS body, (SELECT count(*) FROM _m)::bigint AS n FROM (SELECT ${select} FROM _m t0) _r`,
    params: params.values,
    shape: 'rows',
  };
}

// ─── RPC ─────────────────────────────────────────────────────────────────────

function chooseFunction(catalog: Catalog, spec: RpcSpec): FunctionInfo {
  const overloads = catalog.functions.get(spec.fn) ?? [];
  const given = Object.keys(spec.args);
  const fits = overloads.filter((fn) => {
    const names = fn.args.map((a) => a.name);
    const required = names.slice(0, names.length - fn.defaults);
    return given.every((k) => names.includes(k)) && required.every((k) => given.includes(k));
  });
  if (fits.length === 0) {
    throw new CompileError(
      `Could not find the function public.${spec.fn}(${given.join(', ')}) in the schema cache`,
      'PGRST202',
      404
    );
  }
  if (fits.length > 1) {
    // Prefer the overload whose argument list matches exactly.
    const exact = fits.filter((fn) => fn.args.length === given.length);
    if (exact.length === 1) return exact[0];
    throw new CompileError(
      `Could not choose the best candidate function for public.${spec.fn}`,
      'PGRST203',
      300
    );
  }
  return fits[0];
}

function rpcArgument(value: unknown, arg: FunctionInfo['args'][number]): unknown {
  if (value === null || value === undefined) return null;
  if (arg.isJson) return JSON.stringify(value);
  if (typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  return value;
}

function compileRpc(catalog: Catalog, spec: RpcSpec): Compiled {
  const fn = chooseFunction(catalog, spec);
  const params = new Params();
  const args = fn.args
    .filter((a) => Object.prototype.hasOwnProperty.call(spec.args, a.name))
    .map((a) => `${quote(a.name)} => ${params.add(rpcArgument(spec.args[a.name], a))}::${a.type}`)
    .join(', ');
  const call = `public.${quote(fn.name)}(${args})`;

  if (fn.returns === 'void') {
    if (spec.filters.length || spec.order.length)
      throw new CompileError('Filters need a function that returns rows', 'PGRST100');
    return { sql: `SELECT ${call}, NULL::text AS body`, params: params.values, shape: 'none' };
  }
  if (!fn.returnsSet) {
    if (spec.filters.length || spec.order.length)
      throw new CompileError('Filters need a function that returns rows', 'PGRST100');
    return fn.returns === 'rows'
      ? {
          sql: `SELECT row_to_json(_r)::text AS body FROM ${call} _r`,
          params: params.values,
          shape: 'value',
        }
      : { sql: `SELECT to_json(${call})::text AS body`, params: params.values, shape: 'value' };
  }
  // Set-returning: filters, order and limits apply to the returned rows.
  const where = spec.filters.map((f) => {
    if (f.column.includes('.'))
      throw new CompileError('Filters on embedded resources are not allowed here', 'PGRST100');
    const pseudo: ColumnInfo = { name: f.column, type: 'unknown', isArray: false, isJson: false };
    return filterSql(f, pseudo, `t0.${quote(f.column)}`, params);
  });
  const whereText = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const from = `FROM ${call} t0${whereText}`;
  const compiled: Compiled = spec.head
    ? { sql: 'SELECT NULL::text AS body', params: [], shape: 'none' }
    : {
        sql: `SELECT coalesce(json_agg(_r), '[]'::json)::text AS body FROM (SELECT * ${from}${orderSql(null, 't0', spec.order)}${limitSql(spec)}) _r`,
        params: params.values,
        shape: 'rows',
      };
  if (spec.count === 'exact') {
    compiled.countSql = `SELECT count(*)::bigint AS n ${from}`;
    compiled.countParams = params.values;
  }
  return compiled;
}

export function compile(catalog: Catalog, spec: RequestSpec): Compiled {
  switch (spec.kind) {
    case 'select':
      return compileSelect(catalog, spec);
    case 'rpc':
      return compileRpc(catalog, spec);
    default:
      return compileMutation(catalog, spec);
  }
}
