// TERMINAL intelligence for the app's routes (P3, 20261012000049): AI
// providers and keys (sealed here, never read back), data policies, the
// budget, the disclosure shown before a run, insights and their review, and
// what each dataset holds (ontology).

import {
  AI_KIND_DEFS,
  costOf,
  estimateTokens,
  isAiKind,
  parseAiConfig,
} from '@/lib/terminal/aiProviders';
import {
  parseInsightInput,
  planSharing,
  type ColumnInfo,
  type PolicyRow,
} from '@/lib/terminal/insights';
import { sealJson } from '@/server/vault';
import type { SqlTx } from '@/server/db/executor';
import { listDatasets, loadDataset, visibleColumns } from './datasets';
import { TerminalError, asUser, isUuid } from './session';
import type { TerminalContext } from './service';

const run = <T>(ctx: TerminalContext, fn: (tx: SqlTx) => Promise<T>) =>
  asUser(ctx.executor, ctx.identity, '/terminal/ai', fn);
const uuid = (v: unknown) => {
  if (!isUuid(v)) throw new TerminalError('invalid');
  return v;
};
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** Everything the AI screens show: providers, policies, budget, this month's use, datasets. */
export async function aiOverview(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) => {
    const providers = (
      await tx.query(
        `SELECT id, kind, name, config, allow_personal_keys, enabled, has_secret, status, last_error_key, last_tested_at,
                public.ps_has_ai_personal_key(id) AS my_key
           FROM public.ps_ai_providers WHERE workspace_id = $1 ORDER BY lower(name)`,
        [ws]
      )
    ).rows.map((p: any) => ({ ...p, last_tested_at: iso(p.last_tested_at) }));
    const policies = (
      await tx.query(
        'SELECT provider_id, dataset_id, allowed, sensitive_columns, sample_rows FROM public.ps_ai_policies WHERE workspace_id = $1',
        [ws]
      )
    ).rows;
    const budget = (await tx.query('SELECT public.ps_ai_budget($1) AS b', [ws])).rows[0].b;
    const usage = (
      await tx.query(
        `SELECT provider_name, personal_key, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens,
                sum(cost)::text AS cost, count(*)::int AS calls
           FROM public.ps_ai_usage
          WHERE workspace_id = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'
          GROUP BY 1, 2 ORDER BY 1`,
        [ws]
      )
    ).rows.map((u: any) => ({ ...u, cost: Number(u.cost) }));
    const datasets = (await listDatasets(tx, ws)).map((d) => ({
      id: d.id,
      name: d.name,
      folder: d.folder,
      columns: visibleColumns(d).map((c) => ({
        label: c.label,
        type: c.type,
        sensitive: c.sensitive,
      })),
    }));
    const role = (await tx.query('SELECT public.erp_workspace_role($1) AS r', [ws])).rows[0].r;
    return { providers, policies, budget, usage, datasets, isOwner: role === 'owner' };
  });
}

export async function saveProvider(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  const kind = body.kind;
  if (!isAiKind(kind)) throw new TerminalError('invalid');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) throw new TerminalError('fieldRequired', { field: 'name' });
  const config = parseAiConfig(kind, body.config ?? {});
  if ('field' in config) throw new TerminalError('fieldInvalid', { field: config.field });
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (key.length > 4000) throw new TerminalError('fieldInvalid', { field: 'key' });
  const isNew = !isUuid(body.id);
  if (isNew && !key && AI_KIND_DEFS[kind].key === 'required')
    throw new TerminalError('fieldRequired', { field: 'key' });
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      'SELECT public.ps_save_ai_provider($1, $2, $3, $4, $5::jsonb, $6, $7, $8) AS id',
      [
        ws,
        isNew ? null : body.id,
        body.kind,
        name,
        JSON.stringify(config),
        body.allowPersonal === true,
        body.enabled !== false,
        key ? sealJson({ api_key: key }) : null,
      ]
    );
    const id = rows[0].id as string;
    await tx.query(`SELECT public.ps_enqueue_job($1, 'ai.test', $2::jsonb)`, [
      ws,
      JSON.stringify({ provider_id: id }),
    ]);
    return { id };
  });
}

