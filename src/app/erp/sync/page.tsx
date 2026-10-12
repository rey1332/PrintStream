'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Trash2,
  LogOut,
  Eraser,
  X,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useAuth } from '@/contexts/AuthContext';
import { createClient } from '@/lib/data/client';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../lib/WorkspaceContext';
import { DeleteErpSection } from '../components/DeleteErpSection';
import {
  DOCUMENT_ENTITIES,
  SYNC_ENTITIES,
  SyncError,
  syncService,
  type SyncCounts,
  type SyncDirection,
  type SyncEntity,
  type SyncOverview,
  type SyncStatus,
} from '../lib/syncService';

const inputCls =
  'rounded-lg border border-border bg-card px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

const DIRECTIONS: { value: SyncDirection; label: MessageKey; hint: MessageKey }[] = [
  { value: 'push', label: 'sync.dir.push', hint: 'sync.dir.pushHint' },
  { value: 'pull', label: 'sync.dir.pull', hint: 'sync.dir.pullHint' },
  { value: 'both', label: 'sync.dir.both', hint: 'sync.dir.bothHint' },
];

const MASTER: SyncEntity[] = ['customers', 'suppliers', 'products', 'stock'];

const entityLabel = (e: SyncEntity) => `sync.entity.${e}` as MessageKey;

