'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Activity,
  CalendarClock,
  CopyPlus,
  Database,
  FileUp,
  GitBranch,
  Link2,
  Loader2,
  Play,
  Plus,
  Power,
  RefreshCw,
  Table as TableIcon,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { createWorkflow, deleteWorkflow, duplicateWorkflow } from '@/lib/workflow/storage';
import {
  has,
  terminalApi,
  uploadImportFile,
  type Overview,
  type PipelineSummary,
} from '@/lib/terminal/client';
import { useWorkspace } from '@/app/erp/lib/WorkspaceContext';
import { ChainDialog, NewDatasetDialog, ScheduleDialog } from './components/dialogs';
import { CommandBar } from './components/CommandBar';
import { AiSettings } from './components/AiSettings';
import { Connections } from './components/Connections';
import { Insights } from './components/Insights';
import { Empty, Status, buttonCls, bytes, errorMessage, primaryCls } from './components/shared';

const TABS = [
  'home',
  'datasets',
  'imports',
  'pipelines',
  'connections',
  'insights',
  'ai',
  'jobs',
] as const;
type Tab = (typeof TABS)[number];

function TerminalPage() {
  const { t, fmt } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const { active } = useWorkspace();
  const ws = active?.id ?? null;
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '')
    ? (params.get('tab') as Tab)
    : 'home';
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [newDataset, setNewDataset] = useState(false);
  const [scheduling, setScheduling] = useState<PipelineSummary | null>(null);
  const [chaining, setChaining] = useState<PipelineSummary | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      setData(await terminalApi<Overview>('overview', { workspaceId: ws }));
      setError('');
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }, [ws, t]);

  useEffect(() => {
    load();
  }, [load]);

  // While something runs in the background, look again every few seconds.
  const busy =
    !!data &&
    (data.jobs.some((j) => j.status === 'queued' || j.status === 'running') ||
      data.datasets.some((d) => d.status === 'provisioning' || d.status === 'altering'));
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const go = (next: Tab) => router.replace(next === 'home' ? '/terminal' : `/terminal?tab=${next}`);

  const upload = async (file: File) => {
    if (!ws) return;
    setUploading(0);
    try {
      const { id } = await uploadImportFile(ws, file, (share) => setUploading(share));
      router.push(`/terminal/imports/${id}`);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setUploading(null);
    }
  };

  const action = async (name: string, payload: Record<string, unknown>, done?: string) => {
    try {
      await terminalApi(name, payload);
      if (done) toast.success(done);
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  const newPipeline = async () => {
    try {
      const wf = await createWorkflow(t('wf.defaultName'), ws);
      router.push(`/pipelines/${wf.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wf.createFailed'));
    }
  };

  const duplicate = async (p: PipelineSummary) => {
    try {
      const copy = await duplicateWorkflow(p.id, t('wf.ver.copyName', { name: p.name }));
      router.push(`/pipelines/${copy.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wf.createFailed'));
    }
  };

  const removePipeline = async (id: string) => {
    if (!confirm(t('wf.deleteConfirm'))) return;
    try {
      await deleteWorkflow(id);
      toast.success(t('wf.deleted'));
      await load();
    } catch {
      toast.error(t('wf.deleteFailed'));
    }
  };

  const nameOfDataset = useMemo(
    () => new Map((data?.datasets ?? []).map((d) => [d.id, d.name])),
    [data]
  );
  const nameOfPipeline = useMemo(
    () => new Map((data?.pipelines ?? []).map((p) => [p.id, p.name])),
    [data]
  );

  if (!ws) return <p className="text-[0.8rem] text-muted-foreground">{t('common.loading')}</p>;

  const can = (p: string) => has(data, p);
  const failedJobs = data?.jobs.filter((j) => j.status === 'failed') ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('ps.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('ps.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden sm:inline text-[0.68rem] text-muted-foreground">
            {t('ps.cmd.hint')}
          </span>
          <button type="button" className={buttonCls} onClick={load} aria-label={t('ps.refresh')}>
            <RefreshCw size={12} />
          </button>
          {can('datasets.import') && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) upload(f);
                }}
              />
              <button
                type="button"
                className={buttonCls}
                disabled={uploading !== null}
                onClick={() => fileRef.current?.click()}
              >
                {uploading !== null ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <FileUp size={12} />
                )}
                {uploading !== null
                  ? t('ps.imp.uploading', { percent: Math.round(uploading * 100) })
                  : t('ps.imp.upload')}
              </button>
            </>
          )}
          {can('datasets.schema') && (
            <button type="button" className={primaryCls} onClick={() => setNewDataset(true)}>
              <Plus size={13} /> {t('ps.ds.new')}
            </button>
          )}
        </div>
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => go(id)}
            className={`px-3 py-2 text-[0.78rem] -mb-px border-b-2 ${tab === id ? 'border-foreground text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(`ps.tab.${id}` as any)}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {!data && !error && <div className="h-32 rounded-xl animate-pulse bg-[var(--surface-3)]" />}

      {data && tab === 'home' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              {
                label: t('ps.home.datasets'),
                value: data.datasets.length,
                icon: Database,
                tab: 'datasets' as Tab,
              },
              {
                label: t('ps.home.pipelines'),
                value: data.pipelines.length,
                icon: GitBranch,
                tab: 'pipelines' as Tab,
              },
              {
                label: t('ps.home.scheduled'),
                value: data.pipelines.filter((p) => p.schedule_enabled).length,
                icon: CalendarClock,
                tab: 'pipelines' as Tab,
              },
              {
                label: t('ps.home.failed'),
                value: failedJobs.length,
                icon: XCircle,
                tab: 'jobs' as Tab,
              },
            ].map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => go(c.tab)}
                className="rounded-xl border border-border bg-card p-4 text-left hover:border-foreground/30"
              >
                <c.icon size={16} className="text-muted-foreground mb-2" />
                <p className="text-[1.3rem] font-bold text-foreground">{fmt.number(c.value)}</p>
                <p className="text-[0.72rem] text-muted-foreground">{c.label}</p>
              </button>
            ))}
          </div>
          {data.limits && (
            <p className="text-[0.72rem] text-muted-foreground">
              {t('ps.home.limits', { csv: bytes(data.limits.max_upload_bytes) })}
              {data.limits.available_bytes !== null &&
                ` · ${t('ps.home.available', { size: bytes(data.limits.available_bytes) })}`}
            </p>
          )}
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-[0.85rem] font-semibold text-foreground mb-2">
              {t('ps.home.recent')}
            </h2>
            <JobList
              jobs={data.jobs.slice(0, 8)}
              datasetName={nameOfDataset}
              pipelineName={nameOfPipeline}
              onCancel={(id) => action('job.cancel', { id })}
            />
          </section>
        </div>
      )}

      {data &&
        tab === 'datasets' &&
        (data.datasets.length === 0 ? (
          <Empty
            icon={TableIcon}
            title={t('ps.ds.empty')}
            hint={t('ps.ds.emptyHint')}
            action={
              can('datasets.schema') && (
                <button type="button" className={primaryCls} onClick={() => setNewDataset(true)}>
                  <Plus size={13} /> {t('ps.ds.new')}
                </button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[0.78rem]">
              <thead>
                <tr className="text-left text-[0.68rem] text-muted-foreground border-b border-border">
                  <th className="px-3 py-2">{t('ps.ds.name')}</th>
                  <th className="px-3 py-2">{t('ps.ds.folder')}</th>
                  <th className="px-3 py-2">{t('ps.ds.columns')}</th>
                  <th className="px-3 py-2 text-right">{t('ps.ds.rows')}</th>
                  <th className="px-3 py-2 text-right">{t('ps.ds.size')}</th>
                  <th className="px-3 py-2">{t('ps.ds.status')}</th>
                  <th className="px-3 py-2">{t('ps.ds.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {data.datasets.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-border last:border-0 hover:bg-[var(--surface-3)]"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/terminal/datasets/${d.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {d.name}
                      </Link>
                      {d.access === 'restricted' && (
                        <span className="ml-2 text-[0.6rem] text-muted-foreground">
                          {t('ps.ds.restrictedBadge')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{d.folder || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {d.columns.filter((c) => !c.hidden).length}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmt.number(d.rowCount)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {bytes(d.sizeBytes)}
                    </td>
                    <td className="px-3 py-2">
                      <Status value={d.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt.dateTime(d.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {data &&
        tab === 'imports' &&
        (data.imports.length === 0 ? (
          <Empty
            icon={FileUp}
            title={t('ps.imp.empty')}
            hint={t('ps.imp.emptyHint')}
            action={
              can('datasets.import') && (
                <button
                  type="button"
                  className={primaryCls}
                  onClick={() => fileRef.current?.click()}
                >
                  <FileUp size={13} /> {t('ps.imp.upload')}
                </button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[0.78rem]">
              <thead>
                <tr className="text-left text-[0.68rem] text-muted-foreground border-b border-border">
                  <th className="px-3 py-2">{t('ps.imp.file')}</th>
                  <th className="px-3 py-2">{t('ps.imp.target')}</th>
                  <th className="px-3 py-2 text-right">{t('ps.imp.rows')}</th>
                  <th className="px-3 py-2">{t('ps.ds.status')}</th>
                  <th className="px-3 py-2">{t('ps.imp.when')}</th>
                </tr>
              </thead>
              <tbody>
                {data.imports.map((i) => (
                  <tr
                    key={i.id}
                    className="border-b border-border last:border-0 hover:bg-[var(--surface-3)]"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/terminal/imports/${i.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {i.file_name}
                      </Link>
                      <span className="ml-2 text-[0.62rem] text-muted-foreground">
                        {bytes(i.size_bytes)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {i.target_dataset_id
                        ? (nameOfDataset.get(i.target_dataset_id) ?? t('ps.imp.aDataset'))
                        : i.target_erp_entity
                          ? t(`ps.erp.${i.target_erp_entity}` as any)
                          : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {i.status === 'committed'
                        ? t('ps.imp.okRejected', {
                            ok: fmt.number(i.rows_ok),
                            rejected: fmt.number(i.rows_rejected),
                          })
                        : i.rows_total !== null
                          ? fmt.number(i.rows_total)
                          : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <Status value={i.status} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmt.dateTime(i.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {data && tab === 'pipelines' && (
        <div className="space-y-3">
          {(can('pipelines.create') || can('read')) && (
            <button type="button" className={primaryCls} onClick={newPipeline}>
              <Plus size={13} /> {t('ps.pl.new')}
            </button>
          )}
          {data.pipelines.length === 0 ? (
            <Empty icon={GitBranch} title={t('ps.pl.empty')} hint={t('ps.pl.emptyHint')} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {data.pipelines.map((p) => (
                <div
                  key={p.id}
                  className={`rounded-xl border border-border bg-card p-4 space-y-2 ${p.enabled ? '' : 'opacity-60'}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/pipelines/${p.id}`} className="min-w-0">
                      <p className="text-[0.9rem] font-semibold text-foreground truncate">
                        {p.name}
                      </p>
                      <p className="text-[0.66rem] text-muted-foreground">
                        {p.published_version_id ? t('ps.pl.published') : t('wf.ver.notPublished')}
                        {!p.enabled && ` · ${t('ps.pl.disabled')}`}
                      </p>
                    </Link>
                    {p.last_run && <Status value={p.last_run.status} />}
                  </div>
                  <p className="text-[0.7rem] text-muted-foreground">
                    {p.schedule_kind
                      ? p.schedule_enabled
                        ? t('ps.pl.nextRun', { when: fmt.dateTime(p.next_run_at) })
                        : t('ps.pl.scheduleOff', {
                            reason: p.disabled_reason
                              ? t(`ps.pl.reason.${p.disabled_reason}` as any)
                              : '',
                          })
                      : t('ps.pl.notScheduled')}
                  </p>
                  {data.triggers.some((c) => c.upstream_id === p.id) && (
                    <p className="text-[0.68rem] text-muted-foreground">
                      {t('ps.pl.then', {
                        names: data.triggers
                          .filter((c) => c.upstream_id === p.id)
                          .map((c) => nameOfPipeline.get(c.downstream_id) ?? '?')
                          .join(', '),
                      })}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {can('pipelines.run') && p.published_version_id && p.enabled && (
                      <button
                        type="button"
                        className={buttonCls}
                        onClick={() =>
                          action('pipeline.run', { pipelineId: p.id }, t('ps.pl.queued'))
                        }
                      >
                        <Play size={11} /> {t('ps.pl.runNow')}
                      </button>
                    )}
                    {can('pipelines.schedule') && p.published_version_id && (
                      <button type="button" className={buttonCls} onClick={() => setScheduling(p)}>
                        <CalendarClock size={11} /> {t('ps.pl.schedule')}
                      </button>
                    )}
                    {can('pipelines.schedule') && p.published_version_id && (
                      <button type="button" className={buttonCls} onClick={() => setChaining(p)}>
                        <Link2 size={11} /> {t('ps.pl.chain')}
                      </button>
                    )}
                    {(p.mine || can('pipelines.disable')) && (
                      <button
                        type="button"
                        className={buttonCls}
                        onClick={() =>
                          action('pipeline.enable', { pipelineId: p.id, enabled: !p.enabled })
                        }
                      >
                        <Power size={11} /> {p.enabled ? t('ps.pl.disable') : t('ps.pl.enable')}
                      </button>
                    )}
                    <button type="button" className={buttonCls} onClick={() => duplicate(p)}>
                      <CopyPlus size={11} /> {t('wf.duplicate')}
                    </button>
                    {p.mine && (
                      <button
                        type="button"
                        className={`${buttonCls} hover:text-red-500`}
                        onClick={() => removePipeline(p.id)}
                      >
                        <Trash2 size={11} /> {t('ps.ds.delete')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {data && tab === 'connections' && ws && (
        <Connections workspaceId={ws} permissions={data.permissions} />
      )}

      {data && tab === 'insights' && ws && (
        <Insights workspaceId={ws} permissions={data.permissions} />
      )}
      {data && tab === 'ai' && ws && <AiSettings workspaceId={ws} permissions={data.permissions} />}

      {data && tab === 'jobs' && (
        <section className="rounded-xl border border-border bg-card p-4">
          {data.jobs.length === 0 ? (
            <Empty icon={Activity} title={t('ps.job.empty')} />
          ) : (
            <JobList
              jobs={data.jobs}
              datasetName={nameOfDataset}
              pipelineName={nameOfPipeline}
              onCancel={(id) => action('job.cancel', { id })}
            />
          )}
        </section>
      )}

      {newDataset && ws && (
        <NewDatasetDialog
          workspaceId={ws}
          onClose={() => setNewDataset(false)}
          onCreated={(id) => {
            setNewDataset(false);
            router.push(`/terminal/datasets/${id}`);
          }}
        />
      )}
      {scheduling && (
        <ScheduleDialog
          pipeline={scheduling}
          onClose={() => setScheduling(null)}
          onSaved={() => {
            setScheduling(null);
            load();
          }}
        />
      )}
      {chaining && data && (
        <ChainDialog
          pipeline={chaining}
          pipelines={data.pipelines}
          chains={data.triggers}
          onClose={() => setChaining(null)}
          onSaved={load}
        />
      )}
      <CommandBar
        overview={data}
        onNewDataset={() => setNewDataset(true)}
        onUpload={() => fileRef.current?.click()}
        onTab={go}
      />
    </div>
  );
}

function JobList({
  jobs,
  datasetName,
  pipelineName,
  onCancel,
}: {
  jobs: Overview['jobs'];
  datasetName: Map<string, string>;
  pipelineName: Map<string, string>;
  onCancel: (id: string) => void;
}) {
  const { t, fmt } = useI18n();
  if (!jobs.length)
    return <p className="text-[0.75rem] text-muted-foreground">{t('ps.job.empty')}</p>;
  return (
    <ul className="divide-y divide-border">
      {jobs.map((j) => {
        const what = j.pipeline_id
          ? pipelineName.get(j.pipeline_id)
          : j.dataset_id
            ? datasetName.get(j.dataset_id)
            : null;
        return (
          <li key={j.id} className="py-2 flex flex-wrap items-center gap-2 text-[0.75rem]">
            <Status value={j.status} />
            <span className="text-foreground">{t(`ps.job.kind.${j.kind}` as any)}</span>
            {what && <span className="text-muted-foreground truncate max-w-[14rem]">{what}</span>}
            {j.trigger !== 'manual' && (
              <span className="text-[0.62rem] text-muted-foreground">
                {t(`ps.job.trigger.${j.trigger}` as any)}
              </span>
            )}
            {j.error_key && (
              <span className="text-[0.68rem] text-red-600 dark:text-red-400">
                {t('ps.job.error', { code: j.error_key })}
              </span>
            )}
            <span className="ml-auto text-[0.66rem] text-muted-foreground">
              {fmt.dateTime(j.finished_at ?? j.started_at ?? j.created_at)}
            </span>
            {(j.status === 'queued' || j.status === 'running') && (
              <button
                type="button"
                className="text-[0.66rem] text-muted-foreground hover:text-red-500"
                onClick={() => onCancel(j.id)}
              >
                {t('ps.job.cancel')}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TerminalPage />
    </Suspense>
  );
}