export async function deleteProvider(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) => tx.query('SELECT public.ps_delete_ai_provider($1)', [uuid(body.id)]));
}

export async function testProvider(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      'SELECT workspace_id FROM public.ps_ai_providers WHERE id = $1',
      [id]
    );
    if (!rows[0]) throw new TerminalError('notFound');
    const job = await tx.query(`SELECT public.ps_enqueue_job($1, 'ai.test', $2::jsonb) AS id`, [
      rows[0].workspace_id,
      JSON.stringify({ provider_id: id }),
    ]);
    return { jobId: job.rows[0].id as string };
  });
}

export async function setPersonalKey(ctx: TerminalContext, body: any) {
  const id = uuid(body.providerId);
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (key.length > 4000) throw new TerminalError('fieldInvalid', { field: 'key' });
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_set_ai_personal_key($1, $2)', [
      id,
      key ? sealJson({ api_key: key }) : null,
    ])
  );
}

export async function setPolicy(ctx: TerminalContext, body: any) {
  const sensitive = Array.isArray(body.sensitiveColumns)
    ? body.sensitiveColumns.filter((x: unknown) => typeof x === 'string').slice(0, 200)
    : [];
  const sample = Number(body.sampleRows ?? 0);
  if (!Number.isInteger(sample) || sample < 0 || sample > 200)
    throw new TerminalError('fieldInvalid', { field: 'sampleRows' });
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_set_ai_policy($1, $2, $3, $4::text[], $5)', [
      uuid(body.providerId),
      uuid(body.datasetId),
      body.allowed === true,
      sensitive,
      sample,
    ])
  );
}

export async function setSettings(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  const limit =
    body.monthlyLimit === '' || body.monthlyLimit == null ? null : Number(body.monthlyLimit);
  if (limit !== null && (!Number.isFinite(limit) || limit < 0 || limit > 1e11))
    throw new TerminalError('fieldInvalid', { field: 'monthlyLimit' });
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) throw new TerminalError('fieldInvalid', { field: 'currency' });
  const people =
    body.peopleDecisions === 'automate'
      ? 'automate'
      : body.peopleDecisions === 'review'
        ? 'review'
        : null;
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_set_ai_settings($1, $2, $3, $4)', [ws, limit, currency, people])
  );
}

/**
 * What a run would do, shown before it starts: the statistics, and for a
 * narrative the provider, model, columns and sensitive columns it would see,
 * sample rows, the estimated cost and the budget left — or why it may not.
 */
