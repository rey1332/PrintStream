'use client';

import React, { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { COLUMN_TYPES, type ColumnType } from '@/lib/terminal/tabular';
import { nextRun, scheduleProblem, type ScheduleKind } from '@/lib/terminal/schedule';
import { terminalApi, type PipelineSummary } from '@/lib/terminal/client';
import { Dialog, buttonCls, errorMessage, inputCls, primaryCls } from './shared';

export interface ColumnDraft {
  label: string;
  type: ColumnType;
  key: boolean;
  sensitive: boolean;
}

export function ColumnsEditor({
  columns,
  onChange,
}: {
  columns: ColumnDraft[];
  onChange: (next: ColumnDraft[]) => void;
}) {
  const { t } = useI18n();
  const set = (i: number, patch: Partial<ColumnDraft>) =>
    onChange(columns.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-2">
      {columns.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input
            className={`${inputCls} flex-1 min-w-[8rem]`}
            value={c.label}
            placeholder={t('ps.ds.columnName')}
            aria-label={t('ps.ds.columnName')}
            onChange={(e) => set(i, { label: e.target.value })}
          />
          <select
            className={`${inputCls} w-32`}
            value={c.type}
            aria-label={t('ps.ds.columnType')}
            onChange={(e) => set(i, { type: e.target.value as ColumnType })}
            style={{ colorScheme: 'light dark' }}
          >
            {COLUMN_TYPES.map((ty) => (
              <option key={ty} value={ty}>
                {t(`ps.type.${ty}` as any)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-[0.7rem] text-muted-foreground">
            <input
              type="checkbox"
              checked={c.key}
              onChange={(e) => set(i, { key: e.target.checked })}
            />{' '}
            {t('ps.ds.key')}
          </label>
          <label className="flex items-center gap-1 text-[0.7rem] text-muted-foreground">
            <input
              type="checkbox"
              checked={c.sensitive}
              onChange={(e) => set(i, { sensitive: e.target.checked })}
            />{' '}
            {t('ps.ds.sensitive')}
          </label>
          <button
            type="button"
            className="p-1 text-muted-foreground hover:text-red-500"
            aria-label={t('ps.ds.removeColumn')}
            onClick={() => onChange(columns.filter((_, n) => n !== i))}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={buttonCls}
        onClick={() =>
          onChange([...columns, { label: '', type: 'text', key: false, sensitive: false }])
        }
      >
        <Plus size={12} /> {t('ps.ds.addColumn')}
      </button>
    </div>
  );
}

export function NewDatasetDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [description, setDescription] = useState('');
  const [restricted, setRestricted] = useState(false);
  const [columns, setColumns] = useState<ColumnDraft[]>([
    { label: '', type: 'text', key: false, sensitive: false },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const { id } = await terminalApi<{ id: string }>('dataset.create', {
        workspaceId,
        name,
        folder,
        description,
        access: restricted ? 'restricted' : 'workspace',
        columns: columns.filter((c) => c.label.trim()),
      });
      onCreated(id);
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('ps.ds.new')} onClose={onClose} wide>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ds.name')}
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </label>
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ds.folder')}
          <input
            className={inputCls}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            maxLength={120}
          />
        </label>
      </div>
      <label className="block text-[0.7rem] text-muted-foreground">
        {t('ps.ds.description')}
        <textarea
          className={inputCls}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
        />
      </label>
      <label className="flex items-center gap-2 text-[0.75rem] text-foreground">
        <input
          type="checkbox"
          checked={restricted}
          onChange={(e) => setRestricted(e.target.checked)}
        />{' '}
        {t('ps.ds.restricted')}
      </label>
      <p className="text-[0.7rem] text-muted-foreground">{t('ps.ds.columnsHint')}</p>
      <ColumnsEditor columns={columns} onChange={setColumns} />
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonCls} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className={primaryCls} disabled={busy || !name.trim()} onClick={save}>
          {busy && <Loader2 size={13} className="animate-spin" />} {t('ps.ds.create')}
        </button>
      </div>
    </Dialog>
  );
}

const KINDS: ScheduleKind[] = ['daily', 'weekly', 'monthly', 'interval', 'cron'];

export interface BuiltSchedule {
  kind: ScheduleKind;
  timezone: string;
  spec: Record<string, unknown>;
}

/** A pipeline's schedule (the pipeline dialog below and connector syncs use the same form). */
export function ScheduleDialog({
  pipeline,
  onClose,
  onSaved,
}: {
  pipeline: PipelineSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  return (
    <ScheduleForm
      title={t('ps.pl.scheduleTitle', { name: pipeline.name })}
      hint={t('ps.pl.scheduleHint')}
      current={{
        kind: pipeline.schedule_kind,
        spec: pipeline.schedule_spec,
        timezone: pipeline.timezone,
      }}
      onSave={(built) =>
        terminalApi('pipeline.schedule', { pipelineId: pipeline.id, ...built, enabled: true })
      }
      onRemove={
        pipeline.schedule_kind
          ? () => terminalApi('pipeline.unschedule', { pipelineId: pipeline.id })
          : undefined
      }
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

export function ScheduleForm({
  title,
  hint,
  current,
  onSave,
  onRemove,
  onClose,
  onSaved,
  extra,
}: {
  title: string;
  hint: string;
  current: {
    kind: ScheduleKind | null;
    spec: Record<string, unknown> | null;
    timezone: string | null;
  };
  onSave: (built: BuiltSchedule) => Promise<unknown>;
  onRemove?: () => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void;
  extra?: React.ReactNode;
}) {
  const { t, fmt } = useI18n();
  const spec = (current.spec ?? {}) as Record<string, any>;
  const [kind, setKind] = useState<ScheduleKind>(current.kind ?? 'daily');
  const [at, setAt] = useState<string>(spec.at ?? '02:00');
  const [days, setDays] = useState<number[]>(Array.isArray(spec.days) ? spec.days : [1]);
  const [day, setDay] = useState<number>(spec.day ?? 1);
  const [minutes, setMinutes] = useState<number>(spec.minutes ?? 60);
  const [expr, setExpr] = useState<string>(spec.expr ?? '0 2 * * *');
  const [timezone, setTimezone] = useState(current.timezone ?? 'Asia/Jakarta');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const built = {
    kind,
    timezone,
    spec:
      kind === 'daily'
        ? { at }
        : kind === 'weekly'
          ? { days, at }
          : kind === 'monthly'
            ? { day, at }
            : kind === 'interval'
              ? { minutes }
              : { expr },
  };
  const problem = scheduleProblem(built);
  const next = problem ? null : nextRun(built);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await onSave(built);
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await onRemove?.();
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <p className="text-[0.72rem] text-muted-foreground">{hint}</p>
      <label className="block text-[0.7rem] text-muted-foreground">
        {t('ps.pl.repeat')}
        <select
          className={inputCls}
          value={kind}
          onChange={(e) => setKind(e.target.value as ScheduleKind)}
          style={{ colorScheme: 'light dark' }}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`ps.sched.${k}` as any)}
            </option>
          ))}
        </select>
      </label>
      {kind === 'weekly' && (
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <label key={d} className="flex items-center gap-1 text-[0.72rem] text-foreground">
              <input
                type="checkbox"
                checked={days.includes(d)}
                onChange={(e) =>
                  setDays(e.target.checked ? [...days, d] : days.filter((x) => x !== d))
                }
              />
              {t(`ps.day.${d}` as any)}
            </label>
          ))}
        </div>
      )}
      {kind === 'monthly' && (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.pl.dayOfMonth')}
          <input
            type="number"
            min={1}
            max={31}
            className={inputCls}
            value={day}
            onChange={(e) => setDay(Number(e.target.value))}
          />
        </label>
      )}
      {(kind === 'daily' || kind === 'weekly' || kind === 'monthly') && (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.pl.at')}
          <input
            type="time"
            className={inputCls}
            value={at}
            onChange={(e) => setAt(e.target.value)}
          />
        </label>
      )}
      {kind === 'interval' && (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.pl.everyMinutes')}
          <input
            type="number"
            min={5}
            max={1440}
            className={inputCls}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
      )}
      {kind === 'cron' && (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.pl.cron')}
          <input
            className={`${inputCls} font-mono`}
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
          />
        </label>
      )}
      <label className="block text-[0.7rem] text-muted-foreground">
        {t('ps.pl.timezone')}
        <input
          className={inputCls}
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        />
      </label>
      {extra}
      <p className="text-[0.72rem] text-foreground">
        {problem
          ? t(`ps.sched.problem.${problem}` as any)
          : next
            ? t('ps.pl.nextRun', { when: fmt.dateTime(next.toISOString()) })
            : ''}
      </p>
      <div className="flex justify-between gap-2">
        <div>
          {onRemove && (
            <button type="button" className={buttonCls} disabled={busy} onClick={remove}>
              <Trash2 size={12} /> {t('ps.pl.unschedule')}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button type="button" className={buttonCls} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className={primaryCls} disabled={busy || !!problem} onClick={save}>
            {busy && <Loader2 size={13} className="animate-spin" />} {t('common.save')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function ChainDialog({
  pipeline,
  pipelines,
  chains,
  onClose,
  onSaved,
}: {
  pipeline: PipelineSummary;
  pipelines: PipelineSummary[];
  chains: { id: string; upstream_id: string; downstream_id: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const mine = chains.filter((c) => c.upstream_id === pipeline.id);
  const nameOf = (id: string) => pipelines.find((p) => p.id === id)?.name ?? id;
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
    }
  };
  return (
    <Dialog title={t('ps.pl.chainTitle', { name: pipeline.name })} onClose={onClose}>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <p className="text-[0.72rem] text-muted-foreground">{t('ps.pl.chainHint')}</p>
      <ul className="space-y-1">
        {mine.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between text-[0.78rem] text-foreground"
          >
            {nameOf(c.downstream_id)}
            <button
              type="button"
              className="p-1 text-muted-foreground hover:text-red-500"
              aria-label={t('ps.pl.unchain')}
              onClick={() => act(() => terminalApi('pipeline.unchain', { id: c.id }))}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
        {!mine.length && (
          <li className="text-[0.72rem] text-muted-foreground">{t('ps.pl.noChains')}</li>
        )}
      </ul>
      <div className="flex gap-2">
        <select
          className={inputCls}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label={t('ps.pl.runAfter')}
          style={{ colorScheme: 'light dark' }}
        >
          <option value="">{t('ps.pl.pickPipeline')}</option>
          {pipelines
            .filter(
              (p) =>
                p.id !== pipeline.id &&
                p.published_version_id &&
                !mine.some((c) => c.downstream_id === p.id)
            )
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <button
          type="button"
          className={primaryCls}
          disabled={!target}
          onClick={() =>
            act(() =>
              terminalApi('pipeline.chain', { upstreamId: pipeline.id, downstreamId: target })
            )
          }
        >
          <Plus size={12} /> {t('ps.pl.addChain')}
        </button>
      </div>
    </Dialog>
  );
}