function StatusBadge({ status }: { status: SyncStatus | 'running' }) {
  const { t } = useI18n();
  const cls =
    status === 'success'
      ? 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300'
      : status === 'partial'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
        : status === 'failed'
          ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300'
          : 'bg-[var(--surface-3)] text-muted-foreground';
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[0.68rem] ${cls}`}>
      {t(`sync.status.${status}` as MessageKey)}
    </span>
  );
}

function CountsLine({ counts }: { counts: Omit<SyncCounts, 'messages'> }) {
  const { t, fmt } = useI18n();
  return (
    <span className="tabular-nums">
      {t('sync.summary', {
        ok: fmt.number(counts.ok),
        skipped: fmt.number(counts.skipped),
        failed: fmt.number(counts.failed),
      })}
    </span>
  );
}

function Messages({ counts }: { counts: SyncCounts }) {
  const { t } = useI18n();
  if (counts.messages.length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[0.72rem] text-muted-foreground">
        {t('sync.notes')} ({counts.messages.length})
      </summary>
      <ul className="mt-1 space-y-0.5 text-[0.72rem]">
        {counts.messages.map((m, i) => (
          <li
            key={i}
            className={
              m.kind === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'
            }
          >
            <span className="font-medium">{m.item}</span>: {m.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

interface SetupState {
  source: string;
  targets: string[];
  direction: SyncDirection;
  entities: SyncEntity[];
  since: string;
}

interface StepResult {
  target: string;
  entity: SyncEntity;
  counts: SyncCounts;
}

export default function SyncPage() {
  const { t, fmt } = useI18n();
  const { workspaces, active, selectWorkspace, refresh } = useWorkspace();
  const { user } = useAuth();
  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{
    id: string;
    name: string;
    mode: 'delete' | 'empty' | 'leave';
  } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [phase, setPhase] = useState<'setup' | 'running' | 'done'>('setup');
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
  const [steps, setSteps] = useState<StepResult[]>([]);
  const [outcome, setOutcome] = useState<{ status: SyncStatus | null; error: string }>({
    status: null,
    error: '',
  });
  const menuRef = useRef<HTMLDivElement>(null);

  const errorText = useCallback(
    (err: unknown) => t(err instanceof SyncError ? err.key : 'sync.err.failed'),
    [t]
  );

  const load = useCallback(async () => {
    setError('');
    try {
      setOverview(await syncService.overview());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [errorText]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const erps = useMemo(() => overview?.erps ?? [], [overview]);
  const nameOf = useCallback(
    (id: string) => erps.find((e) => e.id === id)?.name ?? t('sync.removedErp'),
    [erps, t]
  );
  const selectable = (id: string) => {
    const erp = erps.find((e) => e.id === id);
    return !!erp && erp.canSync && erp.syncEnabled;
  };
  const chosen = [...selected].filter(selectable);

  // Latest sync touching each ERP.
  const lastSync = useMemo(() => {
    const map = new Map<string, { at: string; status: SyncStatus }>();
    for (const p of overview?.pairs ?? []) {
      for (const id of [p.source, p.target]) {
        const current = map.get(id);
        if (!current || current.at < p.lastSyncAt)
          map.set(id, { at: p.lastSyncAt, status: p.lastStatus });
      }
    }
    return map;
  }, [overview]);

  // Last sync per directed pair, newest first.
  const pairs = useMemo(() => {
    const groups = new Map<
      string,
      { source: string; target: string; rows: SyncOverview['pairs'] }
    >();
    for (const p of overview?.pairs ?? []) {
      const key = `${p.source}>${p.target}`;
      const g = groups.get(key) ?? { source: p.source, target: p.target, rows: [] };
      g.rows.push(p);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      g.rows.sort((x, y) => SYNC_ENTITIES.indexOf(x.entity) - SYNC_ENTITIES.indexOf(y.entity));
    }
    return [...groups.values()];
  }, [overview]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function setIncluded(id: string, name: string, enabled: boolean) {
    setToggling(id);
    try {
      await syncService.setEnabled(id, enabled);
      toast.success(t(enabled ? 'sync.includedOn' : 'sync.includedOff', { name }));
      if (!enabled) setSelected((prev) => new Set([...prev].filter((x) => x !== id)));
      await load();
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setToggling(null);
    }
  }

  function openSync(direction: SyncDirection) {
    setMenuOpen(false);
    if (chosen.length < 2) return;
    const source = active && chosen.includes(active.id) ? active.id : chosen[0];
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const pad = (n: number) => String(n).padStart(2, '0');
    setSetup({
      source,
      targets: chosen.filter((id) => id !== source),
      direction,
      entities: ['customers', 'suppliers', 'products'],
      since: `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`,
    });
    setPhase('setup');
    setSteps([]);
    setOutcome({ status: null, error: '' });
  }

  async function startSync() {
    if (!setup || setup.targets.length === 0 || setup.entities.length === 0) return;
    setPhase('running');
    setSteps([]);
    setProgress({ done: 0, total: setup.targets.length * setup.entities.length, label: '' });
    try {
      const result = await syncService.run(
        {
          source: setup.source,
          targets: setup.targets,
          direction: setup.direction,
          entities: setup.entities,
          since: setup.entities.some((e) => DOCUMENT_ENTITIES.includes(e)) ? setup.since : null,
        },
        (p) => {
          setProgress({
            done: p.done,
            total: p.total,
            label: t('sync.dialog.step', {
              entity: t(entityLabel(p.entity)),
              erp: nameOf(p.target),
            }),
          });
          if (p.counts) {
            const counts = p.counts;
            setSteps((prev) => [...prev, { target: p.target, entity: p.entity, counts }]);
          }
        }
      );
      setOutcome({ status: result.status, error: '' });
    } catch (err) {
      setOutcome({ status: null, error: errorText(err) });
    } finally {
      setPhase('done');
      void load();
    }
  }

  async function leave(id: string, name: string) {
    if (!user?.id || leaving) return;
    setLeaving(true);
    try {
      const { error: leaveError } = await createClient().rpc('erp_remove_workspace_member', {
        p_workspace_id: id,
        p_user_id: user.id,
        p_reason: '',
      });
      if (leaveError) throw leaveError;
      toast.success(t('sync.leftToast', { name }));
      const personal = workspaces.find((w) => w.isOwner && w.isPersonal);
      if (personal && active?.id === id) selectWorkspace(personal.id);
      setDeleting(null);
      setSelected((prev) => new Set([...prev].filter((x) => x !== id)));
      await refresh();
      await load();
    } catch {
      toast.error(t('sync.err.failed'));
    } finally {
      setLeaving(false);
    }
  }

  const closeSync = () => {
    if (phase === 'running') return;
    setSetup(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.sync')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5 max-w-2xl">
            {t('sync.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[0.75rem] text-muted-foreground" aria-live="polite">
            {chosen.length >= 2
              ? t('sync.selected', { n: fmt.number(chosen.length) })
              : t('sync.selectHint')}
          </span>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              disabled={chosen.length < 2}
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
            >
              <ArrowLeftRight size={14} /> {t('sync.button')} <ChevronDown size={13} />
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label={t('sync.chooseDirection')}
                className="absolute right-0 z-30 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
              >
                {DIRECTIONS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    role="menuitem"
                    onClick={() => openSync(d.value)}
                    className="block w-full px-3 py-2 text-left hover:bg-[var(--surface-3)] max-lg:min-h-11"
                  >
                    <span className="block text-[0.8rem] font-medium text-foreground">
                      {t(d.label)}
                    </span>
                    <span className="block text-[0.7rem] text-muted-foreground">{t(d.hint)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <p className="text-[0.8rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-[0.8rem]">
            <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
              <tr>
                <th className="w-10 px-4 py-2">
                  <span className="sr-only">{t('sync.button')}</span>
                </th>
                <th className="px-4 py-2 font-medium">{t('sync.col.erp')}</th>
                <th className="px-4 py-2 font-medium">{t('sync.col.currency')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('sync.col.members')}</th>
                <th className="px-4 py-2 font-medium">{t('sync.col.included')}</th>
                <th className="px-4 py-2 font-medium">{t('sync.col.lastSync')}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {erps.map((erp) => {
                const ws = workspaces.find((w) => w.id === erp.id);
                const personal = !!ws?.isPersonal;
                const removal: 'delete' | 'empty' | 'leave' = personal
                  ? 'empty'
                  : ws?.isOwner
                    ? 'delete'
                    : 'leave';
                const removalLabel = t(
                  removal === 'empty'
                    ? 'settings.emptyErp'
                    : removal === 'delete'
                      ? 'settings.deleteErp'
                      : 'sync.leave'
                );
                const canPick = erp.canSync && erp.syncEnabled;
                const last = lastSync.get(erp.id);
                return (
                  <tr key={erp.id} className="border-t border-border">
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={canPick && selected.has(erp.id)}
                        disabled={!canPick}
                        onChange={() => toggleSelected(erp.id)}
                        aria-label={t('sync.select', { name: erp.name })}
                        title={
                          !erp.canSync
                            ? t('sync.cannot')
                            : !erp.syncEnabled
                              ? t('sync.excluded')
                              : undefined
                        }
                        className="h-4 w-4 accent-[var(--primary)] disabled:opacity-40"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <span className="font-medium text-foreground">{erp.name}</span>
                      <span className="ml-2 text-[0.7rem] text-muted-foreground">
                        {personal
                          ? t('sync.personal')
                          : ws?.isOwner
                            ? t('sync.created')
                            : `${t('sync.joined')} · ${erp.role ?? ''}`}
                      </span>
                      {erp.id === active?.id && (
                        <span className="ml-2 rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[0.62rem] text-muted-foreground">
                          {t('nav.file.active')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{erp.baseCurrency}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{fmt.number(erp.members)}</td>
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={erp.syncEnabled}
                        aria-label={`${t('sync.col.included')}: ${erp.name}`}
                        title={erp.canSync ? undefined : t('sync.cannot')}
                        disabled={!erp.canSync || toggling === erp.id}
                        onClick={() => void setIncluded(erp.id, erp.name, !erp.syncEnabled)}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
                          erp.syncEnabled ? 'bg-primary' : 'bg-[var(--surface-3)]'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
                            erp.syncEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {last ? (
                        <span className="flex items-center gap-2">
                          <span className="text-muted-foreground">{fmt.dateTime(last.at)}</span>
                          <StatusBadge status={last.status} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t('sync.never')}</span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <button
                        type="button"
                        onClick={() => setDeleting({ id: erp.id, name: erp.name, mode: removal })}
                        title={removalLabel}
                        aria-label={`${removalLabel}: ${erp.name}`}
                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-[0.75rem] text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30 max-lg:h-11"
                      >
                        {removal === 'leave' ? (
                          <LogOut size={14} />
                        ) : removal === 'empty' ? (
                          <Eraser size={14} />
                        ) : (
                          <Trash2 size={14} />
                        )}
                        <span className="hidden xl:inline">{removalLabel}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && (
        <section aria-labelledby="sync-pairs" className="space-y-2">
          <h2 id="sync-pairs" className="text-[0.85rem] font-semibold text-foreground">
            {t('sync.pairs.title')}
          </h2>
          {pairs.length === 0 ? (
            <p className="text-[0.8rem] text-muted-foreground">{t('sync.pairs.empty')}</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {pairs.map((g) => (
                <div
                  key={`${g.source}>${g.target}`}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <p className="mb-2 flex items-center gap-2 text-[0.8rem] font-medium text-foreground">
                    {nameOf(g.source)} <ArrowRight size={13} className="text-muted-foreground" />{' '}
                    {nameOf(g.target)}
                  </p>
                  <ul className="space-y-1.5">
                    {g.rows.map((p) => (
                      <li
                        key={p.entity}
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[0.75rem]"
                      >
                        <span className="text-foreground">{t(entityLabel(p.entity))}</span>
                        <span className="flex items-center gap-2 text-muted-foreground">
                          {fmt.dateTime(p.lastSyncAt)} <StatusBadge status={p.lastStatus} />
                        </span>
                        <span className="w-full text-[0.7rem] text-muted-foreground">
                          <CountsLine counts={p.counts} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {!loading && (overview?.runs.length ?? 0) > 0 && (
        <section aria-labelledby="sync-runs" className="space-y-2">
          <h2 id="sync-runs" className="text-[0.85rem] font-semibold text-foreground">
            {t('sync.runs.title')}
          </h2>
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {overview!.runs.map((r) => {
              const all = Object.values(r.result).flatMap((byEntity) => Object.values(byEntity));
              const totals = all.reduce(
                (acc, c) => ({
                  ok: acc.ok + (c?.ok ?? 0),
                  skipped: acc.skipped + (c?.skipped ?? 0),
                  failed: acc.failed + (c?.failed ?? 0),
                }),
                { ok: 0, skipped: 0, failed: 0 }
              );
              return (
                <li key={r.id} className="px-4 py-3 text-[0.78rem]">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium text-foreground">
                      {nameOf(r.source)}{' '}
                      {r.direction === 'push' ? '→' : r.direction === 'pull' ? '←' : '⇄'}{' '}
                      {r.targets.map(nameOf).join(', ')}
                    </span>
                    <StatusBadge status={r.status} />
                    <span className="text-muted-foreground">{fmt.dateTime(r.startedAt)}</span>
                    {r.startedBy && (
                      <span className="text-muted-foreground">
                        {t('sync.runs.by', { email: r.startedBy })}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[0.72rem] text-muted-foreground">
                    {r.entities.map((e) => t(entityLabel(e))).join(', ')} ·{' '}
                    <CountsLine counts={totals} />
                  </p>
                  {all.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-[0.72rem] text-muted-foreground">
                        {t('sync.runs.details')}
                      </summary>
                      <div className="mt-1 space-y-1">
                        {Object.entries(r.result).map(([target, byEntity]) =>
                          Object.entries(byEntity).map(([entity, c]) =>
                            c ? (
                              <div key={`${target}-${entity}`} className="text-[0.72rem]">
                                <span className="text-foreground">
                                  {nameOf(target)} · {t(entityLabel(entity as SyncEntity))}
                                </span>
                                : <CountsLine counts={c} />
                                <Messages counts={c} />
                              </div>
                            ) : null
                          )
                        )}
                      </div>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {setup && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeSync();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sync-title"
            className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-card p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 id="sync-title" className="text-[1rem] font-semibold text-foreground">
                {t('sync.dialog.title')}
              </h2>
              <button
                type="button"
                onClick={closeSync}
                disabled={phase === 'running'}
                aria-label={t('common.close')}
                className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
              >
                <X size={16} />
              </button>
            </div>

            {phase === 'setup' && (
              <>
                <label className="block">
                  <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                    {t('sync.dialog.source')}
                  </span>
                  <select
                    value={setup.source}
                    onChange={(e) => {
                      const source = e.target.value;
                      setSetup({ ...setup, source, targets: chosen.filter((id) => id !== source) });
                    }}
                    className={`${inputCls} w-full`}
                  >
                    {chosen.map((id) => (
                      <option key={id} value={id}>
                        {nameOf(id)}
                      </option>
                    ))}
                  </select>
                </label>

                <fieldset>
                  <legend className="mb-1 text-[0.7rem] text-muted-foreground">
                    {t('sync.dialog.targets')}
                  </legend>
                  <div className="space-y-1">
                    {chosen
                      .filter((id) => id !== setup.source)
                      .map((id) => (
                        <label key={id} className="flex items-center gap-2 text-[0.8rem]">
                          <input
                            type="checkbox"
                            checked={setup.targets.includes(id)}
                            onChange={(e) =>
                              setSetup({
                                ...setup,
                                targets: e.target.checked
                                  ? [...setup.targets, id]
                                  : setup.targets.filter((x) => x !== id),
                              })
                            }
                            className="h-4 w-4 accent-[var(--primary)]"
                          />
                          {nameOf(id)}
                        </label>
                      ))}
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="mb-1 text-[0.7rem] text-muted-foreground">
                    {t('sync.dialog.direction')}
                  </legend>
                  <div className="grid grid-cols-3 gap-2">
                    {DIRECTIONS.map((d) => (
                      <label
                        key={d.value}
                        className={`cursor-pointer rounded-lg border px-3 py-2 ${
                          setup.direction === d.value
                            ? 'border-foreground/50 bg-[var(--surface-2)]'
                            : 'border-border'
                        }`}
                      >
                        <input
                          type="radio"
                          name="sync-direction"
                          value={d.value}
                          checked={setup.direction === d.value}
                          onChange={() => setSetup({ ...setup, direction: d.value })}
                          className="sr-only"
                        />
                        <span className="block text-[0.8rem] font-medium text-foreground">
                          {t(d.label)}
                        </span>
                        <span className="block text-[0.68rem] text-muted-foreground">
                          {t(d.hint)}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="mb-1 text-[0.7rem] text-muted-foreground">
                    {t('sync.dialog.what')}
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        ['sync.group.master', MASTER],
                        ['sync.group.documents', DOCUMENT_ENTITIES],
                      ] as [MessageKey, readonly SyncEntity[]][]
                    ).map(([title, list]) => (
                      <div key={title} className="rounded-lg border border-border p-3 space-y-1">
                        <p className="text-[0.7rem] font-semibold text-muted-foreground">
                          {t(title)}
                        </p>
                        {list.map((entity) => (
                          <label key={entity} className="flex items-center gap-2 text-[0.8rem]">
                            <input
                              type="checkbox"
                              checked={setup.entities.includes(entity)}
                              onChange={(e) =>
                                setSetup({
                                  ...setup,
                                  entities: e.target.checked
                                    ? [...setup.entities, entity]
                                    : setup.entities.filter((x) => x !== entity),
                                })
                              }
                              className="h-4 w-4 accent-[var(--primary)]"
                            />
                            {t(entityLabel(entity))}
                          </label>
                        ))}
                        <p className="pt-1 text-[0.68rem] text-muted-foreground">
                          {t(
                            title === 'sync.group.master'
                              ? 'sync.hint.stock'
                              : 'sync.hint.documents'
                          )}
                        </p>
                      </div>
                    ))}
                  </div>
                </fieldset>

                {setup.entities.some((e) => DOCUMENT_ENTITIES.includes(e)) && (
                  <label className="block">
                    <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                      {t('sync.dialog.since')}
                    </span>
                    <input
                      type="date"
                      value={setup.since}
                      onChange={(e) =>
                        e.target.value && setSetup({ ...setup, since: e.target.value })
                      }
                      className={inputCls}
                    />
                    <span className="mt-1 block text-[0.68rem] text-muted-foreground">
                      {t('sync.dialog.sinceHint')}
                    </span>
                  </label>
                )}

                <p className="rounded-lg bg-[var(--surface-2)] p-3 text-[0.72rem] text-muted-foreground">
                  {t('sync.dialog.rules')}
                </p>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closeSync}
                    className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void startSync()}
                    disabled={setup.targets.length === 0 || setup.entities.length === 0}
                    className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
                  >
                    <ArrowLeftRight size={13} /> {t('sync.dialog.start')}
                  </button>
                </div>
              </>
            )}

            {phase !== 'setup' && (
              <div className="space-y-3">
                {phase === 'running' && (
                  <div role="status" aria-live="polite" className="space-y-2">
                    <p className="flex items-center gap-2 text-[0.8rem] text-foreground">
                      <Loader2 size={14} className="animate-spin" />
                      {t('sync.dialog.progress', {
                        done: fmt.number(progress.done),
                        total: fmt.number(progress.total),
                      })}
                    </p>
                    <p className="text-[0.72rem] text-muted-foreground">{progress.label}</p>
                  </div>
                )}
                <div
                  className="h-2 overflow-hidden rounded-full bg-[var(--surface-3)]"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                >
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                    }}
                  />
                </div>

                {phase === 'done' &&
                  (outcome.error ? (
                    <p
                      role="alert"
                      className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-[0.8rem] text-red-700 dark:bg-red-950/30 dark:text-red-300"
                    >
                      <XCircle size={15} className="mt-0.5 shrink-0" />
                      <span>
                        {outcome.error} {steps.length > 0 && t('sync.dialog.stopped')}
                      </span>
                    </p>
                  ) : (
                    <p className="flex items-center gap-2 text-[0.85rem] font-medium text-foreground">
                      {outcome.status === 'success' ? (
                        <CheckCircle2 size={16} className="text-green-600" />
                      ) : (
                        <AlertTriangle size={16} className="text-amber-600" />
                      )}
                      {t('sync.dialog.done')}
                      {outcome.status && <StatusBadge status={outcome.status} />}
                    </p>
                  ))}

                {steps.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border border-border">
                    <table className="w-full text-[0.75rem]">
                      <thead className="bg-[var(--surface-2)] text-left text-[0.68rem] text-muted-foreground">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">{t('sync.dialog.targets')}</th>
                          <th className="px-3 py-1.5 font-medium text-right">
                            {t('sync.count.ok')}
                          </th>
                          <th className="px-3 py-1.5 font-medium text-right">
                            {t('sync.count.skipped')}
                          </th>
                          <th className="px-3 py-1.5 font-medium text-right">
                            {t('sync.count.failed')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {steps.map((s) => (
                          <tr
                            key={`${s.target}-${s.entity}`}
                            className="border-t border-border align-top"
                          >
                            <td className="px-3 py-1.5">
                              <span className="text-foreground">{t(entityLabel(s.entity))}</span>
                              <span className="text-muted-foreground"> · {nameOf(s.target)}</span>
                              <Messages counts={s.counts} />
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-green-700 dark:text-green-400">
                              {fmt.number(s.counts.ok)}
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                              {fmt.number(s.counts.skipped)}
                            </td>
                            <td
                              className={`px-3 py-1.5 text-right tabular-nums ${
                                s.counts.failed
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-muted-foreground'
                              }`}
                            >
                              {fmt.number(s.counts.failed)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {phase === 'done' && (
                  <button
                    type="button"
                    onClick={closeSync}
                    className="w-full py-2 rounded-lg text-[0.8rem] font-medium border border-border text-foreground hover:bg-[var(--surface-3)]"
                  >
                    {t('common.close')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {deleting && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDeleting(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-erp-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 id="delete-erp-title" className="text-[1rem] font-semibold text-foreground">
                {t(deleting.mode === 'leave' ? 'sync.leaveTitle' : 'sync.deleteTitle', {
                  name: deleting.name,
                })}
              </h2>
              <button
                type="button"
                onClick={() => setDeleting(null)}
                aria-label={t('common.close')}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            {deleting.mode === 'leave' ? (
              <>
                <p className="text-[0.8rem] text-muted-foreground">
                  {t('sync.leaveBody', { name: deleting.name })}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setDeleting(null)}
                    disabled={leaving}
                    className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void leave(deleting.id, deleting.name)}
                    disabled={leaving || !user}
                    className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-red-600 text-white disabled:opacity-50"
                  >
                    {leaving ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <LogOut size={13} />
                    )}
                    {t('sync.leave')}
                  </button>
                </div>
              </>
            ) : (
              <DeleteErpSection
                workspaceId={deleting.id}
                name={deleting.name}
                mode={deleting.mode}
                inputClassName={`${inputCls} w-full`}
                onDeleted={() => {
                  setDeleting(null);
                  setSelected((prev) => new Set([...prev].filter((x) => x !== deleting.id)));
                  void load();
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
