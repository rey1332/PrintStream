'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, Loader2, Search, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import type { MessageKey } from '@/lib/i18n/messages';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import {
  MODULE_ORDER,
  ONTOLOGY,
  ONTOLOGY_TYPES,
  ROLE_SEARCH_PRESETS,
  isOntologyType,
  recordHref,
  recordReference,
  type OntologyTypeKey,
} from '@/lib/ontology/registry';
import { SEARCH_LIMITS } from '@/lib/ontology/query';
import {
  OntologyApiError,
  readErpRecord,
  searchErp,
  type OntologyItem,
  type RecordResponse,
  type SearchResponse,
} from '@/lib/ontology/client';
import { currentNavItem } from '../components/shell/nav';
import { useWorkspace } from '../lib/WorkspaceContext';
import { canRead, isWorkspaceRole } from '../lib/erpRules';
import { useQueryParam } from '../lib/useFocusedRecord';

type T = ReturnType<typeof useI18n>['t'];
type Fmt = ReturnType<typeof useI18n>['fmt'];

const TYPES_KEY = 'etna.search.types';

function readStoredTypes(): OntologyTypeKey[] | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(TYPES_KEY) ?? 'null');
    return Array.isArray(raw) && raw.length > 0 && raw.every(isOntologyType) ? raw : null;
  } catch {
    return null;
  }
}

function storeTypes(types: OntologyTypeKey[]) {
  try {
    window.localStorage.setItem(TYPES_KEY, JSON.stringify(types));
  } catch {
    // Remembering the selection is a convenience only.
  }
}

function statusText(value: string, t: T): string {
  for (const key of [
    `status.${value}`,
    `onto.status.${value}`,
    `acc.src.${value}`,
    `acc.type.${value}`,
  ]) {
    if (hasMessage(key)) return t(key as MessageKey);
  }
  return value;
}

function formatProp(
  type: OntologyTypeKey,
  key: string,
  item: OntologyItem,
  t: T,
  fmt: Fmt
): string {
  const def = ONTOLOGY[type].properties.find((p) => p.key === key);
  const value = item.props[key];
  if (value === null || value === undefined || value === '') return '—';
  switch (def?.format) {
    case 'money':
      return def.documentCurrency
        ? fmt.moneyIn(Number(value), item.props.currency as string | null)
        : fmt.money(Number(value));
    case 'number':
      return fmt.number(Number(value));
    case 'date':
      return fmt.date(String(value));
    case 'datetime':
      return fmt.dateTime(String(value));
    case 'status':
      return statusText(String(value), t);
    case 'boolean':
      return value ? t('onto.yes') : t('onto.no');
    case 'ref':
      return def.refType ? recordReference(def.refType, String(value)) : String(value);
    default:
      return String(value);
  }
}

const refOf = (item: OntologyItem) =>
  recordReference(item.type, item.id, item.props as { entryNo?: unknown; code?: unknown });

function pageLabel(type: OntologyTypeKey, t: T): string {
  const nav = currentNavItem(ONTOLOGY[type].page.path);
  return nav ? t(nav.label) : ONTOLOGY[type].page.path;
}

const STATUS_TONE: Record<string, string> = {
  cancelled: 'text-muted-foreground',
  void: 'text-muted-foreground',
  reversed: 'text-amber-700 dark:text-amber-400',
  reversal: 'text-amber-700 dark:text-amber-400',
  overdue: 'text-red-600 dark:text-red-400',
  unpaid: 'text-amber-700 dark:text-amber-400',
  pending: 'text-amber-700 dark:text-amber-400',
  paid: 'text-green-700 dark:text-green-400',
  received: 'text-green-700 dark:text-green-400',
  delivered: 'text-green-700 dark:text-green-400',
};

