import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Reference data the migrations create on both sides (currencies, PPh 21 TER rates) is not copied.
export const SKIP_TABLES = new Set(['api_rate_limits', 'erp_currencies', 'erp_hr_ter_rates']);

const quote = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

export async function listTables(client) {
  const { rows } = await client.query(
    `select c.relname as table_name, a.attname as column_name, a.attgenerated <> '' as generated,
            coalesce((select array_position(i.indkey::int2[], a.attnum)
                        from pg_index i where i.indrelid = c.oid and i.indisprimary), 0) as pk_position
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname, a.attnum`
  );
  const tables = new Map();
  for (const row of rows) {
    if (SKIP_TABLES.has(row.table_name)) continue;
    const table = tables.get(row.table_name) ?? {
      name: row.table_name,
      columns: [],
      primaryKey: [],
    };
    table.columns.push({ name: row.column_name, generated: row.generated === true });
    if (Number(row.pk_position) > 0)
      table.primaryKey[Number(row.pk_position) - 1] = row.column_name;
    tables.set(row.table_name, table);
  }
  for (const table of tables.values()) table.primaryKey = table.primaryKey.filter(Boolean);
  return [...tables.values()];
}

async function columnsOf(client, schema, table) {
  const { rows } = await client.query(
    `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
    [schema, table]
  );
  return new Set(rows.map((r) => r.column_name));
}

export async function readTable(client, table, onBatch, batchSize = 2000) {
  const order = table.primaryKey.length ? table.primaryKey.map(quote).join(', ') : 'ctid';
  for (let offset = 0; ; offset += batchSize) {
    const { rows } = await client.query(
      `select row_to_json(t)::text as j from (select * from public.${quote(table.name)} order by ${order} limit ${batchSize} offset ${offset}) t`
    );
    if (rows.length === 0) return;
    await onBatch(rows.map((r) => r.j));
    if (rows.length < batchSize) return;
  }
}

export async function readAuth(client) {
  const userCols = await columnsOf(client, 'auth', 'users');
  // Columns a Supabase project has but a minimal auth schema may lack.
  const col = (name, fallback = 'null') => (userCols.has(name) ? name : fallback);
  await client.query(`set timezone = 'UTC'`);
  // Everything as text (UTC), so timestamps keep their microseconds and JSON its digits.
  const users = (
    await client.query(
      `select id::text as id, email, encrypted_password,
            (${col('raw_user_meta_data', `'{}'::jsonb`)})::text as raw_user_meta_data,
            (${col('email_confirmed_at')})::text as email_confirmed_at,
            created_at::text as created_at,
            (${col('updated_at', 'created_at')})::text as updated_at,
            (${col('last_sign_in_at')})::text as last_sign_in_at,
            (${col('banned_until')})::text as banned_until
       from auth.users order by created_at, id`
    )
  ).rows;

  const factorCols = await columnsOf(client, 'auth', 'mfa_factors');
  const secretColumn = factorCols.has('secret_enc')
    ? 'secret_enc'
    : factorCols.has('secret')
      ? 'secret'
      : null;
  const factors =
    factorCols.size === 0
      ? []
      : (
          await client.query(
            `select id::text as id, user_id::text as user_id, friendly_name, factor_type::text as factor_type, status::text as status,
            ${secretColumn ? `${secretColumn}::text` : 'null'} as secret, created_at::text as created_at, updated_at::text as updated_at
       from auth.mfa_factors order by created_at, id`
          )
        ).rows.map((f) => ({
          ...f,
          secret_kind: secretColumn === 'secret_enc' ? 'sealed' : 'plain',
        }));
  return { users, factors };
}

export async function tableChecksums(client, tables, sharedColumns) {
  await client.query(`set timezone = 'UTC'`);
  const out = {};
  for (const table of tables) {
    const cols = (sharedColumns?.get(table.name) ?? table.columns.map((c) => c.name))
      .slice()
      .sort();
    const order = table.primaryKey.length
      ? table.primaryKey.map((c) => `t.${quote(c)}`).join(', ')
      : cols.map((c) => `t.${quote(c)}::text`).join(', ');
    const text = cols.map((c) => `coalesce(t.${quote(c)}::text, '\\N')`).join(` || '|' || `);
    const { rows } = await client.query(
      `select count(*)::bigint as n, md5(coalesce(string_agg(md5(${text || `''`}), '' order by ${order}), '')) as sum
         from public.${quote(table.name)} t`
    );
    out[table.name] = { rows: Number(rows[0].n), checksum: rows[0].sum };
  }
  return out;
}

export async function authSummary(client) {
  const { rows } = await client.query(
    `select (select count(*) from auth.users)::int as users,
            (select md5(coalesce(string_agg(id::text || lower(email), ',' order by id), '')) from auth.users) as users_checksum,
            (select count(*) from auth.mfa_factors where status::text = 'verified')::int as devices`
  );
  return rows[0];
}

// ─── Import ──────────────────────────────────────────────────────────────────

const BASE32 = /^[A-Z2-7]+=*$/;

export async function importData(
  client,
  data,
  { sealSecret, unportableMfa = 'lock', log = () => {} } = {}
) {
  const report = {
    users: 0,
    usersWithoutPassword: 0,
    skippedUsers: 0,
    devices: 0,
    unportableDevices: 0,
    lockedUsers: 0,
    tables: {},
  };
  await client.query('BEGIN');
  try {
    const { rows: meta } = await client.query(
      `select to_regclass('etna_meta.schema_migrations') is not null as migrated`
    );
    if (!meta[0]?.migrated)
      throw new Error('Target is not an ETNA database prepared with scripts/db/migrate.mjs');
    const { rows: existing } = await client.query(
      'select (select count(*) from auth.users)::int as users'
    );
    if (existing[0].users > 0)
      throw new Error('Target already has users; import only into an empty database');

    await client.query(`set local session_replication_role = replica`);
    await client.query(`set local timezone = 'UTC'`);

    const lockedIds = new Set();
    const importedIds = new Set();
    for (const u of data.auth.users) {
      if (!u.email) {
        report.skippedUsers += 1;
        continue;
      }
      await client.query(
        `insert into auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, created_at, updated_at, last_sign_in_at, banned_until)
         values ($1, $2, nullif($3, ''), coalesce($4::jsonb, '{}'::jsonb), $5, coalesce($6, now()), coalesce($7, $6, now()), $8, $9)`,
        [
          u.id,
          u.email,
          u.encrypted_password,
          u.raw_user_meta_data,
          u.email_confirmed_at,
          u.created_at,
          u.updated_at,
          u.last_sign_in_at,
          u.banned_until,
        ]
      );
      importedIds.add(u.id);
      report.users += 1;
      if (!u.encrypted_password) report.usersWithoutPassword += 1;
    }

    for (const f of data.auth.factors) {
      if (!importedIds.has(f.user_id)) continue;
      let sealed = null;
      if (f.secret_kind === 'sealed' && f.secret) sealed = f.secret;
      else if (f.secret_kind === 'plain' && f.secret && BASE32.test(f.secret.trim()) && sealSecret)
        sealed = sealSecret(f.secret.trim());
      if (!sealed) {
        if (f.status === 'verified') {
          report.unportableDevices += 1;
          if (unportableMfa === 'lock') lockedIds.add(f.user_id);
        }
        continue;
      }
      await client.query(
        `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret_enc, created_at, updated_at)
         values ($1, $2, $3, 'totp', $4, $5, $6, $7)`,
        [
          f.id,
          f.user_id,
          f.friendly_name,
          f.status === 'verified' ? 'verified' : 'unverified',
          sealed,
          f.created_at,
          f.updated_at,
        ]
      );
      if (f.status === 'verified') report.devices += 1;
    }
    for (const id of lockedIds) {
      await client.query(
        `update auth.users set banned_until = '9999-12-31T00:00:00Z' where id = $1`,
        [id]
      );
      report.lockedUsers += 1;
    }

    const targetTables = new Map((await listTables(client)).map((t) => [t.name, t]));
    for (const [name, rows] of data.tables) {
      const table = targetTables.get(name);
      if (!table) throw new Error(`Table ${name} does not exist on the target`);
      const writable = new Set(table.columns.filter((c) => !c.generated).map((c) => c.name));
      // Parse only to learn the column names; the original text is what gets sent.
      const present = new Set(rows.flatMap((r) => Object.keys(JSON.parse(r))));
      // Never drop data silently: every source column must exist on the target.
      const known = new Set(table.columns.map((c) => c.name));
      const missing = [...present].filter((c) => !known.has(c));
      if (missing.length)
        throw new Error(
          `Target table ${name} lacks column(s) ${missing.join(', ')}; apply the same migrations first`
        );
      const cols = [...writable].filter((c) => present.has(c));
      for (let i = 0; i < rows.length; i += 1000) {
        const batch = rows.slice(i, i + 1000);
        const list = cols.map(quote).join(', ');
        await client.query(
          `insert into public.${quote(name)} (${list}) select ${list} from json_populate_recordset(null::public.${quote(name)}, $1::json)`,
          ['[' + batch.join(',') + ']']
        );
      }
      report.tables[name] = rows.length;
      log(`imported ${name}: ${rows.length}`);
    }

    // Sequences behind serial/identity columns continue after the imported ids.
    const { rows: seqs } = await client.query(
      `select s.seqrelid::regclass::text as seq, c.relname as table_name, a.attname as column_name
         from pg_sequence s
         join pg_depend d on d.objid = s.seqrelid and d.deptype in ('a', 'i')
         join pg_class c on c.oid = d.refobjid
         join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
         join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid`
    );
    for (const s of seqs) {
      await client.query(
        `select setval($1::regclass, greatest(coalesce((select max(${quote(s.column_name)}) from public.${quote(s.table_name)}), 0), 1), (select count(*) > 0 from public.${quote(s.table_name)}))`,
        [s.seq]
      );
    }

    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function orphanCheck(client) {
  const { rows: fks } = await client.query(
    `select con.conname, cl.relname as table_name, rl.relname as ref_table,
            array(select a.attname::text from unnest(con.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by o)::text[] as cols,
            array(select a.attname::text from unnest(con.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by o)::text[] as ref_cols,
            rn.nspname as ref_schema
       from pg_constraint con
       join pg_class cl on cl.oid = con.conrelid join pg_namespace n on n.oid = cl.relnamespace
       join pg_class rl on rl.oid = con.confrelid join pg_namespace rn on rn.oid = rl.relnamespace
      where con.contype = 'f' and n.nspname = 'public'`
  );
  const problems = [];
  for (const fk of fks) {
    const join = fk.cols.map((c, i) => `r.${quote(fk.ref_cols[i])} = t.${quote(c)}`).join(' and ');
    const notNull = fk.cols.map((c) => `t.${quote(c)} is not null`).join(' and ');
    const { rows } = await client.query(
      `select count(*)::int as n from public.${quote(fk.table_name)} t
        where ${notNull} and not exists (select 1 from ${quote(fk.ref_schema)}.${quote(fk.ref_table)} r where ${join})`
    );
    if (rows[0].n > 0)
      problems.push({ constraint: fk.conname, table: fk.table_name, rows: rows[0].n });
  }
  return problems;
}

export function encryptBuffer(plain, passphrase) {
  if (!passphrase || passphrase.length < 16)
    throw new Error('Use a passphrase of at least 16 characters');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('ETNA1'), salt, iv, body, cipher.getAuthTag()]);
}

export function decryptBuffer(file, passphrase) {
  if (file.subarray(0, 5).toString() !== 'ETNA1') throw new Error('Not an ETNA export file');
  const salt = file.subarray(5, 21);
  const iv = file.subarray(21, 33);
  const tag = file.subarray(file.length - 16);
  const body = file.subarray(33, file.length - 16);
  const key = scryptSync(passphrase, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
