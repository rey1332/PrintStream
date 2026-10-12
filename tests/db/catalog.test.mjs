import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';
import { CATALOG, ENTITY_KEYS, excludedFieldReason, getRelation } from '../../src/lib/analytics/catalog.ts';

let db;
before(async () => { db = await createDb(); });
after(async () => { await db?.close(); });

const PG_TYPES = {
  id: ['uuid'],
  text: ['text'],
  integer: ['integer'],
  number: ['numeric'],
  money: ['numeric'],
  date: ['date'],
  datetime: ['timestamp with time zone'],
  enum: ['USER-DEFINED', 'text'],
  boolean: ['boolean'],
};

async function columns(table) {
  const { rows } = await db.query(
    `select column_name, data_type, udt_name, is_nullable, is_generated
       from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [table]
  );
  return new Map(rows.map((r) => [r.column_name, r]));
}

async function enumLabels(udt) {
  const { rows } = await db.query(
    `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder`,
    [udt]
  );
  return rows.map((r) => r.enumlabel);
}

async function checkConstraints(table) {
  const { rows } = await db.query(
    `select pg_get_constraintdef(c.oid) as def from pg_constraint c
       join pg_class t on t.oid = c.conrelid where t.relname = $1 and c.contype = 'c'`,
    [table]
  );
  return rows.map((r) => r.def).join('\n');
}

test('every catalog field exists with a matching type, nullability and generation', async () => {
  for (const key of ENTITY_KEYS) {
    const entity = CATALOG[key];
    const cols = await columns(entity.table);
    assert.ok(cols.size > 0, `table ${entity.table} exists`);
    for (const field of entity.fields) {
      if (field.calculated === 'engine') {
        assert.ok(!cols.has(field.key), `${key}.${field.key} is computed by the engine, not stored`);
        continue;
      }
      const col = cols.get(field.key);
      assert.ok(col, `${entity.table}.${field.key} exists`);
      assert.ok(PG_TYPES[field.type].includes(col.data_type), `${entity.table}.${field.key}: ${field.type} vs ${col.data_type}`);
      assert.equal(col.is_nullable === 'YES', field.nullable, `${entity.table}.${field.key} nullability`);
      assert.equal(col.is_generated === 'ALWAYS', field.calculated === 'database', `${entity.table}.${field.key} generated`);
    }
  }
});

test('enum fields list exactly the values the database accepts', async () => {
  for (const key of ENTITY_KEYS) {
    const entity = CATALOG[key];
    const cols = await columns(entity.table);
    for (const field of entity.fields.filter((f) => f.type === 'enum')) {
      const col = cols.get(field.key);
      if (col.data_type === 'USER-DEFINED') {
        assert.deepEqual([...field.enumValues].sort(), (await enumLabels(col.udt_name)).sort(), `${entity.table}.${field.key}`);
      } else {
        const checks = await checkConstraints(entity.table);
        for (const v of field.enumValues) assert.ok(checks.includes(`'${v}'`), `${entity.table}.${field.key} allows ${v}`);
      }
    }
  }
});

test('every relation is a real foreign key to the target record id', async () => {
  const { rows } = await db.query(
    `select tc.table_name, kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_column
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`
  );
  const fks = new Set(rows.map((r) => `${r.table_name}.${r.column_name}->${r.ref_table}.${r.ref_column}`));
  for (const key of ENTITY_KEYS) {
    const entity = CATALOG[key];
    for (const rel of entity.relations) {
      const target = CATALOG[rel.target];
      assert.ok(fks.has(`${entity.table}.${rel.column}->${target.table}.id`), `${entity.table}.${rel.column} → ${target.table}.id`);
      assert.ok(entity.fields.some((f) => f.key === rel.column && f.references === rel.target), `${key}.${rel.column} references ${rel.target}`);
    }
  }
});

test('every catalog table can be scoped to a workspace and has row-level security', async () => {
  for (const key of ENTITY_KEYS) {
    const entity = CATALOG[key];
    const scopeTable = entity.scopeVia ? CATALOG[getRelation(key, entity.scopeVia).target].table : entity.table;
    const cols = await columns(scopeTable);
    assert.ok(cols.has('user_id') && cols.has('workspace_id'), `${key} is scoped through ${scopeTable}`);
    if (!entity.scopeVia) assert.ok(!(await columns(entity.table)).has('scope'), `${entity.table} has no column named like the scope alias`);
    const { rows } = await db.query(`select relrowsecurity from pg_class where relname = $1`, [entity.table]);
    assert.equal(rows[0].relrowsecurity, true, `${entity.table} has RLS enabled`);
    const policies = await db.query(`select count(*)::int as n from pg_policies where tablename = $1 and cmd in ('SELECT', 'ALL')`, [entity.table]);
    assert.ok(policies.rows[0].n > 0, `${entity.table} has a read policy`);
  }
});

test('columns missing from the catalog are excluded on purpose', async () => {
  for (const key of ENTITY_KEYS) {
    for (const column of (await columns(CATALOG[key].table)).keys()) {
      assert.notEqual(excludedFieldReason(key, column), 'unknown', `${CATALOG[key].table}.${column} must be catalogued or excluded`);
    }
  }
});