function ResultRow({
  item,
  selected,
  onSelect,
}: {
  item: OntologyItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t, fmt } = useI18n();
  const def = ONTOLOGY[item.type];
  const status = def.status ? String(item.props[def.status.property] ?? '') : '';
  const facts = def.summary
    .filter((k) => k !== def.status?.property && item.props[k] !== null && item.props[k] !== '')
    .map((k) => `${t(`onto.prop.${k}` as MessageKey)} ${formatProp(item.type, k, item, t, fmt)}`);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`w-full text-left px-3 py-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 hover:bg-[var(--surface-3)] max-lg:min-h-11 ${selected ? 'bg-[var(--surface-3)]' : ''}`}
      >
        <span className="min-w-0 truncate text-[0.8rem] text-foreground">
          <span className="font-mono text-[0.7rem] text-muted-foreground mr-2">{refOf(item)}</span>
          <span className="font-medium">{formatProp(item.type, def.title, item, t, fmt)}</span>
        </span>
        <span className="text-right text-[0.78rem] tabular-nums text-foreground">
          {def.amount && item.props[def.amount] !== null
            ? formatProp(item.type, def.amount, item, t, fmt)
            : ''}
        </span>
        <span className="min-w-0 truncate text-[0.7rem] text-muted-foreground">
          {status && (
            <span className={`mr-2 font-medium ${STATUS_TONE[status] ?? 'text-foreground'}`}>
              {statusText(status, t)}
            </span>
          )}
          {facts.join(' · ')}
        </span>
        <span className="text-right text-[0.7rem] text-muted-foreground tabular-nums">
          {def.date ? formatProp(item.type, def.date, item, t, fmt) : ''}
        </span>
      </button>
    </li>
  );
}