async function disclosureOf(tx: SqlTx, body: any) {
  const ds = await loadDataset(tx, body.datasetId);
  const ok = await tx.query(`SELECT public.ps_can_access_dataset($1, 'query') AS ok`, [ds.id]);
  if (ok.rows[0].ok !== true) throw new TerminalError('forbidden');
  const columns: ColumnInfo[] = visibleColumns(ds).map((c) => ({
    label: c.label,
    type: c.type,
    sensitive: c.sensitive,
  }));
  const input = parseInsightInput(body, columns);
  if ('problem' in input) throw new TerminalError('fieldInvalid', { field: input.problem });
  if (!input.provider_id) return { ds, input, ai: null };
  const { rows } = await tx.query(
    `SELECT p.id, p.name, p.kind, p.config, p.enabled, p.allow_personal_keys, public.ps_has_ai_personal_key(p.id) AS my_key,
            pol.allowed, pol.sensitive_columns, pol.sample_rows
       FROM public.ps_ai_providers p
       LEFT JOIN public.ps_ai_policies pol ON pol.provider_id = p.id AND pol.dataset_id = $2
      WHERE p.id = $1 AND p.workspace_id = $3`,
    [input.provider_id, ds.id, ds.workspaceId]
  );
  const p = rows[0];
  if (!p) throw new TerminalError('notFound');
  const policy: PolicyRow | null =
    p.allowed === null
      ? null
      : { allowed: p.allowed, sensitive_columns: p.sensitive_columns, sample_rows: p.sample_rows };
  const plan = planSharing(columns, policy, input);
  const config = isAiKind(p.kind) ? parseAiConfig(p.kind, p.config) : { field: 'kind' };
  const budget = (await tx.query('SELECT public.ps_ai_budget($1) AS b', [ds.workspaceId])).rows[0]
    .b;
  // A rough size: the evidence of a series, or of the shared columns' profiles.
  const shared = plan.ok ? plan.columns.length : 0;
  const tokens =
    900 +
    (input.kind === 'profile' ? 120 * shared : 1200) +
    (plan.ok ? plan.sampleRows * 20 * Math.max(1, shared) : 0);
  const cost = 'field' in config ? 0 : costOf(config, tokens, config.max_output_tokens);
  let reason: string | null = null;
  if (!p.enabled) reason = 'aiProviderOff';
  else if (!plan.ok) reason = plan.reason;
  else if (input.personal && !(p.allow_personal_keys && p.my_key)) reason = 'aiNoPersonalKey';
  else if (!input.personal && budget.limit === null) reason = 'aiNoBudget';
  else if (!input.personal && Number(budget.spent) + cost > Number(budget.limit))
    reason = 'aiBudgetExceeded';
  else if (!('field' in config) && tokens + config.max_output_tokens > config.context_tokens)
    reason = 'aiTooLarge';
  return {
    ds,
    input,
    ai: {
      provider: p.name,
      kind: p.kind,
      model: 'field' in config ? null : config.model,
      columns: plan.ok ? plan.columns : [],
      sensitive: plan.ok ? plan.sensitive : [],
      excluded: plan.ok ? plan.excluded : [],
      sampleRows: plan.ok ? plan.sampleRows : 0,
      estimatedTokens: tokens,
      estimatedCost: Math.round(cost * 1e6) / 1e6,
      personal: input.personal,
      budget,
      allowed: reason === null,
      reason,
    },
  };
}

export async function discloseInsight(ctx: TerminalContext, body: any) {
  return run(ctx, async (tx) => {
    const d = await disclosureOf(tx, body);
    return { dataset: d.ds.name, rows: d.ds.rowCount, input: d.input, ai: d.ai };
  });
}

export async function createInsight(ctx: TerminalContext, body: any) {
  return run(ctx, async (tx) => {
    const d = await disclosureOf(tx, body);
    // The person saw the disclosure; a narrative that is not allowed is not attempted.
    if (d.ai && !d.ai.allowed) throw new TerminalError(d.ai.reason ?? 'aiNotAllowed');
    const title =
      d.input.kind === 'profile'
        ? d.ds.name
        : `${d.ds.name}: ${d.input.measure} ${d.input.value_column ?? ''} / ${d.input.period}`.replace(
            /\s+/g,
            ' '
          );
    const { rows } = await tx.query(
      'SELECT public.ps_start_decision($1, $2, $3, $4::jsonb) AS id',
      [d.ds.id, d.input.kind, title, JSON.stringify({ ...d.input, disclosure: d.ai })]
    );
    const id = rows[0].id as string;
    const job = await tx.query(`SELECT public.ps_enqueue_job($1, 'ai.analyze', $2::jsonb) AS id`, [
      d.ds.workspaceId,
      JSON.stringify({ decision_id: id, input: d.input }),
    ]);
    return { id, jobId: job.rows[0].id as string };
  });
}

const DECISION_COLUMNS = `d.id, d.dataset_id, ds.name AS dataset_name, d.kind, d.title, d.status, d.error_key, d.method,
  d.confidence::float AS confidence, d.narrative_provider, d.narrative_model, d.about_people, d.review_status, d.review_note,
  d.reviewed_at, d.created_at, d.finished_at, d.created_by = auth.uid() AS mine, d.created_by, d.reviewed_by`;

