'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, Lightbulb, Loader2, Plus, ShieldAlert, UserCheck } from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi } from '@/lib/terminal/client';
import { INSIGHT_KINDS, MEASURES, PERIODS, type InsightKind } from '@/lib/terminal/insights';
import { useAiOverview } from './AiSettings';
import { Dialog, Empty, buttonCls, errorMessage, inputCls, primaryCls } from './shared';

interface InsightRow {
  id: string;
  dataset_id: string | null;
  dataset_name: string | null;
  kind: InsightKind;
  title: string;
  status: 'running' | 'done' | 'failed';
  error_key: string | null;
  method: string | null;
  confidence: number | null;
  narrative_provider: string | null;
  narrative_model: string | null;
  about_people: boolean;
  review_status: 'none' | 'requested' | 'reviewed';
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  created_by_name: string | null;
  created_at: string;
  mine: boolean;
}

interface InsightFull extends InsightRow {
  inputs: Record<string, any>;
  evidence: { id: string; label: string; value: unknown }[] | null;
  output: Record<string, any> | null;
  narrative: {
    label: string;
    summary?: string;
    findings?: { text: string; evidence: string[] }[];
    caveats?: string[];
    error?: string;
  } | null;
}

export function Insights({
  workspaceId,
  permissions,
}: {
  workspaceId: string;
  permissions: string[];
}) {
  const { t, fmt } = useI18n();
  const [rows, setRows] = useState<InsightRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await terminalApi<InsightRow[]>('insights.list', { workspaceId }));
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }, [workspaceId, t]);
  useEffect(() => {
    void load();
  }, [load]);
  const running = rows?.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [running, load]);

  const canRun = permissions.includes('datasets.query');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.75rem] text-muted-foreground max-w-3xl">{t('ps.ins.intro')}</p>
        {canRun && (
          <button type="button" className={primaryCls} onClick={() => setCreating(true)}>
            <Plus size={13} /> {t('ps.ins.new')}
          </button>
        )}
      </div>
      {!rows ? (
        <div className="h-32 rounded-xl animate-pulse bg-[var(--surface-3)]" />
      ) : rows.length === 0 ? (
        <Empty icon={Lightbulb} title={t('ps.ins.empty')} hint={t('ps.ins.emptyHint')} />
      ) : (
        <div className="rounded-xl border border-border bg-card divide-y divide-border">
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setOpen(r.id)}
              className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left text-[0.75rem] hover:bg-[var(--surface-3)]"
            >
              <span className="font-medium text-foreground">{r.title}</span>
              <span className="text-muted-foreground">{t(`ps.ins.kind.${r.kind}` as any)}</span>
              {r.status === 'running' && (
                <Loader2 size={12} className="animate-spin text-muted-foreground" />
              )}
              {r.status === 'failed' && (
                <span className="text-red-600 dark:text-red-400">
                  {t('ps.job.error', { code: r.error_key ?? 'failed' })}
                </span>
              )}
              {r.narrative_provider && (
                <span className="inline-flex items-center gap-1 rounded bg-[var(--surface-3)] px-1.5 text-[0.66rem] text-muted-foreground">
                  <Bot size={10} /> {t('ps.ins.aiInference')}
                </span>
              )}
              {r.about_people && (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <ShieldAlert size={11} /> {t('ps.ins.aboutPeople')}
                </span>
              )}
              {r.review_status !== 'none' && (
                <span
                  className={
                    r.review_status === 'reviewed'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-amber-600 dark:text-amber-400'
                  }
                >
                  {t(`ps.ins.review.${r.review_status}` as any)}
                </span>
              )}
              <span className="ml-auto text-muted-foreground">{fmt.dateTime(r.created_at)}</span>
            </button>
          ))}
        </div>
      )}
      {creating && (
        <NewInsightDialog
          workspaceId={workspaceId}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void load();
            setOpen(id);
          }}
        />
      )}
      {open && (
        <InsightDialog
          id={open}
          canReview={permissions.includes('approvals.decide')}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

interface Disclosure {
  dataset: string;
  rows: number;
  ai: null | {
    provider: string;
    model: string | null;
    columns: string[];
    sensitive: string[];
    excluded: string[];
    sampleRows: number;
    estimatedTokens: number;
    estimatedCost: number;
    personal: boolean;
    budget: { limit: string | number | null; spent: string | number; currency: string };
    allowed: boolean;
    reason: string | null;
  };
}

function NewInsightDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t, fmt, locale } = useI18n();
  const { data } = useAiOverview(workspaceId);
  const [datasetId, setDatasetId] = useState('');
  const [kind, setKind] = useState<InsightKind>('forecast');
  const [dateColumn, setDateColumn] = useState('');
  const [valueColumn, setValueColumn] = useState('');
  const [measure, setMeasure] = useState('sum');
  const [period, setPeriod] = useState('month');
  const [horizon, setHorizon] = useState(6);
  const [providerId, setProviderId] = useState('');
  const [personal, setPersonal] = useState(false);
  const [disclosure, setDisclosure] = useState<Disclosure | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const ds = data?.datasets.find((d) => d.id === datasetId);
  const dates = ds?.columns.filter((c) => c.type === 'date' || c.type === 'timestamp') ?? [];
  const numbers = ds?.columns.filter((c) => c.type === 'integer' || c.type === 'decimal') ?? [];
  const provider = data?.providers.find((p) => p.id === providerId);
  const body = {
    workspaceId,
    datasetId,
    kind,
    date_column: dateColumn,
    value_column: valueColumn || null,
    measure,
    period,
    horizon,
    provider_id: providerId || null,
    personal,
    language: locale === 'id' ? 'id' : locale === 'zh-CN' ? 'zh' : 'en',
  };
  const reset = () => setDisclosure(null);

  const check = async () => {
    setBusy(true);
    setError('');
    try {
      setDisclosure(await terminalApi<Disclosure>('insight.disclose', body));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const { id } = await terminalApi<{ id: string }>('insight.create', body);
      onCreated(id);
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  const select = (
    label: string,
    value: string,
    set: (v: string) => void,
    options: { value: string; label: string }[],
    empty?: string
  ) => (
    <label className="block text-[0.7rem] text-muted-foreground">
      {label}
      <select
        className={inputCls}
        value={value}
        onChange={(e) => {
          set(e.target.value);
          reset();
        }}
        style={{ colorScheme: 'light dark' }}
      >
        {empty !== undefined && <option value="">{empty}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Dialog title={t('ps.ins.new')} onClose={onClose} wide>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {!data ? (
        <div className="h-24 rounded-lg animate-pulse bg-[var(--surface-3)]" />
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {select(
              t('ps.ins.dataset'),
              datasetId,
              setDatasetId,
              data.datasets.map((d) => ({
                value: d.id,
                label: d.folder ? `${d.folder} / ${d.name}` : d.name,
              })),
              t('ps.ins.pickDataset')
            )}
            {select(
              t('ps.ins.kind'),
              kind,
              (v) => setKind(v as InsightKind),
              INSIGHT_KINDS.map((k) => ({ value: k, label: t(`ps.ins.kind.${k}` as any) }))
            )}
            {kind !== 'profile' && (
              <>
                {select(
                  t('ps.ins.dateColumn'),
                  dateColumn,
                  setDateColumn,
                  dates.map((c) => ({ value: c.label, label: c.label })),
                  t('ps.ins.pickColumn')
                )}
                {select(
                  t('ps.ins.measure'),
                  measure,
                  setMeasure,
                  MEASURES.map((m) => ({ value: m, label: t(`ps.ins.measure.${m}` as any) }))
                )}
                {select(
                  t('ps.ins.valueColumn'),
                  valueColumn,
                  setValueColumn,
                  numbers.map((c) => ({ value: c.label, label: c.label })),
                  measure === 'count' ? t('ps.ins.rows') : t('ps.ins.pickColumn')
                )}
                {select(
                  t('ps.ins.period'),
                  period,
                  setPeriod,
                  PERIODS.map((p) => ({ value: p, label: t(`ps.ins.period.${p}` as any) }))
                )}
                {kind === 'forecast' && (
                  <label className="block text-[0.7rem] text-muted-foreground">
                    {t('ps.ins.horizon')}
                    <input
                      type="number"
                      min={1}
                      max={36}
                      className={inputCls}
                      value={horizon}
                      onChange={(e) => {
                        setHorizon(Number(e.target.value));
                        reset();
                      }}
                    />
                  </label>
                )}
              </>
            )}
            {select(
              t('ps.ins.narrative'),
              providerId,
              setProviderId,
              data.providers
                .filter((p) => p.enabled)
                .map((p) => ({ value: p.id, label: `${p.name} · ${p.config.model}` })),
              t('ps.ins.noNarrative')
            )}
          </div>
          {provider?.allow_personal_keys && provider.my_key && (
            <label className="flex items-center gap-1.5 text-[0.72rem]">
              <input
                type="checkbox"
                checked={personal}
                onChange={(e) => {
                  setPersonal(e.target.checked);
                  reset();
                }}
              />
              {t('ps.ins.usePersonal')}
            </label>
          )}
          <p className="text-[0.68rem] text-muted-foreground">{t('ps.ins.howStats')}</p>

          {disclosure && (
            <section
              className="rounded-lg border border-border bg-[var(--surface-2,transparent)] p-3 space-y-1.5 text-[0.72rem]"
              aria-label={t('ps.ins.disclosure')}
            >
              <p className="font-semibold text-foreground">{t('ps.ins.disclosure')}</p>
              <p className="text-muted-foreground">
                {t('ps.ins.discloseStats', {
                  dataset: disclosure.dataset,
                  rows: fmt.number(disclosure.rows),
                })}
              </p>
              {!disclosure.ai ? (
                <p className="text-muted-foreground">{t('ps.ins.discloseNoAi')}</p>
              ) : (
                <>
                  <p>
                    {t('ps.ins.discloseProvider', {
                      provider: disclosure.ai.provider,
                      model: disclosure.ai.model ?? '—',
                    })}
                  </p>
                  <p>
                    {t('ps.ins.discloseColumns', {
                      columns: disclosure.ai.columns.join(', ') || '—',
                    })}
                  </p>
                  {disclosure.ai.sensitive.length > 0 && (
                    <p className="text-amber-600 dark:text-amber-400">
                      {t('ps.ins.discloseSensitive', {
                        columns: disclosure.ai.sensitive.join(', '),
                      })}
                    </p>
                  )}
                  {disclosure.ai.excluded.length > 0 && (
                    <p className="text-muted-foreground">
                      {t('ps.ins.discloseExcluded', { columns: disclosure.ai.excluded.join(', ') })}
                    </p>
                  )}
                  <p>
                    {disclosure.ai.sampleRows
                      ? t('ps.ins.discloseSample', { n: disclosure.ai.sampleRows })
                      : t('ps.ins.discloseAggregates')}
                  </p>
                  <p>
                    {t('ps.ins.discloseCost', {
                      tokens: fmt.number(disclosure.ai.estimatedTokens),
                      cost: fmt.number(disclosure.ai.estimatedCost),
                      currency: disclosure.ai.budget.currency,
                    })}{' '}
                    {disclosure.ai.personal
                      ? t('ps.ins.disclosePersonal')
                      : disclosure.ai.budget.limit === null
                        ? ''
                        : t('ps.ai.spentOf', {
                            spent: fmt.number(Number(disclosure.ai.budget.spent)),
                            limit: fmt.number(Number(disclosure.ai.budget.limit)),
                            currency: disclosure.ai.budget.currency,
                          })}
                  </p>
                  {!disclosure.ai.allowed && (
                    <p
                      role="alert"
                      className="flex items-center gap-1 text-red-600 dark:text-red-400"
                    >
                      <AlertTriangle size={12} /> {t(`ps.err.${disclosure.ai.reason}` as any)}
                    </p>
                  )}
                </>
              )}
            </section>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonCls} onClick={onClose}>
              {t('common.cancel')}
            </button>
            {!disclosure ? (
              <button
                type="button"
                className={primaryCls}
                disabled={busy || !datasetId}
                onClick={check}
              >
                {busy && <Loader2 size={13} className="animate-spin" />} {t('ps.ins.check')}
              </button>
            ) : (
              <button
                type="button"
                className={primaryCls}
                disabled={busy || (disclosure.ai !== null && !disclosure.ai.allowed)}
                onClick={start}
              >
                {busy && <Loader2 size={13} className="animate-spin" />} {t('ps.ins.run')}
              </button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

function InsightDialog({
  id,
  canReview,
  onClose,
  onChanged,
}: {
  id: string;
  canReview: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t, fmt } = useI18n();
  const [d, setD] = useState<InsightFull | null>(null);
  const [note, setNote] = useState('');
  const load = useCallback(async () => {
    try {
      setD(await terminalApi<InsightFull>('insight.get', { id }));
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }, [id, t]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (d?.status !== 'running') return;
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [d?.status, load]);

  const chart = useMemo(() => {
    const out = d?.output;
    if (!out?.series) return null;
    const anomalies = new Set((out.anomalies ?? []).map((a: any) => a.p));
    const points: Record<string, any>[] = out.series.map((x: any) => ({
      p: x.p,
      v: x.v,
      anomaly: anomalies.has(x.p) ? x.v : null,
    }));
    for (const f of out.forecast ?? []) points.push({ p: f.p, f: f.value, band: [f.low, f.high] });
    return points;
  }, [d]);

  const act = async (action: string) => {
    try {
      await terminalApi(action, { id, note });
      setNote('');
      await load();
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  return (
    <Dialog title={d?.title ?? t('ps.ins.title')} onClose={onClose} wide>
      {!d ? (
        <div className="h-32 rounded-lg animate-pulse bg-[var(--surface-3)]" />
      ) : (
        <div className="space-y-3 text-[0.75rem]">
          <p className="text-muted-foreground">
            {t(`ps.ins.kind.${d.kind}` as any)} · {d.dataset_name ?? '—'} ·{' '}
            {d.created_by_name ?? ''} · {fmt.dateTime(d.created_at)}
          </p>
          {d.status === 'running' && (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> {t('ps.ins.running')}
            </p>
          )}
          {d.status === 'failed' && (
            <p className="text-red-600 dark:text-red-400">
              {t(`ps.err.${d.error_key}` as any) || t('ps.job.error', { code: d.error_key ?? '' })}
            </p>
          )}
          {d.about_people && (
            <p className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <ShieldAlert size={12} /> {t('ps.ins.aboutPeopleNote')}
            </p>
          )}

          {chart && (
            <div className="h-64 w-full">
              <ResponsiveContainer>
                <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="p" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
                  <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} width={60} />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      fontSize: 11,
                      color: 'var(--foreground)',
                    }}
                  />
                  <Area
                    dataKey="band"
                    stroke="none"
                    fill="var(--muted-foreground)"
                    fillOpacity={0.15}
                    name={t('ps.ins.interval')}
                  />
                  <Line
                    dataKey="v"
                    stroke="var(--foreground)"
                    dot={false}
                    name={t('ps.ins.actual')}
                  />
                  <Line
                    dataKey="f"
                    stroke="var(--primary, #2563eb)"
                    strokeDasharray="4 3"
                    dot={false}
                    name={t('ps.ins.forecast')}
                  />
                  <Scatter dataKey="anomaly" fill="#dc2626" name={t('ps.ins.anomaly')} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}

          {d.status === 'done' && (
            <p className="text-muted-foreground">
              {t('ps.ins.method', {
                method: d.method ?? '—',
                confidence: fmt.number(Math.round((d.confidence ?? 0) * 100)),
              })}
            </p>
          )}

          {d.narrative && (
            <section className="rounded-lg border border-dashed border-border p-3 space-y-1.5">
              <p className="flex items-center gap-1.5 font-semibold text-foreground">
                <Bot size={13} /> {t('ps.ins.aiInference')}
                <span className="font-normal text-muted-foreground">
                  {[d.narrative_provider, d.narrative_model].filter(Boolean).join(' · ')}
                </span>
              </p>
              {d.narrative.error ? (
                <p className="text-amber-600 dark:text-amber-400">
                  {t('ps.ins.noNarrativeBecause')} {t(`ps.err.${d.narrative.error}` as any)}
                </p>
              ) : (
                <>
                  <p className="whitespace-pre-wrap">{d.narrative.summary}</p>
                  {(d.narrative.findings ?? []).length > 0 && (
                    <ul className="list-disc pl-5 space-y-0.5">
                      {d.narrative.findings!.map((f, i) => (
                        <li key={i}>
                          {f.text}{' '}
                          {f.evidence.map((e) => (
                            <a
                              key={e}
                              href={`#ev-${e}`}
                              className="text-[0.66rem] underline text-muted-foreground mr-1"
                            >
                              [{e}]
                            </a>
                          ))}
                        </li>
                      ))}
                    </ul>
                  )}
                  {(d.narrative.caveats ?? []).length > 0 && (
                    <p className="text-muted-foreground">
                      {t('ps.ins.caveats')} {d.narrative.caveats!.join(' · ')}
                    </p>
                  )}
                  <p className="text-[0.66rem] text-muted-foreground">{t('ps.ins.aiNote')}</p>
                </>
              )}
            </section>
          )}

          {d.evidence && d.evidence.length > 0 && (
            <details>
              <summary className="cursor-pointer font-medium text-foreground">
                {t('ps.ins.evidence')}
              </summary>
              <div className="mt-2 space-y-1.5">
                {d.evidence.map((e) => (
                  <div key={e.id} id={`ev-${e.id}`} className="rounded border border-border p-2">
                    <p className="font-mono text-[0.68rem] text-muted-foreground">
                      {e.id} · {e.label}
                    </p>
                    <pre className="max-h-40 overflow-auto text-[0.66rem] whitespace-pre-wrap">
                      {JSON.stringify(e.value, null, 1)}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          )}

          {d.status === 'done' && (
            <section className="rounded-lg border border-border p-3 space-y-1.5">
              <p className="flex items-center gap-1.5 font-semibold text-foreground">
                <UserCheck size={13} /> {t('ps.ins.reviewTitle')}
              </p>
              <p className="text-muted-foreground">
                {t(`ps.ins.review.${d.review_status}` as any)}
                {d.reviewed_by_name ? ` · ${d.reviewed_by_name}` : ''}
                {d.reviewed_at ? ` · ${fmt.dateTime(d.reviewed_at)}` : ''}
                {d.review_note ? ` — ${d.review_note}` : ''}
              </p>
              <textarea
                className={inputCls}
                rows={2}
                maxLength={2000}
                placeholder={t('ps.ins.notePlaceholder')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="flex flex-wrap gap-1.5">
                {d.review_status !== 'requested' && (
                  <button
                    type="button"
                    className={buttonCls}
                    onClick={() => act('insight.requestReview')}
                  >
                    {t('ps.ins.requestReview')}
                  </button>
                )}
                {canReview && !d.mine && d.review_status !== 'reviewed' && (
                  <button type="button" className={buttonCls} onClick={() => act('insight.review')}>
                    {t('ps.ins.markReviewed')}
                  </button>
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}