function RecordPanel({
  workspaceId,
  record,
  onOpen,
  onBack,
  canGoBack,
  onClose,
}: {
  workspaceId: string | null;
  record: { type: OntologyTypeKey; id: string };
  onOpen: (type: OntologyTypeKey, id: string) => void;
  onBack: () => void;
  canGoBack: boolean;
  onClose: () => void;
}) {
  const { t, fmt } = useI18n();
  const [data, setData] = useState<RecordResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    readErpRecord(workspaceId, record.type, record.id, controller.signal)
      .then(setData)
      .catch((e) => {
        if (controller.signal.aborted) return;
        const key = `onto.err.${e instanceof OntologyApiError ? e.code : 'generic'}`;
        setError(t((hasMessage(key) ? key : 'onto.err.generic') as MessageKey));
      });
    return () => controller.abort();
  }, [workspaceId, record.type, record.id, t]);

  const def = ONTOLOGY[record.type];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {canGoBack && (
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground max-lg:h-11 max-lg:w-11"
            aria-label={t('wf.back')}
          >
            <ArrowLeft size={14} />
          </button>
        )}
        <p className="flex-1 truncate px-1 text-[0.72rem] font-semibold uppercase tracking-wider text-muted-foreground">
          {t(`onto.type.${record.type}` as MessageKey)}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground max-lg:h-11 max-lg:w-11"
          aria-label={t('onto.close')}
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
        {error && (
          <p className="text-[0.78rem] text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        {!data && !error && (
          <Loader2
            size={16}
            className="animate-spin text-muted-foreground"
            aria-label={t('onto.searching')}
          />
        )}
        {data && (
          <>
            <div className="space-y-1">
              <p className="font-mono text-[0.72rem] text-muted-foreground">{refOf(data.item)}</p>
              <h2 className="text-[0.95rem] font-semibold text-foreground break-words">
                {formatProp(record.type, def.title, data.item, t, fmt)}
              </h2>
              <Link
                href={recordHref(record.type, record.id, data.item.props)}
                className="inline-flex items-center gap-1 text-[0.75rem] text-primary hover:underline"
              >
                <ExternalLink size={11} />{' '}
                {t('onto.openRecord', { page: pageLabel(record.type, t) })}
              </Link>
            </div>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.75rem]">
              {def.properties
                .filter((p) => p.key !== def.title)
                .map((p) => (
                  <React.Fragment key={p.key}>
                    <dt className="text-muted-foreground">
                      {t(`onto.prop.${p.key}` as MessageKey)}
                    </dt>
                    <dd className="text-foreground break-words tabular-nums">
                      {formatProp(record.type, p.key, data.item, t, fmt)}
                    </dd>
                  </React.Fragment>
                ))}
            </dl>
            <section className="space-y-3" aria-label={t('onto.related')}>
              <h3 className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('onto.related')}
              </h3>
              {data.relations.map((rel) => (
                <div key={rel.key} className="space-y-1">
                  <p className="text-[0.72rem] font-medium text-foreground">
                    {t(`onto.rel.${rel.key}` as MessageKey)}
                    {rel.cardinality === 'many' && (
                      <span className="ml-1 text-muted-foreground tabular-nums">
                        (
                        {rel.total > SEARCH_LIMITS.countCap
                          ? `${fmt.number(SEARCH_LIMITS.countCap)}+`
                          : fmt.number(rel.total)}
                        )
                      </span>
                    )}
                  </p>
                  {rel.items.length === 0 ? (
                    <p className="text-[0.7rem] text-muted-foreground">{t('onto.relatedNone')}</p>
                  ) : (
                    <ul className="rounded-md border border-border divide-y divide-border overflow-hidden">
                      {rel.items.map((item) => (
                        <ResultRow
                          key={item.id}
                          item={item}
                          selected={false}
                          onSelect={() => onOpen(item.type, item.id)}
                        />
                      ))}
                    </ul>
                  )}
                  {rel.total > rel.items.length && (
                    <p className="text-[0.68rem] text-muted-foreground">
                      {rel.total > SEARCH_LIMITS.countCap
                        ? t('onto.relatedMoreCap', { count: fmt.number(SEARCH_LIMITS.countCap) })
                        : t('onto.relatedMore', {
                            count: fmt.number(rel.total - rel.items.length),
                          })}
                    </p>
                  )}
                </div>
              ))}
              {data.hiddenRelations.length > 0 && (
                <p className="text-[0.7rem] text-muted-foreground">{t('onto.hiddenRelations')}</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default function ErpSearchPage() {
  const { t, fmt } = useI18n();
  const { active, role, enabled: workspacesOn } = useWorkspace();
  const { isDesktop } = useUiMode();
  const workspaceId = workspacesOn ? (active?.id ?? null) : null;
  // Only the types this role may read are offered (the server checks again).
  const readable = useMemo(
    () => ONTOLOGY_TYPES.filter((type) => canRead(active?.permissions, ONTOLOGY[type].area)),
    [active]
  );
  // A custom role has no preset: everything it may read is offered.
  const preset = (isWorkspaceRole(role) ? ROLE_SEARCH_PRESETS[role] : readable).filter((type) =>
    readable.includes(type)
  );

  const linkedQuery = useQueryParam('q');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [types, setTypes] = useState<OntologyTypeKey[]>([...preset]);
  const [status, setStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [stack, setStack] = useState<{ type: OntologyTypeKey; id: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = readStoredTypes()?.filter((type) => readable.includes(type));
    if (stored && stored.length > 0) setTypes(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (linkedQuery) {
      setQ(linkedQuery);
      setDebounced(linkedQuery);
    }
  }, [linkedQuery]);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 300);
    return () => window.clearTimeout(id);
  }, [q]);

  const single = types.length === 1 ? types[0] : null;
  const statusValues = single ? (ONTOLOGY[single].status?.values ?? []) : [];
  const hasFilter = Boolean(status || dateFrom || dateTo);
  const minLength = single ? 2 : SEARCH_LIMITS.minMultiTypeLength;
  const ready = debounced.length >= minLength || (single !== null && hasFilter);

  const input = useMemo(
    () => ({
      q: debounced,
      types,
      statuses: single && status ? [status] : null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
    }),
    [debounced, types, single, status, dateFrom, dateTo]
  );

  const errorText = (e: unknown) => {
    const key = `onto.err.${e instanceof OntologyApiError ? e.code : 'generic'}`;
    return t((hasMessage(key) ? key : 'onto.err.generic') as MessageKey);
  };

  useEffect(() => {
    if (!ready) {
      setResult(null);
      setError('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    searchErp(workspaceId, input, controller.signal)
      .then((r) => setResult(r))
      .catch((e) => {
        if (!controller.signal.aborted) {
          setResult(null);
          setError(errorText(e));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, workspaceId, input]);

  const loadMore = useCallback(async () => {
    if (!result || !single) return;
    const group = result.groups[0];
    setLoading(true);
    try {
      const next = await searchErp(workspaceId, {
        ...input,
        offset: group.offset + group.items.length,
      });
      const more = next.groups[0];
      setResult({
        ...next,
        groups: [{ ...more, offset: group.offset, items: [...group.items, ...more.items] }],
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, single, workspaceId, input]);

  const chooseTypes = (next: OntologyTypeKey[]) => {
    const ordered = readable.filter((type) => next.includes(type));
    if (ordered.length === 0) return;
    setTypes(ordered);
    storeTypes(ordered);
    if (ordered.length !== 1) setStatus('');
  };
  const toggleType = (type: OntologyTypeKey) =>
    chooseTypes(types.includes(type) ? types.filter((x) => x !== type) : [...types, type]);

  const openRecord = (type: OntologyTypeKey, id: string, fromPanel = false) =>
    setStack((s) => (fromPanel ? [...s, { type, id }] : [{ type, id }]));
  const selected = stack[stack.length - 1] ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStack([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chip = (on: boolean) =>
    `px-2 py-1 rounded-md border text-[0.7rem] transition-colors max-lg:min-h-9 ${on ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'}`;
  const field =
    'rounded-md border border-border bg-background px-2 py-1.5 text-[0.78rem] text-foreground max-lg:min-h-11';
  const total = (n: number) =>
    n > SEARCH_LIMITS.countCap
      ? t('onto.countMore', { count: fmt.number(SEARCH_LIMITS.countCap) })
      : t('onto.count', { count: fmt.number(n) });

  const panel = selected && (
    <RecordPanel
      workspaceId={workspaceId}
      record={selected}
      onOpen={(type, id) => openRecord(type, id, true)}
      onBack={() => setStack((s) => s.slice(0, -1))}
      canGoBack={stack.length > 1}
      onClose={() => setStack([])}
    />
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[1.25rem] font-bold text-foreground">{t('onto.title')}</h1>
        <p className="text-[0.8rem] text-muted-foreground mt-0.5 max-w-3xl">{t('onto.subtitle')}</p>
      </div>

      <div className="rounded-lg border border-border bg-card p-3 space-y-3">
        <label className="relative block">
          <span className="sr-only">{t('onto.searchLabel')}</span>
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={inputRef}
            type="search"
            autoFocus
            value={q}
            maxLength={SEARCH_LIMITS.maxQueryLength}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setDebounced(q.trim());
            }}
            placeholder={t('onto.placeholder')}
            className="w-full rounded-md border border-border bg-background pl-9 pr-3 py-2 text-[0.85rem] text-foreground outline-none focus:border-primary max-lg:min-h-11"
          />
        </label>

        <div className="space-y-2" role="group" aria-label={t('onto.typesLabel')}>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={chip(
                preset.length === types.length && preset.every((x) => types.includes(x))
              )}
              onClick={() => chooseTypes([...preset])}
            >
              {t('onto.preset', {
                role: active?.customRoleName ?? t(`role.${role}` as MessageKey),
              })}
            </button>
            <button
              type="button"
              className={chip(types.length === readable.length)}
              onClick={() => chooseTypes([...readable])}
            >
              {t('onto.allTypes')}
            </button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {MODULE_ORDER.map((module) => {
              const inModule = readable.filter((type) => ONTOLOGY[type].module === module);
              if (inModule.length === 0) return null;
              return (
                <div key={module} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[0.62rem] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t(`onto.module.${module}` as MessageKey)}
                  </span>
                  {inModule.map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={types.includes(type)}
                      className={chip(types.includes(type))}
                      onClick={() => toggleType(type)}
                    >
                      {t(`onto.types.${type}` as MessageKey)}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[0.7rem] text-muted-foreground">
            {t('onto.prop.status')}
            <select
              className={`${field} block mt-1`}
              value={status}
              disabled={!single || statusValues.length === 0}
              onChange={(e) => setStatus(e.target.value)}
              title={single ? undefined : t('onto.statusHint')}
            >
              <option value="">{t('onto.statusAny')}</option>
              {statusValues.map((v) => (
                <option key={v} value={v}>
                  {statusText(v, t)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[0.7rem] text-muted-foreground">
            {t('onto.dateFrom')}
            <input
              type="date"
              className={`${field} block mt-1`}
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </label>
          <label className="text-[0.7rem] text-muted-foreground">
            {t('onto.dateTo')}
            <input
              type="date"
              className={`${field} block mt-1`}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </label>
          {hasFilter && (
            <button
              type="button"
              className="text-[0.72rem] text-muted-foreground hover:text-foreground underline underline-offset-2 max-lg:min-h-11"
              onClick={() => {
                setStatus('');
                setDateFrom('');
                setDateTo('');
              }}
            >
              {t('onto.clearFilters')}
            </button>
          )}
          {!single && (
            <p className="text-[0.68rem] text-muted-foreground">{t('onto.statusHint')}</p>
          )}
        </div>
      </div>

      <div
        className={`grid gap-4 ${selected && isDesktop ? 'lg:grid-cols-[minmax(0,1fr)_380px]' : ''}`}
      >
        <div className="min-w-0 space-y-3" aria-busy={loading}>
          <p className="text-[0.72rem] text-muted-foreground" role="status" aria-live="polite">
            {loading ? (
              <>
                <Loader2 size={11} className="inline animate-spin mr-1" />
                {t('onto.searching')}
              </>
            ) : !ready ? (
              t('onto.startHint')
            ) : (
              ''
            )}
          </p>
          {error && (
            <p className="text-[0.78rem] text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          )}
          {result && result.excludedTypes.length > 0 && (
            <p className="text-[0.72rem] text-muted-foreground">
              {t('onto.excluded', {
                types: result.excludedTypes
                  .map((x) => t(`onto.types.${x}` as MessageKey))
                  .join(', '),
              })}
            </p>
          )}
          {ready && result && !error && result.groups.every((g) => g.items.length === 0) && (
            <p className="rounded-lg border border-border bg-card p-6 text-center text-[0.8rem] text-muted-foreground">
              {t('onto.noResults')}
            </p>
          )}
          {ready &&
            result?.groups
              .filter((g) => g.items.length > 0)
              .map((group) => (
                <section
                  key={group.type}
                  className="rounded-lg border border-border bg-card overflow-hidden"
                  aria-label={t(`onto.types.${group.type}` as MessageKey)}
                >
                  <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-3 py-2">
                    <h2 className="text-[0.75rem] font-semibold text-foreground">
                      {t(`onto.types.${group.type}` as MessageKey)}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {total(group.total)}
                      </span>
                    </h2>
                    <span className="text-[0.66rem] text-muted-foreground">
                      {t('onto.searchesIn', {
                        fields: ONTOLOGY[group.type].searchFields.join(', '),
                      })}
                    </span>
                  </header>
                  <ul className="divide-y divide-border">
                    {group.items.map((item) => (
                      <ResultRow
                        key={item.id}
                        item={item}
                        selected={selected?.id === item.id}
                        onSelect={() => openRecord(item.type, item.id)}
                      />
                    ))}
                  </ul>
                  {group.hasMore && (
                    <div className="border-t border-border px-3 py-2">
                      {single ? (
                        <button
                          type="button"
                          onClick={loadMore}
                          disabled={loading}
                          className="text-[0.72rem] text-primary hover:underline disabled:opacity-50 max-lg:min-h-11"
                        >
                          {t('onto.loadMore')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => chooseTypes([group.type])}
                          className="text-[0.72rem] text-primary hover:underline max-lg:min-h-11"
                        >
                          {t('onto.showAllOfType', {
                            type: t(`onto.types.${group.type}` as MessageKey),
                          })}
                        </button>
                      )}
                    </div>
                  )}
                </section>
              ))}
          {single && preset.length !== 1 && result && (
            <button
              type="button"
              onClick={() => chooseTypes([...preset])}
              className="text-[0.72rem] text-muted-foreground hover:text-foreground underline underline-offset-2"
            >
              {t('onto.backToAll')}
            </button>
          )}
          <p className="text-[0.66rem] text-muted-foreground">{t('onto.logged')}</p>
        </div>

        {selected && isDesktop && (
          <aside className="rounded-lg border border-border bg-card overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100vh-8rem)]">
            {panel}
          </aside>
        )}
      </div>

      {selected && !isDesktop && (
        <div
          role="dialog"
          aria-label={t(`onto.type.${selected.type}` as MessageKey)}
          className="fixed inset-x-0 bottom-0 z-40 flex h-[80%] flex-col overflow-hidden rounded-t-xl border-t border-border bg-card shadow-2xl"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          {panel}
        </div>
      )}
    </div>
  );
}
