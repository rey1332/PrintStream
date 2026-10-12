'use client';

import React, { useMemo } from 'react';
import { Link2, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useWorkspace } from '@/app/erp/lib/WorkspaceContext';
import { can } from '@/app/erp/lib/erpRules';
import {
  CATALOG,
  ENTITY_KEYS,
  getField,
  incomingRelations,
  type CatalogField,
  type EntityKey,
  type ErpModule,
} from '@/lib/analytics/catalog';
import {
  QUERY_LIMITS,
  operatorsFor,
  validateQuery,
  type FilterOp,
  type QueryFilter,
} from '@/lib/analytics/query';
import {
  entityDescription,
  entityLabel,
  fieldDescription,
  fieldLabel,
  moduleLabel,
  queryErrorMessage,
  relationLabel,
  typeLabel,
} from '@/lib/analytics/labels';
import { erpSourceSpec, type ErpSourceConfig } from '@/lib/workflow/registry';

const MODULE_ORDER: ErpModule[] = [
  'masterData',
  'sales',
  'purchasing',
  'inventory',
  'finance',
  'accounting',
];

export const inputCls =
  'w-full min-w-0 rounded-md border border-border bg-input px-2 py-1.5 text-[0.72rem] text-foreground outline-none focus:border-foreground/40';
export const sectionCls = 'p-4 border-b border-border space-y-2';
export const headingCls =
  'text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground';

export function useCanRead() {
  const { enabled, active } = useWorkspace();
  return (e: EntityKey) => !enabled || can(active?.permissions, CATALOG[e].permission);
}

