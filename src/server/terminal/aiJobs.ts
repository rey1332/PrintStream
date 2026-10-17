// Terminal AI jobs in the worker (P3, 20261012000049):
//  * ai.test: one tiny call to a provider, to check its address, key and model;
//  * ai.analyze: an insight. The statistical core reads the dataset as the
//    person (row-level security and masking apply) and records its evidence;
//    then, when a provider was chosen, the data policy, the budget and the
//    key decide whether it may write a narrative. What is sent is aggregates
//    and profiles (plus sample rows only where a policy allows them); every
//    call is metered and in the data-access log.

import {
  AI_KIND_DEFS,
  costOf,
  estimateTokens,
  isAiKind,
  parseAiConfig,
  type AiConfig,
} from '@/lib/terminal/aiProviders';
import {
  PEOPLE_TYPES,
  buildPrompt,
  parseNarrative,
  planSharing,
  type ColumnInfo,
  type EvidenceItem,
  type InsightInput,
  type PolicyRow,
} from '@/lib/terminal/insights';
import {
  STATS_METHOD,
  anomalyConfidence,
  describe as describeValues,
  forecastConfidence,
  holtForecast,
  linearTrend,
  robustAnomalies,
  type Point,
} from '@/lib/terminal/stats';
import { complete } from '@/server/ai/providers';
import { GuardedHttp } from '@/server/connectors/http';
import type { Executor, SqlTx } from '@/server/db/executor';
import { openJson } from '@/server/vault';
import { loadDataset, viewOf, visibleColumns, type DatasetInfo } from './datasets';
import { TerminalError, asUser, type RequestIdentity } from './session';

type Db = (sql: string, params?: unknown[]) => Promise<any[]>;

export interface AiJobEnv {
  db: Db;
  executor: Executor;
  identity: RequestIdentity;
  beat: () => Promise<boolean>;
  /** Started by the person themselves (personal keys only then). */
  manual: boolean;
}

const PATH = '/terminal/ai';

interface ProviderRow {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  allow_personal_keys: boolean;
  secret: string | null;
  personal_secret: string | null;
  private_hosts: string[];
  local_endpoints: string[];
  budget: { limit: string | number | null; spent: string | number };
}

async function providerOf(
  env: AiJobEnv,
  id: unknown
): Promise<Omit<ProviderRow, 'config'> & { config: AiConfig }> {
  const [row] = await env.db('select ps_worker.ai_provider_get($1, $2) as p', [
    id,
    env.identity.userId,
  ]);
  const p = row?.p as ProviderRow | undefined;
  if (!p || !isAiKind(p.kind)) throw new TerminalError('notFound');
  const config = parseAiConfig(p.kind, p.config);
  if ('field' in config) throw new TerminalError('fieldInvalid', { field: config.field });
  return { ...p, config };
}

function targetOf(p: Omit<ProviderRow, 'config'> & { config: AiConfig }, personal: boolean) {
  const sealed = personal ? p.personal_secret : p.secret;
  if (personal && !sealed) throw new TerminalError('aiNoPersonalKey');
  const key = sealed ? String(openJson<{ api_key?: string }>(sealed).api_key ?? '') || null : null;
  if (!key && AI_KIND_DEFS[p.kind as keyof typeof AI_KIND_DEFS].key === 'required')
    throw new TerminalError('aiNoKey');
  return {
    kind: p.kind as keyof typeof AI_KIND_DEFS,
    config: p.config,
    key,
    http: new GuardedHttp({
      privateHosts: p.private_hosts ?? [],
      localEndpoints: p.local_endpoints ?? [],
      rate: 2,
    }),
  };
}

/** The person must still be allowed to manage connections (tests cost money too). */
export async function testProvider(env: AiJobEnv, payload: any) {
  const p = await providerOf(env, payload.provider_id);
  await asUser(env.executor, env.identity, PATH, async (tx) => {
    const { rows } = await tx.query(
      `select public.erp_has_permission($1, 'integrations.manage') as ok`,
      [p.workspace_id]
    );
    if (rows[0].ok !== true) throw new TerminalError('forbidden');
  });
  try {
    const out = await complete(targetOf(p, false), {
      system: 'Reply with the single word OK.',
      user: 'OK?',
      maxTokens: 16,
      json: false,
    });
    await env.db('select ps_worker.ai_usage_record($1, $2, null, false, $3, $4, $5, $6::jsonb)', [
      p.id,
      env.identity.userId,
      out.inputTokens,
      out.outputTokens,
      costOf(p.config, out.inputTokens, out.outputTokens),
      JSON.stringify({ test: true }),
    ]);
    await env.db('select ps_worker.ai_provider_tested($1, true, null)', [p.id]);
    return { ok: true, reply: out.text.slice(0, 40) };
  } catch (error) {
    const code = error instanceof TerminalError ? error.code : 'failed';
    await env
      .db('select ps_worker.ai_provider_tested($1, false, $2)', [p.id, code])
      .catch(() => undefined);
    throw error;
  }
}