/**
 * Members' names by id. Profiles are readable only by their own person; the
 * member list (any member may read it) gives the others' names.
 */
async function memberNames(tx: SqlTx, ws: string): Promise<Map<string, string>> {
  const { rows } = await tx.query(
    `SELECT user_id, COALESCE(NULLIF(full_name, ''), email) AS name FROM public.erp_list_workspace_members($1)`,
    [ws]
  );
  return new Map(rows.map((r: any) => [r.user_id as string, r.name as string]));
}

const decisionOf = (r: any, names: Map<string, string>) => {
  const { created_by, reviewed_by, ...rest } = r;
  return {
    ...rest,
    created_by_name: names.get(created_by) ?? null,
    reviewed_by_name: reviewed_by ? (names.get(reviewed_by) ?? null) : null,
    reviewed_at: iso(r.reviewed_at),
    created_at: iso(r.created_at),
    finished_at: iso(r.finished_at),
  };
};

export async function listInsights(ctx: TerminalContext, body: any) {
  const ws = uuid(body.workspaceId);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT ${DECISION_COLUMNS} FROM public.ps_decisions d LEFT JOIN public.ps_datasets ds ON ds.id = d.dataset_id
        WHERE d.workspace_id = $1 ORDER BY d.created_at DESC LIMIT 200`,
      [ws]
    );
    const names = await memberNames(tx, ws);
    return rows.map((r: any) => decisionOf(r, names));
  });
}

export async function getInsight(ctx: TerminalContext, body: any) {
  const id = uuid(body.id);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      `SELECT ${DECISION_COLUMNS}, d.workspace_id, d.inputs, d.evidence, d.output, d.narrative
         FROM public.ps_decisions d LEFT JOIN public.ps_datasets ds ON ds.id = d.dataset_id WHERE d.id = $1`,
      [id]
    );
    if (!rows[0]) throw new TerminalError('notFound');
    const { workspace_id, ...row } = rows[0];
    return decisionOf(row, await memberNames(tx, workspace_id));
  });
}

const note = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 2000) : '');

export async function requestReview(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_request_review($1, $2)', [uuid(body.id), note(body.note) || null])
  );
}

export async function reviewInsight(ctx: TerminalContext, body: any) {
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_review_decision($1, $2)', [uuid(body.id), note(body.note) || null])
  );
}

// ─── Ontology ────────────────────────────────────────────────────────────────

export async function getEntity(ctx: TerminalContext, body: any) {
  const id = uuid(body.datasetId);
  return run(ctx, async (tx) => {
    const { rows } = await tx.query(
      'SELECT entity_type, label, key_column, about_people, relations FROM public.ps_dataset_entities WHERE dataset_id = $1',
      [id]
    );
    return rows[0] ?? null;
  });
}

const TYPE_RE = /^[A-Za-z][A-Za-z0-9_]{1,40}$/;

export async function setEntity(ctx: TerminalContext, body: any) {
  const id = uuid(body.datasetId);
  const type = body.entityType == null || body.entityType === '' ? null : String(body.entityType);
  if (type !== null && !TYPE_RE.test(type))
    throw new TerminalError('fieldInvalid', { field: 'entityType' });
  const relations = (Array.isArray(body.relations) ? body.relations : [])
    .slice(0, 30)
    .map((r: any) => {
      const out: Record<string, string> = { column: String(r?.column ?? '').slice(0, 120) };
      if (isUuid(r?.target_dataset)) out.target_dataset = r.target_dataset;
      if (typeof r?.target_type === 'string' && TYPE_RE.test(r.target_type))
        out.target_type = r.target_type;
      return out;
    });
  await run(ctx, (tx) =>
    tx.query('SELECT public.ps_set_dataset_entity($1, $2, $3, $4, $5, $6::jsonb)', [
      id,
      type,
      typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null,
      typeof body.keyColumn === 'string' && body.keyColumn ? body.keyColumn : null,
      body.aboutPeople === true,
      JSON.stringify(relations),
    ])
  );
}
