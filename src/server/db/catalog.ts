import type { SqlTx } from './executor';

export interface ColumnInfo {
  name: string;
  type: string;
  isArray: boolean;
  isJson: boolean;
}

export interface TableInfo {
  name: string;
  columns: Map<string, ColumnInfo>;
  primaryKey: string[];
}

export interface ForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

export interface FunctionArg {
  name: string;
  type: string;
  isArray: boolean;
  isJson: boolean;
}

export interface FunctionInfo {
  name: string;
  args: FunctionArg[];
  defaults: number;
  returnsSet: boolean;
  returns: 'rows' | 'scalar' | 'void';
}

export interface Catalog {
  tables: Map<string, TableInfo>;
  foreignKeys: ForeignKey[];
  functions: Map<string, FunctionInfo[]>;
}

const JSON_TYPES = new Set(['json', 'jsonb']);

export async function loadCatalog(tx: SqlTx): Promise<Catalog> {
  const tables = new Map<string, TableInfo>();

  const columns = await tx.query(
    `select c.relname as table_name, a.attname as column_name,
            format_type(a.atttypid, a.atttypmod) as column_type,
            t.typcategory = 'A' as is_array,
            coalesce(et.typname, t.typname) as base_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       join pg_type t on t.oid = a.atttypid
       left join pg_type et on et.oid = t.typelem and t.typcategory = 'A'
      where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
      order by c.relname, a.attnum`
  );
  for (const row of columns.rows) {
    let table = tables.get(row.table_name);
    if (!table) {
      table = { name: row.table_name, columns: new Map(), primaryKey: [] };
      tables.set(row.table_name, table);
    }
    table.columns.set(row.column_name, {
      name: row.column_name,
      type: row.column_type,
      isArray: row.is_array === true,
      isJson: !row.is_array && JSON_TYPES.has(row.base_type),
    });
  }

  const keys = await tx.query(
    `select c.relname as table_name,
            array(select a.attname::text from unnest(i.indkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum order by k.ord)::text[] as columns
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace
      where i.indisprimary and n.nspname = 'public'`
  );
  for (const row of keys.rows) {
    const table = tables.get(row.table_name);
    if (table) table.primaryKey = row.columns;
  }

  const fks = await tx.query(
    `select con.conname as name, cl.relname as table_name, rl.relname as ref_table,
            array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.ord)::text[] as columns,
            array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, ord)
                    join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.ord)::text[] as ref_columns
       from pg_constraint con
       join pg_class cl on cl.oid = con.conrelid
       join pg_namespace n on n.oid = cl.relnamespace
       join pg_class rl on rl.oid = con.confrelid
       join pg_namespace rn on rn.oid = rl.relnamespace
      where con.contype = 'f' and n.nspname = 'public' and rn.nspname = 'public'`
  );
  const foreignKeys: ForeignKey[] = fks.rows.map((row) => ({
    name: row.name,
    table: row.table_name,
    columns: row.columns,
    refTable: row.ref_table,
    refColumns: row.ref_columns,
  }));

  const fns = await tx.query(
    `select p.proname as name, p.proretset as returns_set, p.pronargdefaults as n_defaults,
            coalesce(p.proargnames, '{}'::text[])::text[] as arg_names,
            coalesce(p.proargmodes::text[], '{}'::text[]) as arg_modes,
            array(select format_type(t, null) from unnest(p.proargtypes) t)::text[] as in_types,
            array(select (select typcategory = 'A' from pg_type where oid = t) from unnest(p.proargtypes) t)::boolean[] as in_arrays,
            array(select (select typname from pg_type where oid = t) from unnest(p.proargtypes) t)::text[] as in_typnames,
            rt.typname as ret_name, rt.typtype as ret_kind
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       join pg_type rt on rt.oid = p.prorettype
      where n.nspname = 'public' and p.prokind = 'f'`
  );
  const functions = new Map<string, FunctionInfo[]>();
  for (const row of fns.rows) {
    const modes: string[] = row.arg_modes;
    const names: string[] = row.arg_names;
    // proargnames covers every argument (IN and OUT); proargtypes only inputs.
    const inputNames =
      modes.length === 0 ? names : names.filter((_, i) => ['i', 'b', 'v'].includes(modes[i]));
    const args: FunctionArg[] = (row.in_types as string[]).map((type, i) => ({
      name: inputNames[i] ?? '',
      type,
      isArray: row.in_arrays[i] === true,
      isJson: JSON_TYPES.has(row.in_typnames[i]),
    }));
    const returns: FunctionInfo['returns'] =
      row.ret_name === 'void'
        ? 'void'
        : row.ret_kind === 'c' || row.ret_name === 'record'
          ? 'rows'
          : 'scalar';
    const info: FunctionInfo = {
      name: row.name,
      args,
      defaults: Number(row.n_defaults) || 0,
      returnsSet: row.returns_set === true,
      returns,
    };
    const list = functions.get(row.name) ?? [];
    list.push(info);
    functions.set(row.name, list);
  }

  return { tables, foreignKeys, functions };
}