// ─── Reading the dataset (as the person) ─────────────────────────────────────

const STEP: Record<string, (d: Date) => void> = {
  day: (d) => d.setUTCDate(d.getUTCDate() + 1),
  week: (d) => d.setUTCDate(d.getUTCDate() + 7),
  month: (d) => d.setUTCMonth(d.getUTCMonth() + 1),
  quarter: (d) => d.setUTCMonth(d.getUTCMonth() + 3),
};

/** Periods without rows count as 0 for sums and counts (other measures skip them). */
export function fillGaps(points: Point[], period: string, measure: string): Point[] {
  if (points.length < 2 || (measure !== 'sum' && measure !== 'count')) return points;
  const have = new Map(points.map((x) => [x.p, x.v]));
  const out: Point[] = [];
  const d = new Date(`${points[0].p}T00:00:00Z`);
  const last = points[points.length - 1].p;
  for (let i = 0; i < 5000; i += 1) {
    const p = d.toISOString().slice(0, 10);
    out.push({ p, v: have.get(p) ?? 0 });
    if (p >= last) break;
    STEP[period](d);
  }
  return out;
}

async function readSeries(tx: SqlTx, ds: DatasetInfo, input: InsightInput): Promise<Point[]> {
  const cols = visibleColumns(ds);
  const date = cols.find((c) => c.label === input.date_column);
  const value = cols.find((c) => c.label === input.value_column);
  if (!date || (input.value_column && !value)) throw new TerminalError('invalid');
  const d =
    date.type === 'timestamp'
      ? `("${date.physical}" AT TIME ZONE 'Asia/Jakarta')`
      : `"${date.physical}"::timestamp`;
  const v = value ? `"${value.physical}"::numeric` : null;
  const agg = input.measure === 'count' ? 'count(*)' : `${input.measure}(${v})`;
  const { rows } = await tx.query(
    `SELECT to_char(date_trunc($1, ${d}), 'YYYY-MM-DD') AS p, ${agg}::text AS v
       FROM ${viewOf(ds)} WHERE "${date.physical}" IS NOT NULL${v ? ` AND ${v} IS NOT NULL` : ''}
      GROUP BY 1 ORDER BY 1 LIMIT 5000`,
    [input.period]
  );
  return rows
    .map((r: any) => ({ p: r.p, v: Number(r.v) }))
    .filter((x: Point) => Number.isFinite(x.v));
}

async function readProfile(tx: SqlTx, ds: DatasetInfo) {
  const out: Record<string, unknown>[] = [];
  for (const c of visibleColumns(ds).slice(0, 60)) {
    const col = `"${c.physical}"`;
    const numeric = c.type === 'integer' || c.type === 'decimal';
    const ordered = numeric || c.type === 'date' || c.type === 'timestamp';
    const { rows } = await tx.query(
      `SELECT count(*)::text AS n, count(${col})::text AS filled, count(DISTINCT ${col})::text AS distinct_values
              ${ordered ? `, min(${col})::text AS min, max(${col})::text AS max` : ''}
              ${numeric ? `, avg(${col}::numeric)::text AS mean` : ''}
         FROM ${viewOf(ds)}`
    );
    const r = rows[0];
    const entry: Record<string, unknown> = {
      column: c.label,
      type: c.type,
      sensitive: c.sensitive,
      rows: Number(r.n),
      empty: Number(r.n) - Number(r.filled),
      distinct: Number(r.distinct_values),
    };
    if (ordered) Object.assign(entry, { min: r.min, max: r.max });
    if (numeric && r.mean !== null) entry.mean = Number(Number(r.mean).toFixed(4));
    if (c.type === 'text' && !c.sensitive) {
      const top = await tx.query(
        `SELECT ${col}::text AS v, count(*)::int AS n FROM ${viewOf(ds)} WHERE ${col} IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC LIMIT 5`
      );
      entry.top = top.rows.map((x: any) => ({ value: String(x.v).slice(0, 80), n: x.n }));
    }
    out.push(entry);
  }
  return out;
}

async function sampleRows(tx: SqlTx, ds: DatasetInfo, labels: string[], n: number) {
  if (!n) return [];
  const cols = visibleColumns(ds).filter((c) => labels.includes(c.label));
  if (!cols.length) return [];
  const { rows } = await tx.query(
    `SELECT ${cols.map((c) => `"${c.physical}"::text AS "${c.physical}"`).join(', ')} FROM ${viewOf(ds)} ORDER BY _id DESC LIMIT $1`,
    [n]
  );
  return rows.map((r: any) => Object.fromEntries(cols.map((c) => [c.label, r[c.physical]])));
}

