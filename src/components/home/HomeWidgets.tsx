'use client';

// Widgets on the Home page (20261012000045): a figure or a short list from
// one of the person's ERPs. Each widget is read with the person's current
// rights in its ERP (the dashboard figures and the analytics query, both
// checked by the database), so nothing is shown that the ERP would not show.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ArrowDown, ArrowUp, LayoutGrid, Loader2, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useErpDirectory } from '@/lib/workspaces/directory';
import { CATALOG, type EntityKey } from '@/lib/analytics/catalog';
import { columnLabel, entityLabel, fieldLabel } from '@/lib/analytics/labels';
import { can, isPermission } from '@/app/erp/lib/erpRules';

export const KPI_METRICS = [
  'totalRevenue',
  'cashBalance',
  'totalExpenses',
  'accountsReceivable',
  'accountsPayable',
  'inventoryValue',
] as const;
type Metric = (typeof KPI_METRICS)[number];
const METRIC_LABEL: Record<Metric, MessageKey> = {
  totalRevenue: 'home.kpi.cashIn',
  cashBalance: 'home.kpi.netCash',
  totalExpenses: 'home.kpi.cashOut',
  accountsReceivable: 'home.kpi.receivable',
  accountsPayable: 'home.kpi.payable',
  inventoryValue: 'home.kpi.inventory',
};

const MAX_LIST_FIELDS = 6;
const LIST_ROWS = [5, 10, 20] as const;

interface KpiConfig {
  metric: Metric;
}
interface ListConfig {
  entity: EntityKey;
  fields: string[];
  sort: { field: string; direction: 'asc' | 'desc' } | null;
  limit: number;
}
interface Widget {
  id: string;
  workspace_id: string;
  kind: 'kpi' | 'list';
  title: string;
  config: Record<string, any>;
  position: number;
}

const isEntity = (v: unknown): v is EntityKey => typeof v === 'string' && Object.hasOwn(CATALOG, v);

/** The list settings, or null when they no longer fit the catalog. */
function listConfigOf(c: Record<string, any>): ListConfig | null {
  if (!isEntity(c.entity)) return null;
  const known = new Set(CATALOG[c.entity].fields.map((f) => f.key));
  const fields = (Array.isArray(c.fields) ? c.fields : [])
    .filter((f: unknown) => typeof f === 'string' && known.has(f))
    .slice(0, MAX_LIST_FIELDS);
  if (!fields.length) return null;
  const sort =
    c.sort && known.has(c.sort.field)
      ? { field: c.sort.field, direction: c.sort.direction === 'asc' ? 'asc' : 'desc' }
      : null;
  const limit = LIST_ROWS.includes(c.limit) ? c.limit : 5;
  return { entity: c.entity, fields, sort: sort as ListConfig['sort'], limit };
}

const card = 'rounded-xl border p-4';
const cardStyle = { background: 'var(--card)', borderColor: 'var(--border)' } as const;

// ─── Reading ──────────────────────────────────────────────────────────────────

async function baseCurrency(workspaceId: string): Promise<string | null> {
  const { data } = await createClient().rpc('erp_accounting_settings_get', {
    p_workspace_id: workspaceId,
  });
  const row = Array.isArray(data) ? data[0] : data;
  return row?.base_currency ?? null;
}

