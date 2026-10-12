'use client';

import React, { useMemo } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  CATALOG,
  isNumericType,
  type CatalogField,
  type EntityKey,
  type FieldType,
} from '@/lib/analytics/catalog';
import { entityDescription, fieldLabel, moduleLabel, relationLabel } from '@/lib/analytics/labels';
import {
  BUCKETS,
  MEASURE_OPS,
  SUMMARY_LIMITS,
  defaultSummary,
  inactiveRule,
  summaryColumns,
  validateSummary,
  type Bucket,
  type MeasureOp,
  type SummaryGroup,
  type SummaryMeasure,
} from '@/lib/analytics/summary';
import { summaryErrorKey, summarySpecOf } from '@/lib/workflow/runtime';
import {
  EntitySelect,
  FiltersEditor,
  headingCls,
  inputCls,
  sectionCls,
  useCanRead,
} from './ErpSourcePanel';
import { ColumnInfoRow } from './columnInfo';

const GROUP_TYPES: readonly FieldType[] = [
  'text',
  'enum',
  'boolean',
  'date',
  'datetime',
  'id',
  'integer',
];
const ORDERED_TYPES: readonly FieldType[] = ['integer', 'number', 'money', 'date', 'datetime'];

interface FieldOption {
  value: string;
  field: string;
  relation?: string;
  def: CatalogField;
}

const keyOf = (ref: { field?: string; relation?: string }) =>
  `${ref.relation ?? ''}|${ref.field ?? ''}`;

function fieldOptions(entity: EntityKey): FieldOption[] {
  const def = CATALOG[entity];
  const own = def.fields.map((f) => ({ value: keyOf({ field: f.key }), field: f.key, def: f }));
  const related = def.relations.flatMap((r) =>
    CATALOG[r.target].fields.map((f) => ({
      value: keyOf({ field: f.key, relation: r.key }),
      field: f.key,
      relation: r.key,
      def: f,
    }))
  );
  return [...own, ...related];
}

function measureAllows(op: MeasureOp, o: FieldOption): boolean {
  switch (op) {
    case 'count':
      return false;
    case 'countDistinct':
      return o.def.calculated !== 'engine';
    case 'sum':
    case 'avg':
      return !o.relation && isNumericType(o.def.type);
    default:
      return ORDERED_TYPES.includes(o.def.type) && !(o.relation && o.def.calculated === 'engine');
  }
}