// ─── The analysis ────────────────────────────────────────────────────────────

interface Analysis {
  method: string;
  evidence: EvidenceItem[];
  output: Record<string, unknown>;
  confidence: number;
}

export function analyzeSeries(points: Point[], input: InsightInput): Analysis {
  const values = points.map((x) => x.v);
  const stats = describeValues(values);
  const trend = linearTrend(values);
  const evidence: EvidenceItem[] = [
    {
      id: 'E1',
      label: 'periods',
      value: { count: points.length, first: points[0]?.p ?? null, last: points.at(-1)?.p ?? null },
    },
    { id: 'E2', label: `${input.measure} per ${input.period}: summary`, value: stats },
    { id: 'E3', label: 'linear trend per period', value: trend },
    { id: 'E4', label: 'last periods', value: points.slice(-12) },
  ];
  if (input.kind === 'forecast') {
    const f = holtForecast(values, input.horizon);
    const last = points.at(-1)?.p;
    const dates: string[] = [];
    if (last) {
      const d = new Date(`${last}T00:00:00Z`);
      for (let k = 0; k < input.horizon; k += 1) {
        STEP[input.period](d);
        dates.push(d.toISOString().slice(0, 10));
      }
    }
    const forecast = f.points.map((x, k) => ({ ...x, p: dates[k] ?? null }));
    evidence.push({ id: 'E5', label: 'forecast (95% interval)', value: forecast });
    evidence.push({
      id: 'E6',
      label: 'forecast accuracy on history',
      value: { rmse: f.rmse, mape: f.mape, alpha: f.alpha, beta: f.beta },
    });
    return {
      method: STATS_METHOD.forecast,
      evidence,
      output: { series: points, forecast, trend, stats },
      confidence: forecastConfidence(f, points.length),
    };
  }
  const anomalies = robustAnomalies(points);
  evidence.push({ id: 'E5', label: 'anomalies (modified z-score)', value: anomalies });
  return {
    method: STATS_METHOD.anomalies,
    evidence,
    output: { series: points, anomalies, trend, stats },
    confidence: anomalyConfidence(points.length),
  };
}