function KpiBody({ widget }: { widget: Widget }) {
  const { t, fmt } = useI18n();
  const metric = (KPI_METRICS as readonly string[]).includes(widget.config.metric)
    ? (widget.config.metric as Metric)
    : null;
  const [state, setState] = useState<{ value: number; currency: string | null } | 'error' | null>(
    null
  );
  useEffect(() => {
    if (!metric) return;
    let cancelled = false;
    Promise.all([
      createClient().rpc('erp_dashboard_metrics', { p_workspace_id: widget.workspace_id }),
      baseCurrency(widget.workspace_id).catch(() => null),
    ])
      .then(([res, currency]) => {
        if (cancelled) return;
        if (res.error || !res.data) setState('error');
        else setState({ value: Number((res.data as any)[metric]) || 0, currency });
      })
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [metric, widget.workspace_id]);
  if (!metric || state === 'error') return <WidgetProblem />;
  if (!state) return <div className="h-8 w-32 rounded animate-pulse bg-[var(--surface-3)]" />;
  return (
    <div>
      <p className="text-[0.7rem]" style={{ color: 'var(--muted-foreground)' }}>
        {t(METRIC_LABEL[metric])}
      </p>
      <p
        className="text-[1.4rem] font-bold tabular-nums font-mono-nums"
        style={{ color: 'var(--foreground)' }}
      >
        {fmt.moneyIn(state.value, state.currency)}
      </p>
    </div>
  );
}

interface QueryColumn {
  name: string;
  type: string;
}

function ListBody({ widget }: { widget: Widget }) {
  const { t, fmt } = useI18n();
  const config = useMemo(() => listConfigOf(widget.config), [widget.config]);
  const [state, setState] = useState<
    | { columns: QueryColumn[]; rows: Record<string, unknown>[]; currency: string | null }
    | 'error'
    | null
  >(null);
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    const spec = {
      entity: config.entity,
      fields: config.fields,
      ...(config.sort ? { sort: config.sort } : {}),
      limit: config.limit,
    };
    Promise.all([
      fetch('/api/erp/analytics/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, workspaceId: widget.workspace_id }),
      }).then((r) => r.json()),
      baseCurrency(widget.workspace_id).catch(() => null),
    ])
      .then(([result, currency]) => {
        if (cancelled) return;
        if (!result?.success) setState('error');
        else setState({ columns: result.data.columns, rows: result.data.rows, currency });
      })
      .catch(() => !cancelled && setState('error'));
    return () => {
      cancelled = true;
    };
  }, [config, widget.workspace_id]);
  if (!config || state === 'error') return <WidgetProblem />;
  if (!state) return <div className="h-20 rounded animate-pulse bg-[var(--surface-3)]" />;
  if (!state.rows.length)
    return (
      <p className="text-[0.75rem]" style={{ color: 'var(--muted-foreground)' }}>
        {t('home.widget.noRows')}
      </p>
    );
  const cell = (value: unknown, type: string) => {
    if (value === null || value === undefined || value === '') return '—';
    if (type === 'money') return fmt.moneyIn(Number(value), state.currency);
    if (type === 'number' || type === 'integer') return fmt.number(Number(value));
    if (type === 'date') return fmt.date(String(value));
    if (type === 'datetime') return fmt.dateTime(String(value));
    if (type === 'boolean') return value ? '✓' : '–';
    return String(value);
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[0.72rem]">
        <thead>
          <tr style={{ color: 'var(--muted-foreground)' }}>
            {state.columns.map((c) => (
              <th key={c.name} className="px-1.5 py-1 text-left font-medium whitespace-nowrap">
                {columnLabel(c.name, t)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.rows.map((r, i) => (
            <tr key={i} className="border-t" style={{ borderColor: 'var(--border)' }}>
              {state.columns.map((c) => (
                <td
                  key={c.name}
                  className="px-1.5 py-1 whitespace-nowrap max-w-[14rem] truncate"
                  style={{ color: 'var(--foreground)' }}
                >
                  {cell(r[c.name], c.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WidgetProblem() {
  const { t } = useI18n();
  return (
    <p className="text-[0.75rem]" style={{ color: 'var(--muted-foreground)' }}>
      {t('home.widget.unavailable')}
    </p>
  );
}

// ─── The workspace (Home) ─────────────────────────────────────────────────────

export function HomeWidgets({ userId }: { userId: string | undefined }) {
  const { t } = useI18n();
  const directory = useErpDirectory();
  const [widgets, setWidgets] = useState<Widget[] | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await createClient()
      .from('home_widgets')
      .select('id, workspace_id, kind, title, config, position')
      .order('position', { ascending: true })
      .order('created_at', { ascending: true });
    // Older database (no widgets yet): an empty Home.
    setWidgets(error ? [] : ((data as Widget[]) ?? []));
  }, [userId]);
  useEffect(() => {
    void load();
  }, [load]);

  const erpName = (id: string) => directory.erps.find((e) => e.id === id)?.name ?? null;

  const remove = async (w: Widget) => {
    const { error } = await createClient().from('home_widgets').delete().eq('id', w.id);
    if (error) toast.error(t('home.widget.failed'));
    await load();
  };

  // Swaps places with the neighbour (positions are renumbered in order).
  const move = async (index: number, by: -1 | 1) => {
    if (!widgets) return;
    const next = [...widgets];
    const j = index + by;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setWidgets(next);
    const db = createClient();
    await Promise.all(
      next.map((w, i) =>
        w.position === i ? null : db.from('home_widgets').update({ position: i }).eq('id', w.id)
      )
    );
    await load();
  };

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setAdding(true)}
        disabled={!userId}
        className={`${card} flex w-full items-center gap-3 text-left transition-opacity hover:opacity-80 disabled:opacity-50`}
        style={cardStyle}
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ background: 'var(--surface-3)', color: 'var(--foreground)' }}
        >
          <Plus size={16} aria-hidden />
        </span>
        <span className="min-w-0">
          <span
            className="block text-[0.85rem] font-semibold"
            style={{ color: 'var(--foreground)' }}
          >
            {t('home.addWidget')}
          </span>
          <span className="block text-[0.72rem]" style={{ color: 'var(--muted-foreground)' }}>
            {t('home.addWidgetDesc')}
          </span>
        </span>
      </button>

      {widgets === null ? (
        <div className="h-24 rounded-xl animate-pulse bg-[var(--surface-3)]" />
      ) : widgets.length === 0 ? (
        <div className={`${card} py-10 text-center`} style={cardStyle}>
          <LayoutGrid
            size={26}
            className="mx-auto mb-2 opacity-40"
            style={{ color: 'var(--muted-foreground)' }}
            aria-hidden
          />
          <p className="text-[0.8rem]" style={{ color: 'var(--muted-foreground)' }}>
            {t('home.emptyWorkspace')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {widgets.map((w, i) => (
            <section
              key={w.id}
              className={`${card} space-y-3 ${w.kind === 'list' ? 'md:col-span-2' : ''}`}
              style={cardStyle}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2
                    className="truncate text-[0.82rem] font-semibold"
                    style={{ color: 'var(--foreground)' }}
                  >
                    {w.title}
                  </h2>
                  <p
                    className="truncate text-[0.66rem]"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    {erpName(w.workspace_id) ?? t('home.widget.noAccess')}
                    {w.kind === 'list' && isEntity(w.config.entity) && (
                      <>
                        {' · '}
                        <Link href="/erp" className="underline underline-offset-2">
                          {entityLabel(w.config.entity, t)}
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-0.5" style={{ color: 'var(--muted-foreground)' }}>
                  <button
                    type="button"
                    onClick={() => void move(i, -1)}
                    disabled={i === 0}
                    aria-label={t('home.widget.moveUp')}
                    className="rounded p-1 hover:bg-[var(--surface-3)] disabled:opacity-30"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void move(i, 1)}
                    disabled={i === widgets.length - 1}
                    aria-label={t('home.widget.moveDown')}
                    className="rounded p-1 hover:bg-[var(--surface-3)] disabled:opacity-30"
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      confirm(t('home.widget.removeConfirm', { title: w.title })) && void remove(w)
                    }
                    aria-label={t('home.widget.remove')}
                    className="rounded p-1 hover:bg-[var(--surface-3)] hover:text-red-500"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {erpName(w.workspace_id) === null && directory.ready ? (
                <WidgetProblem />
              ) : w.kind === 'kpi' ? (
                <KpiBody widget={w} />
              ) : (
                <ListBody widget={w} />
              )}
            </section>
          ))}
        </div>
      )}

      {adding && userId && (
        <AddWidgetDialog
          userId={userId}
          erps={directory.erps.map((e) => ({ id: e.id, name: e.name }))}
          defaultErp={directory.activeId}
          nextPosition={widgets?.length ?? 0}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ─── Adding ───────────────────────────────────────────────────────────────────

const inputCls =
  'w-full rounded-[var(--radius)] border border-border bg-transparent px-3 py-2 text-[0.8rem] outline-none focus:border-foreground/40';

function AddWidgetDialog({
  userId,
  erps,
  defaultErp,
  nextPosition,
  onClose,
  onAdded,
}: {
  userId: string;
  erps: { id: string; name: string }[];
  defaultErp: string | null;
  nextPosition: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const [erp, setErp] = useState(erps.find((e) => e.id === defaultErp)?.id ?? erps[0]?.id ?? '');
  const [kind, setKind] = useState<'kpi' | 'list'>('kpi');
  const [metric, setMetric] = useState<Metric>('totalRevenue');
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [entity, setEntity] = useState<EntityKey | ''>('');
  const [fields, setFields] = useState<string[]>([]);
  const [sortField, setSortField] = useState('');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [limit, setLimit] = useState<number>(5);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // What this person may read in the chosen ERP (lists are offered accordingly).
  useEffect(() => {
    if (!erp) return;
    let cancelled = false;
    setPermissions(null);
    createClient()
      .rpc('erp_my_permissions', { p_workspace_id: erp })
      .then(({ data }: { data: unknown }) => {
        if (!cancelled) setPermissions(Array.isArray(data) ? data.filter(isPermission) : []);
      });
    return () => {
      cancelled = true;
    };
  }, [erp]);

  const entities = useMemo(
    () =>
      (Object.keys(CATALOG) as EntityKey[]).filter((e) => can(permissions, CATALOG[e].permission)),
    [permissions]
  );
  const entityFields = entity
    ? CATALOG[entity].fields.filter((f) => f.type !== 'id' || f.key === 'id')
    : [];

  const pickEntity = (e: EntityKey | '') => {
    setEntity(e);
    if (!e) return;
    const start = CATALOG[e].fields
      .filter((f) => f.type !== 'id')
      .slice(0, 4)
      .map((f) => f.key);
    setFields(start);
    const def = CATALOG[e].defaultSort;
    setSortField(def?.field ?? '');
    setDirection(def?.direction ?? 'desc');
  };

  const suggested = kind === 'kpi' ? t(METRIC_LABEL[metric]) : entity ? entityLabel(entity, t) : '';
  const shownTitle = titleTouched ? title : suggested;

  const ready =
    !!erp &&
    !!shownTitle.trim() &&
    (kind === 'kpi' || (!!entity && fields.length > 0 && fields.length <= MAX_LIST_FIELDS));

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    const config =
      kind === 'kpi'
        ? { metric }
        : {
            entity,
            fields,
            sort: sortField ? { field: sortField, direction } : null,
            limit,
          };
    const { error: e } = await createClient()
      .from('home_widgets')
      .insert({
        user_id: userId,
        workspace_id: erp,
        kind,
        title: shownTitle.trim().slice(0, 80),
        config,
        position: nextPosition,
      });
    setBusy(false);
    if (e) {
      setError(/24/.test(e.message ?? '') ? t('home.widget.limit') : t('home.widget.failed'));
      return;
    }
    onAdded();
  };

  return createPortal(
    <div
      className="overlay-mobile fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-widget-title"
        className="ui-refined flex max-h-[90dvh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="add-widget-title" className="text-[1rem] font-semibold">
              {t('home.addWidget')}
            </h2>
            <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{t('home.addWidgetDesc')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded p-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {erps.length === 0 ? (
            <p className="text-[0.8rem] text-muted-foreground">{t('home.widget.noErps')}</p>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-[0.72rem] font-medium">
                  {t('home.widget.erp')}
                </span>
                <select
                  className={inputCls}
                  value={erp}
                  onChange={(e) => {
                    setErp(e.target.value);
                    pickEntity('');
                  }}
                  style={{ colorScheme: 'light dark' }}
                >
                  {erps.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>

              <fieldset>
                <legend className="mb-1 text-[0.72rem] font-medium">{t('home.widget.type')}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(['kpi', 'list'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKind(k)}
                      aria-pressed={kind === k}
                      className={`rounded-[var(--radius)] border px-3 py-2 text-left ${
                        kind === k ? 'border-foreground/50 bg-surface-3' : 'border-border'
                      }`}
                    >
                      <span className="block text-[0.78rem] font-medium">
                        {t(`home.widget.type.${k}` as MessageKey)}
                      </span>
                      <span className="block text-[0.68rem] text-muted-foreground">
                        {t(`home.widget.type.${k}.desc` as MessageKey)}
                      </span>
                    </button>
                  ))}
                </div>
              </fieldset>

              {kind === 'kpi' ? (
                <label className="block">
                  <span className="mb-1 block text-[0.72rem] font-medium">
                    {t('home.widget.metric')}
                  </span>
                  <select
                    className={inputCls}
                    value={metric}
                    onChange={(e) => setMetric(e.target.value as Metric)}
                    style={{ colorScheme: 'light dark' }}
                  >
                    {KPI_METRICS.map((m) => (
                      <option key={m} value={m}>
                        {t(METRIC_LABEL[m])}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className="block">
                    <span className="mb-1 block text-[0.72rem] font-medium">
                      {t('home.widget.data')}
                    </span>
                    <select
                      className={inputCls}
                      value={entity}
                      disabled={!permissions}
                      onChange={(e) => pickEntity(e.target.value as EntityKey | '')}
                      style={{ colorScheme: 'light dark' }}
                    >
                      <option value="">
                        {permissions
                          ? entities.length
                            ? t('home.widget.pickData')
                            : t('home.widget.nothingToRead')
                          : t('common.loading')}
                      </option>
                      {entities.map((e) => (
                        <option key={e} value={e}>
                          {entityLabel(e, t)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {entity && (
                    <>
                      <fieldset>
                        <legend className="mb-1 text-[0.72rem] font-medium">
                          {t('home.widget.columns', { max: MAX_LIST_FIELDS })}
                        </legend>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                          {entityFields.map((f) => {
                            const on = fields.includes(f.key);
                            return (
                              <label
                                key={f.key}
                                className="flex items-center gap-1.5 text-[0.75rem]"
                              >
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={!on && fields.length >= MAX_LIST_FIELDS}
                                  onChange={() =>
                                    setFields(
                                      on ? fields.filter((x) => x !== f.key) : [...fields, f.key]
                                    )
                                  }
                                />
                                <span className="truncate">{fieldLabel(f.key, t)}</span>
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                      <div className="grid grid-cols-3 gap-2">
                        <label className="col-span-2 block">
                          <span className="mb-1 block text-[0.72rem] font-medium">
                            {t('home.widget.sort')}
                          </span>
                          <select
                            className={inputCls}
                            value={sortField}
                            onChange={(e) => setSortField(e.target.value)}
                            style={{ colorScheme: 'light dark' }}
                          >
                            <option value="">{t('home.widget.noSort')}</option>
                            {entityFields.map((f) => (
                              <option key={f.key} value={f.key}>
                                {fieldLabel(f.key, t)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[0.72rem] font-medium">
                            {t('home.widget.order')}
                          </span>
                          <select
                            className={inputCls}
                            value={direction}
                            disabled={!sortField}
                            onChange={(e) => setDirection(e.target.value as 'asc' | 'desc')}
                            style={{ colorScheme: 'light dark' }}
                          >
                            <option value="desc">{t('home.widget.desc')}</option>
                            <option value="asc">{t('home.widget.asc')}</option>
                          </select>
                        </label>
                      </div>
                      <label className="block">
                        <span className="mb-1 block text-[0.72rem] font-medium">
                          {t('home.widget.rows')}
                        </span>
                        <select
                          className={inputCls}
                          value={limit}
                          onChange={(e) => setLimit(Number(e.target.value))}
                          style={{ colorScheme: 'light dark' }}
                        >
                          {LIST_ROWS.map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </>
              )}

              <label className="block">
                <span className="mb-1 block text-[0.72rem] font-medium">
                  {t('home.widget.title')}
                </span>
                <input
                  className={inputCls}
                  value={shownTitle}
                  maxLength={80}
                  onChange={(e) => {
                    setTitleTouched(true);
                    setTitle(e.target.value);
                  }}
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius)] border border-border px-3 py-2 text-[0.8rem] hover:bg-surface-3"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!ready || busy}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 size={13} className="animate-spin" aria-hidden />}
            {t('home.widget.add')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