export default function SummaryPanel({
  config,
  onChange,
}: {
  config: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const canRead = useCanRead();
  const entity: EntityKey = CATALOG[config.entity as EntityKey] ? config.entity : 'invoices';
  const def = CATALOG[entity];
  const set = (patch: Record<string, any>) => onChange({ ...config, entity, ...patch });
  const groupBy: SummaryGroup[] = Array.isArray(config.groupBy) ? config.groupBy : [];
  const measures: SummaryMeasure[] = Array.isArray(config.measures) ? config.measures : [];

  const options = useMemo(() => fieldOptions(entity), [entity]);
  const optionLabel = (o: FieldOption) =>
    o.relation
      ? `${relationLabel(o.relation, t)} · ${fieldLabel(o.field, t)}`
      : fieldLabel(o.field, t);
  const groupOptions = options.filter(
    (o) => o.def.calculated !== 'engine' && GROUP_TYPES.includes(o.def.type)
  );
  const byValue = new Map(options.map((o) => [o.value, o]));

  const validation = useMemo(
    () => validateSummary(summarySpecOf({ ...config, entity })),
    [config, entity]
  );
  const columns = useMemo(
    () =>
      summaryColumns({
        entity,
        groupBy: validation.ok ? validation.spec.groupBy : [],
        measures: validation.ok ? validation.spec.measures : [],
      }),
    [entity, validation]
  );
  const rule = inactiveRule(entity);
  const hasCurrency = def.fields.some((f) => f.key === 'currency');

  const setGroup = (i: number, g: SummaryGroup) =>
    set({ groupBy: groupBy.map((x, j) => (j === i ? g : x)) });
  const setMeasure = (i: number, m: SummaryMeasure) =>
    set({ measures: measures.map((x, j) => (j === i ? m : x)) });

  return (
    <>
      <div className={sectionCls}>
        <label htmlFor="sum-entity" className={headingCls}>
          {t('wf.erp.source')}
        </label>
        <EntitySelect
          id="sum-entity"
          value={entity}
          onChange={(e) => onChange({ ...defaultSummary(e) })}
        />
        <p className="text-[0.66rem] text-muted-foreground">{entityDescription(entity, t)}</p>
        <p className="text-[0.62rem] text-muted-foreground">
          {moduleLabel(entity, t)} ·{' '}
          {canRead(entity) ? t('cat.permission.allowed') : t('cat.permission.denied')}
        </p>
        <p className="text-[0.62rem] text-muted-foreground">{t('sum.panel.database')}</p>
      </div>

      <div className={sectionCls}>
        <p className={headingCls}>{t('sum.panel.groupBy')}</p>
        <p className="text-[0.62rem] text-muted-foreground">{t('sum.panel.groupHelp')}</p>
        {groupBy.map((g, i) => {
          const current = byValue.get(keyOf(g));
          const dated = current && (current.def.type === 'date' || current.def.type === 'datetime');
          return (
            <div key={i} className="rounded-md border border-border p-2 space-y-1.5">
              <div className="flex gap-1.5">
                <select
                  className={inputCls}
                  aria-label={t('sum.panel.groupBy')}
                  value={keyOf(g)}
                  onChange={(e) => {
                    const o = byValue.get(e.target.value)!;
                    const date = o.def.type === 'date' || o.def.type === 'datetime';
                    setGroup(i, {
                      field: o.field,
                      ...(o.relation ? { relation: o.relation } : {}),
                      ...(date ? { bucket: 'month' as Bucket } : {}),
                    });
                  }}
                >
                  {!current && <option value={keyOf(g)}>{g.field}</option>}
                  {groupOptions.map((o) => (
                    <option
                      key={o.value}
                      value={o.value}
                      disabled={
                        Boolean(o.relation) &&
                        !canRead(
                          CATALOG[entity].relations.find((r) => r.key === o.relation)!.target
                        )
                      }
                    >
                      {optionLabel(o)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="p-1 text-muted-foreground hover:text-foreground"
                  aria-label={t('sum.panel.remove')}
                  title={t('sum.panel.remove')}
                  onClick={() => set({ groupBy: groupBy.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {dated && (
                <select
                  className={inputCls}
                  aria-label={t('sum.panel.bucket')}
                  value={g.bucket ?? ''}
                  onChange={(e) =>
                    setGroup(i, {
                      ...g,
                      bucket: (e.target.value || undefined) as Bucket | undefined,
                    })
                  }
                >
                  <option value="">{t('sum.bucket.exact')}</option>
                  {BUCKETS.map((b) => (
                    <option key={b} value={b}>
                      {t(`sum.bucket.${b}` as MessageKey)}
                    </option>
                  ))}
                </select>
              )}
              {g.relation && (
                <p className="text-[0.6rem] text-muted-foreground">
                  {t('cat.relation.explain', {
                    entity: t(`cat.entity.${entity}`),
                    target: t(
                      `cat.entity.${CATALOG[entity].relations.find((r) => r.key === g.relation)?.target ?? entity}` as MessageKey
                    ),
                    column:
                      CATALOG[entity].relations.find((r) => r.key === g.relation)?.column ?? '',
                  })}
                </p>
              )}
            </div>
          );
        })}
        {groupBy.length < SUMMARY_LIMITS.maxGroups && (
          <button
            type="button"
            className="flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
            onClick={() => {
              const first =
                groupOptions.find((o) => !o.relation && o.def.type === 'enum') ??
                groupOptions.find((o) => o.field !== 'id') ??
                groupOptions[0];
              set({
                groupBy: [
                  ...groupBy,
                  { field: first.field, ...(first.relation ? { relation: first.relation } : {}) },
                ],
              });
            }}
          >
            <Plus size={12} /> {t('sum.panel.addGroup')}
          </button>
        )}
      </div>

      <div className={sectionCls}>
        <p className={headingCls}>{t('sum.panel.measures')}</p>
        <p className="text-[0.62rem] text-muted-foreground">{t('sum.panel.measureHelp')}</p>
        {measures.map((m, i) => {
          const allowed = options.filter((o) => measureAllows(m.op, o));
          return (
            <div key={i} className="rounded-md border border-border p-2 space-y-1.5">
              <div className="flex gap-1.5">
                <select
                  className={inputCls}
                  aria-label={t('sum.panel.operation')}
                  value={m.op}
                  onChange={(e) => {
                    const op = e.target.value as MeasureOp;
                    if (op === 'count') return setMeasure(i, { op });
                    const keep = byValue.get(keyOf(m));
                    const o =
                      keep && measureAllows(op, keep)
                        ? keep
                        : options.find((x) => measureAllows(op, x));
                    setMeasure(
                      i,
                      o
                        ? { op, field: o.field, ...(o.relation ? { relation: o.relation } : {}) }
                        : { op: 'count' }
                    );
                  }}
                >
                  {MEASURE_OPS.map((op) => (
                    <option key={op} value={op}>
                      {t(`sum.opName.${op}` as MessageKey)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="p-1 text-muted-foreground hover:text-foreground"
                  aria-label={t('sum.panel.remove')}
                  title={t('sum.panel.remove')}
                  onClick={() => set({ measures: measures.filter((_, j) => j !== i) })}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {m.op !== 'count' && (
                <select
                  className={inputCls}
                  aria-label={t('sum.panel.field')}
                  value={keyOf(m)}
                  onChange={(e) => {
                    const o = byValue.get(e.target.value)!;
                    setMeasure(i, {
                      op: m.op,
                      field: o.field,
                      ...(o.relation ? { relation: o.relation } : {}),
                    });
                  }}
                >
                  {!allowed.some((o) => o.value === keyOf(m)) && (
                    <option value={keyOf(m)}>{m.field}</option>
                  )}
                  {allowed.map((o) => (
                    <option key={o.value} value={o.value}>
                      {optionLabel(o)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
        {measures.length < SUMMARY_LIMITS.maxMeasures && (
          <button
            type="button"
            className="flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
            onClick={() => {
              const amount = options.find(
                (o) =>
                  measureAllows('sum', o) && o.def.type === 'money' && o.def.currency !== 'document'
              );
              set({
                measures: [
                  ...measures,
                  amount ? { op: 'sum', field: amount.field } : { op: 'count' },
                ],
              });
            }}
          >
            <Plus size={12} /> {t('sum.panel.addMeasure')}
          </button>
        )}
        {hasCurrency && (
          <p className="text-[0.6rem] text-muted-foreground">{t('sum.panel.currencyHelp')}</p>
        )}
      </div>

      <div className={sectionCls}>
        <p className={headingCls}>{t('wf.erp.filters')}</p>
        <FiltersEditor
          entity={entity}
          filters={config.filters ?? []}
          onChange={(filters) => set({ filters })}
        />
        {rule && (
          <label className="flex items-start gap-2 text-[0.7rem] text-foreground cursor-pointer pt-1">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={config.includeInactive === true}
              onChange={(e) => set({ includeInactive: e.target.checked })}
            />
            <span>
              {t('sum.panel.includeInactive')}
              <span className="block text-[0.6rem] text-muted-foreground">
                {t('sum.panel.inactiveHelp')}
              </span>
            </span>
          </label>
        )}
      </div>

      <div className={sectionCls}>
        <label htmlFor="sum-sort" className={headingCls}>
          {t('wf.erp.sort')}
        </label>
        <div className="flex gap-1.5">
          <select
            id="sum-sort"
            className={inputCls}
            value={config.sort?.column ?? ''}
            onChange={(e) =>
              set({
                sort: e.target.value
                  ? { column: e.target.value, direction: config.sort?.direction ?? 'desc' }
                  : null,
              })
            }
          >
            <option value="">{t('sum.panel.sortGroups')}</option>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          {config.sort && (
            <select
              className={inputCls}
              aria-label={t('wf.erp.sort')}
              value={config.sort.direction}
              onChange={(e) => set({ sort: { ...config.sort, direction: e.target.value } })}
            >
              <option value="asc">{t('wf.opt.asc')}</option>
              <option value="desc">{t('wf.opt.desc')}</option>
            </select>
          )}
        </div>
        <label htmlFor="sum-limit" className="block text-[0.7rem] text-muted-foreground">
          {t('sum.panel.limit', { max: SUMMARY_LIMITS.maxRows })}
        </label>
        <input
          id="sum-limit"
          type="number"
          min={1}
          max={SUMMARY_LIMITS.maxRows}
          className={inputCls}
          value={config.limit ?? SUMMARY_LIMITS.defaultRows}
          onChange={(e) => set({ limit: Number(e.target.value) })}
        />
      </div>

      {!validation.ok && (
        <div className="p-4 border-b border-border" role="alert">
          <ul className="space-y-1 rounded-md border border-red-300/40 bg-red-50/40 dark:bg-red-950/20 p-2">
            {validation.errors.map((e, i) => (
              <li key={i} className="text-[0.68rem] text-red-600 dark:text-red-400">
                {t(summaryErrorKey(e.code) as MessageKey, {
                  detail: e.detail ?? '',
                  max: SUMMARY_LIMITS.maxRows,
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {validation.ok && (
        <div className={sectionCls}>
          <p className={headingCls}>{t('sum.panel.columns')}</p>
          <ul className="divide-y divide-border text-[0.66rem] text-muted-foreground">
            {columns.map((c) => (
              <ColumnInfoRow
                key={c.name}
                name={c.name}
                type={c.type}
                lineage={{
                  entity: c.entity,
                  ...(c.field ? { field: c.field } : {}),
                  ...(c.relation ? { relation: c.relation } : {}),
                  ...(c.op ? { op: c.op } : {}),
                  ...(c.bucket ? { bucket: c.bucket } : {}),
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