export async function runAnalysis(env: AiJobEnv, payload: any) {
  const decisionId = String(payload.decision_id ?? '');
  const input = payload.input as InsightInput;
  let ds: DatasetInfo | null = null;
  let analysis: Analysis | null = null;
  let entity: { entity_type: string; label: string | null; about_people: boolean } | null = null;
  let narrative: Record<string, unknown> | null = null;
  let providerName: string | null = null;
  let model: string | null = null;
  try {
    // 1. The statistical core, as the person.
    await asUser(env.executor, env.identity, PATH, async (tx) => {
      const { rows } = await tx.query(
        'SELECT dataset_id, status FROM public.ps_decisions WHERE id = $1',
        [decisionId]
      );
      if (!rows[0] || rows[0].status !== 'running') throw new TerminalError('notFound');
      ds = await loadDataset(tx, rows[0].dataset_id);
      const ok = await tx.query(`SELECT public.ps_can_access_dataset($1, 'query') AS ok`, [ds.id]);
      if (ok.rows[0].ok !== true) throw new TerminalError('forbidden');
      entity =
        (
          await tx.query(
            'SELECT entity_type, label, about_people FROM public.ps_dataset_entities WHERE dataset_id = $1',
            [ds.id]
          )
        ).rows[0] ?? null;
      if (input.kind === 'profile') {
        const profile = await readProfile(tx, ds);
        analysis = {
          method: STATS_METHOD.profile,
          evidence: profile.map((p, i) => ({
            id: `E${i + 1}`,
            label: `column ${String(p.column)}`,
            value: p,
          })),
          output: { profile, rows: ds.rowCount },
          confidence: 1,
        };
      } else {
        const points = fillGaps(await readSeries(tx, ds, input), input.period, input.measure);
        if (points.length < 3) throw new TerminalError('tooFewPoints');
        analysis = analyzeSeries(points, input);
      }
      await tx.query(
        `SELECT public.erp_log_data_access($1::uuid, 'dataset', $2, 'query', $3, '{}'::text[], null, $4::jsonb)`,
        [ds.workspaceId, ds.id, ds.rowCount, JSON.stringify({ name: ds.name, insight: input.kind })]
      );
    });
    const dataset = ds as unknown as DatasetInfo;
    const result = analysis as unknown as Analysis;
    const columns: ColumnInfo[] = visibleColumns(dataset).map((c) => ({
      label: c.label,
      type: c.type,
      sensitive: c.sensitive,
    }));
    const used = columns.filter(
      (c) => c.label === input.date_column || c.label === input.value_column
    );
    const ent = entity as {
      entity_type: string;
      label: string | null;
      about_people: boolean;
    } | null;
    const aboutPeople =
      !!ent?.about_people ||
      PEOPLE_TYPES.includes(String(ent?.entity_type ?? '').toLowerCase()) ||
      (input.kind === 'profile' ? columns.some((c) => c.sensitive) : used.some((c) => c.sensitive));

    // 2. The narrative, when a provider was chosen and everything allows it.
    if (input.provider_id) {
      try {
        if (input.personal && !env.manual) throw new TerminalError('aiNoPersonalKey');
        const p = await providerOf(env, input.provider_id);
        providerName = p.name;
        model = p.config.model;
        if (!p.enabled || p.workspace_id !== dataset.workspaceId)
          throw new TerminalError('aiProviderOff');
        const policy = await asUser(
          env.executor,
          env.identity,
          PATH,
          async (tx) =>
            (
              await tx.query(
                'SELECT allowed, sensitive_columns, sample_rows FROM public.ps_ai_policies WHERE provider_id = $1 AND dataset_id = $2',
                [p.id, dataset.id]
              )
            ).rows[0] as PolicyRow | undefined
        );
        const plan = planSharing(columns, policy ?? null, input);
        if (!plan.ok) throw new TerminalError(plan.reason);
        const sample = await asUser(env.executor, env.identity, PATH, (tx) =>
          sampleRows(tx, dataset, plan.columns, plan.sampleRows)
        );
        // Profiles: only the shared columns' evidence goes out.
        const evidence =
          input.kind === 'profile'
            ? result.evidence.filter((e) => plan.columns.includes(String((e.value as any)?.column)))
            : result.evidence;
        const prompt = buildPrompt(
          input,
          {
            dataset: dataset.name,
            entity: ent ? (ent.label ?? ent.entity_type) : null,
            columns: plan.columns,
          },
          evidence,
          sample
        );
        const estimate = costOf(
          p.config,
          estimateTokens(prompt.system + prompt.user),
          p.config.max_output_tokens
        );
        if (!input.personal) {
          const limit =
            p.budget?.limit === null || p.budget?.limit === undefined
              ? null
              : Number(p.budget.limit);
          if (limit === null) throw new TerminalError('aiNoBudget');
          if (Number(p.budget.spent ?? 0) + estimate > limit)
            throw new TerminalError('aiBudgetExceeded');
        }
        const target = targetOf(p, input.personal);
        if (
          estimateTokens(prompt.system + prompt.user) + p.config.max_output_tokens >
          p.config.context_tokens
        )
          throw new TerminalError('aiTooLarge');
        const shared = {
          dataset_id: dataset.id,
          dataset: dataset.name,
          columns: plan.columns,
          sensitive: plan.sensitive,
          sample_rows: sample.length,
        };
        await asUser(env.executor, env.identity, PATH, (tx) =>
          tx.query(
            `SELECT public.erp_log_data_access($1::uuid, 'ai', $2, 'send', $3, $4::text[], null, $5::jsonb)`,
            [
              dataset.workspaceId,
              p.id,
              sample.length,
              plan.sensitive,
              JSON.stringify({ provider: p.name, model: p.config.model, ...shared }),
            ]
          )
        );
        const out = await complete(target, {
          system: prompt.system,
          user: prompt.user,
          maxTokens: p.config.max_output_tokens,
          json: true,
        });
        await env.db('select ps_worker.ai_usage_record($1, $2, $3, $4, $5, $6, $7, $8::jsonb)', [
          p.id,
          env.identity.userId,
          decisionId,
          input.personal,
          out.inputTokens,
          out.outputTokens,
          costOf(p.config, out.inputTokens, out.outputTokens),
          JSON.stringify(shared),
        ]);
        narrative = {
          label: 'AI inference',
          ...parseNarrative(
            out.text,
            evidence.map((e) => e.id)
          ),
        };
      } catch (error) {
        // The statistics stand on their own; the narrative says why it is missing.
        narrative = {
          label: 'AI inference',
          error: error instanceof TerminalError ? error.code : 'failed',
        };
      }
    }

    await asUser(env.executor, env.identity, PATH, (tx) =>
      tx.query(
        'SELECT public.ps_finish_decision($1, true, null, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, $8, $9)',
        [
          decisionId,
          result.method,
          JSON.stringify(result.evidence),
          JSON.stringify(result.output),
          result.confidence,
          narrative ? JSON.stringify(narrative) : null,
          providerName,
          model,
          aboutPeople,
        ]
      )
    );
    return { decision_id: decisionId, narrative: narrative ? !('error' in narrative) : null };
  } catch (error) {
    const code = error instanceof TerminalError ? error.code : 'failed';
    await asUser(env.executor, env.identity, PATH, (tx) =>
      tx.query(
        'SELECT public.ps_finish_decision($1, false, $2, null, null, null, null, null, null, null, false)',
        [decisionId, code]
      )
    ).catch(() => undefined);
    throw error;
  }
}