export function EntitySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: EntityKey;
  onChange: (entity: EntityKey) => void;
}) {
  const { t } = useI18n();
  const canRead = useCanRead();
  return (
    <select
      id={id}
      className={inputCls}
      value={value}
      onChange={(e) => onChange(e.target.value as EntityKey)}
    >
      {MODULE_ORDER.map((m) => (
        <optgroup key={m} label={t(`cat.module.${m}`)}>
          {ENTITY_KEYS.filter((k) => CATALOG[k].module === m).map((k) => (
            <option key={k} value={k} disabled={!canRead(k)}>
              {entityLabel(k, t)}
              {canRead(k) ? '' : ` — ${t('cat.permission.denied')}`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function FiltersEditor({
  entity,
  filters,
  onChange,
}: {
  entity: EntityKey;
  filters: QueryFilter[];
  onChange: (filters: QueryFilter[]) => void;
}) {
  const { t } = useI18n();
  const def = CATALOG[entity];
  const filterable = def.fields.filter((f) => f.calculated !== 'engine');
  const setFilter = (i: number, patch: Partial<QueryFilter>) =>
    onChange(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <>
      {filters.map((filter, i) => {
        const field = getField(entity, filter.field) ?? filterable[0];
        return (
          <div key={i} className="rounded-md border border-border p-2 space-y-1.5">
            <div className="flex gap-1.5">
              <select
                className={inputCls}
                aria-label={t('wf.erp.fields')}
                value={field.key}
                onChange={(e) => {
                  const next = getField(entity, e.target.value)!;
                  setFilter(i, {
                    field: next.key,
                    op: operatorsFor(next.type, next.nullable)[0],
                    value: undefined,
                  });
                }}
              >
                {filterable.map((f) => (
                  <option key={f.key} value={f.key}>
                    {fieldLabel(f.key, t)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="p-1 text-muted-foreground hover:text-foreground"
                aria-label={t('wf.erp.removeFilter')}
                title={t('wf.erp.removeFilter')}
                onClick={() => onChange(filters.filter((_, j) => j !== i))}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <select
              className={inputCls}
              aria-label={t('wf.erp.filters')}
              value={filter.op}
              onChange={(e) =>
                setFilter(i, {
                  op: e.target.value as FilterOp,
                  value: e.target.value === 'in' ? [] : filter.value,
                })
              }
            >
              {operatorsFor(field.type, field.nullable).map((op) => (
                <option key={op} value={op}>
                  {t(`wf.op.${op}`)}
                </option>
              ))}
            </select>
            <FilterValue
              field={field}
              filter={filter}
              onChange={(value) => setFilter(i, { value })}
            />
          </div>
        );
      })}
      {filters.length < QUERY_LIMITS.maxFilters && filterable.length > 0 && (
        <button
          type="button"
          className="flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
          onClick={() => {
            const f = def.dateField ? getField(entity, def.dateField)! : filterable[0];
            onChange([...filters, { field: f.key, op: operatorsFor(f.type, f.nullable)[0] }]);
          }}
        >
          <Plus size={12} /> {t('wf.erp.addFilter')}
        </button>
      )}
    </>
  );
}

function defaultConfig(entity: EntityKey): ErpSourceConfig {
  return {
    entity,
    fields: CATALOG[entity].fields.filter((f) => f.key !== 'id').map((f) => f.key),
    related: [],
    filters: [],
    sort: null,
    limit: QUERY_LIMITS.defaultRows,
  };
}

function FieldBadges({ field }: { field: CatalogField }) {
  const { t } = useI18n();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="rounded bg-muted px-1 py-px text-[0.58rem] text-muted-foreground">
        {typeLabel(field.type, t)}
      </span>
      {field.nullable && (
        <span className="text-[0.58rem] text-muted-foreground">· {t('cat.nullable')}</span>
      )}
      {field.calculated && (
        <span className="text-[0.58rem] text-muted-foreground">
          · {t(`cat.calculated.${field.calculated}`)}
        </span>
      )}
      {field.references && (
        <span className="text-[0.58rem] text-muted-foreground">
          · {t('cat.links', { target: entityLabel(field.references, t) })}
        </span>
      )}
    </span>
  );
}

function FieldChecklist({
  entity,
  selected,
  onChange,
  idPrefix,
}: {
  entity: EntityKey;
  selected: string[];
  onChange: (fields: string[]) => void;
  idPrefix: string;
}) {
  const { t } = useI18n();
  const fields = CATALOG[entity].fields;
  const toggle = (key: string) =>
    onChange(
      selected.includes(key)
        ? selected.filter((k) => k !== key)
        : fields.filter((f) => f.key === key || selected.includes(f.key)).map((f) => f.key)
    );
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[0.62rem] text-muted-foreground">
        <span>{t('wf.erp.selectedCount', { count: selected.length })}</span>
        <span className="flex gap-2">
          <button
            type="button"
            className="hover:text-foreground underline underline-offset-2"
            onClick={() => onChange(fields.map((f) => f.key))}
          >
            {t('wf.erp.all')}
          </button>
          <button
            type="button"
            className="hover:text-foreground underline underline-offset-2"
            onClick={() => onChange([])}
          >
            {t('wf.erp.none')}
          </button>
        </span>
      </div>
      <ul className="max-h-64 overflow-y-auto rounded-md border border-border divide-y divide-border">
        {fields.map((field) => {
          const inputId = `${idPrefix}-${field.key}`;
          const description = fieldDescription(entity, field.key, t);
          return (
            <li key={field.key} className="px-2 py-1.5">
              <label htmlFor={inputId} className="flex items-start gap-2 cursor-pointer">
                <input
                  id={inputId}
                  type="checkbox"
                  className="mt-0.5"
                  checked={selected.includes(field.key)}
                  onChange={() => toggle(field.key)}
                />
                <span className="min-w-0 space-y-0.5">
                  <span className="block text-[0.72rem] text-foreground">
                    {fieldLabel(field.key, t)}{' '}
                    <code className="text-[0.6rem] text-muted-foreground">{field.key}</code>
                  </span>
                  {description && (
                    <span className="block text-[0.62rem] text-muted-foreground">
                      {description}
                    </span>
                  )}
                  <FieldBadges field={field} />
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilterValue({
  field,
  filter,
  onChange,
}: {
  field: CatalogField;
  filter: QueryFilter;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  if (filter.op === 'isNull' || filter.op === 'notNull') return null;
  if (filter.op === 'in') {
    const text = Array.isArray(filter.value) ? filter.value.join(', ') : '';
    return (
      <input
        className={inputCls}
        aria-label={t('wf.erp.values')}
        placeholder={field.enumValues?.join(', ') ?? t('wf.erp.values')}
        value={text}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          )
        }
      />
    );
  }
  if (field.type === 'enum' || field.type === 'boolean') {
    const options = field.type === 'boolean' ? ['true', 'false'] : [...(field.enumValues ?? [])];
    return (
      <select
        className={inputCls}
        aria-label={t('wf.erp.value')}
        value={String(filter.value ?? '')}
        onChange={(e) =>
          onChange(field.type === 'boolean' ? e.target.value === 'true' : e.target.value)
        }
      >
        <option value="" disabled>
          {t('wf.erp.value')}
        </option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  const numeric = field.type === 'integer' || field.type === 'number' || field.type === 'money';
  return (
    <input
      className={inputCls}
      aria-label={t('wf.erp.value')}
      type={field.type === 'date' ? 'date' : numeric ? 'number' : 'text'}
      value={filter.value === undefined || filter.value === null ? '' : String(filter.value)}
      onChange={(e) =>
        onChange(numeric ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)
      }
    />
  );
}

export default function ErpSourcePanel({
  config,
  onChange,
}: {
  config: ErpSourceConfig;
  onChange: (config: ErpSourceConfig) => void;
}) {
  const { t } = useI18n();
  // With workspaces off, every user reads only their own records, which they always may.
  const canRead = useCanRead();
  const entity = CATALOG[config.entity] ? config.entity : 'invoices';
  const def = CATALOG[entity];

  const validation = useMemo(
    () => validateQuery(erpSourceSpec({ ...config, entity })),
    [config, entity]
  );
  const set = (patch: Partial<ErpSourceConfig>) => onChange({ ...config, entity, ...patch });

  const relatedFields = (relation: string) =>
    config.related?.find((r) => r.relation === relation)?.fields ?? [];
  const setRelated = (relation: string, fields: string[]) =>
    set({
      related: [
        ...(config.related ?? []).filter((r) => r.relation !== relation),
        ...(fields.length ? [{ relation, fields }] : []),
      ],
    });

  const filterable = def.fields.filter((f) => f.calculated !== 'engine');
  const incoming = incomingRelations(entity);

  return (
    <>
      <div className={sectionCls}>
        <label htmlFor="erp-source-entity" className={headingCls}>
          {t('wf.erp.source')}
        </label>
        <EntitySelect
          id="erp-source-entity"
          value={entity}
          onChange={(e) => onChange(defaultConfig(e))}
        />
        <p className="text-[0.66rem] text-muted-foreground">{entityDescription(entity, t)}</p>
        <p className="text-[0.62rem] text-muted-foreground">
          {moduleLabel(entity, t)} · <code>{def.table}</code> ·{' '}
          {canRead(entity) ? t('cat.permission.allowed') : t('cat.permission.denied')}
        </p>
        <p className="text-[0.62rem] text-muted-foreground">{t('wf.erp.scope')}</p>
      </div>

      <div className={sectionCls}>
        <p className={headingCls}>{t('wf.erp.fields')}</p>
        <FieldChecklist
          entity={entity}
          selected={config.fields ?? []}
          onChange={(fields) => set({ fields })}
          idPrefix="erp-field"
        />
        <details className="text-[0.62rem] text-muted-foreground">
          <summary className="cursor-pointer">
            {t('wf.erp.excluded', { fields: 'user_id, workspace_id, created_by, …' })}
          </summary>
          <ul className="mt-1 space-y-1 list-disc pl-4">
            <li>{t('cat.excluded.owner')}</li>
            <li>{t('cat.excluded.actor')}</li>
            <li>{t('cat.excluded.link')}</li>
          </ul>
        </details>
      </div>

      <div className={sectionCls}>
        <p className={headingCls}>{t('wf.erp.related')}</p>
        {def.relations.length === 0 && (
          <p className="text-[0.66rem] text-muted-foreground">{t('wf.erp.noRelations')}</p>
        )}
        {def.relations.map((relation) => (
          <details
            key={relation.key}
            className="rounded-md border border-border"
            open={relatedFields(relation.key).length > 0}
          >
            <summary className="cursor-pointer px-2 py-1.5 text-[0.72rem] text-foreground flex items-center gap-1.5">
              <Link2 size={11} className="text-muted-foreground" />
              {relationLabel(relation.key, t)} → {entityLabel(relation.target, t)}
              {!canRead(relation.target) && (
                <span className="text-[0.6rem] text-muted-foreground">
                  ({t('cat.permission.denied')})
                </span>
              )}
            </summary>
            <div className="px-2 pb-2 space-y-1.5">
              <p className="text-[0.62rem] text-muted-foreground">
                {t('cat.relation.explain', {
                  entity: entityLabel(entity, t),
                  target: entityLabel(relation.target, t),
                  column: relation.column,
                })}
              </p>
              <FieldChecklist
                entity={relation.target}
                selected={relatedFields(relation.key)}
                onChange={(fields) => setRelated(relation.key, fields)}
                idPrefix={`erp-rel-${relation.key}`}
              />
            </div>
          </details>
        ))}
        {incoming.map(({ from }) => (
          <p key={from} className="text-[0.62rem] text-muted-foreground">
            {t('cat.relation.incoming', {
              source: entityLabel(from, t),
              entity: entityLabel(entity, t),
            })}
          </p>
        ))}
      </div>

      <div className={sectionCls}>
        <p className={headingCls}>{t('wf.erp.filters')}</p>
        <FiltersEditor
          entity={entity}
          filters={config.filters ?? []}
          onChange={(filters) => set({ filters })}
        />
      </div>

      <div className={sectionCls}>
        <label htmlFor="erp-sort" className={headingCls}>
          {t('wf.erp.sort')}
        </label>
        <div className="flex gap-1.5">
          <select
            id="erp-sort"
            className={inputCls}
            value={config.sort?.field ?? ''}
            onChange={(e) =>
              set({
                sort: e.target.value
                  ? { field: e.target.value, direction: config.sort?.direction ?? 'asc' }
                  : null,
              })
            }
          >
            <option value="">{t('wf.erp.defaultSort')}</option>
            {filterable.map((f) => (
              <option key={f.key} value={f.key}>
                {fieldLabel(f.key, t)}
              </option>
            ))}
          </select>
          {config.sort && (
            <select
              className={inputCls}
              aria-label={t('wf.erp.sort')}
              value={config.sort.direction}
              onChange={(e) =>
                set({
                  sort: { field: config.sort!.field, direction: e.target.value as 'asc' | 'desc' },
                })
              }
            >
              <option value="asc">{t('wf.opt.asc')}</option>
              <option value="desc">{t('wf.opt.desc')}</option>
            </select>
          )}
        </div>
        <label htmlFor="erp-limit" className="block text-[0.7rem] text-muted-foreground">
          {t('wf.erp.rowLimit', { max: QUERY_LIMITS.maxRows })}
        </label>
        <input
          id="erp-limit"
          type="number"
          min={1}
          max={QUERY_LIMITS.maxRows}
          className={inputCls}
          value={config.limit ?? QUERY_LIMITS.defaultRows}
          onChange={(e) => set({ limit: Number(e.target.value) })}
        />
      </div>

      {!validation.ok && (
        <div className="p-4 border-b border-border" role="alert">
          <ul className="space-y-1 rounded-md border border-red-300/40 bg-red-50/40 dark:bg-red-950/20 p-2">
            {validation.errors.map((error, i) => (
              <li key={i} className="text-[0.68rem] text-red-600 dark:text-red-400">
                {queryErrorMessage(error, t)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
