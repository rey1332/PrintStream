'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Ban,
  CalendarClock,
  Database,
  Globe,
  KeyRound,
  ListChecks,
  Loader2,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import {
  CONNECTORS,
  CONNECTOR_KINDS,
  fieldShown,
  type ConfigField,
  type ConnectorKind,
  type ObjectKey,
} from '@/lib/terminal/connectors';
import { terminalApi } from '@/lib/terminal/client';
import {
  CHANGED_TYPES,
  dbSourceLabel,
  type DbColumn,
  type DbSource,
} from '@/lib/terminal/dbSource';
import { REST_TEMPLATES, restSourceLabel, type RestSource } from '@/lib/terminal/restSource';
import { webSourceLabel, type WebSource } from '@/lib/terminal/webSource';
import { mcpSourceLabel, type McpSource } from '@/lib/terminal/mcpSource';
import { COLUMN_TYPES, type ColumnType } from '@/lib/terminal/tabular';
import { askWorker } from './connectorAsk';
import { ScheduleForm } from './dialogs';
import { RestSyncDialog } from './RestSyncDialog';
import { WebSyncDialog } from './WebSyncDialog';
import { McpSyncDialog, McpToolsDialog } from './McpDialogs';
import { Dialog, Empty, Status, buttonCls, errorMessage, inputCls, primaryCls } from './shared';

interface Connection {
  id: string;
  kind: ConnectorKind;
  name: string;
  config: Record<string, any>;
  status: 'untested' | 'ok' | 'failed' | 'needs_auth';
  last_tested_at: string | null;
  last_error_key: string | null;
  has_secret: boolean;
}

interface Sync {
  id: string;
  connection_id: string;
  object: ObjectKey | 'table' | 'query' | 'rest' | 'web' | 'mcp';
  /** A database, API, website or MCP sync: what it reads. */
  source: DbSource | RestSource | WebSource | McpSource | null;
  label: string | null;
  dataset_id: string;
  dataset_name: string | null;
  enabled: boolean;
  schedule_kind: 'interval' | 'daily' | 'weekly' | 'monthly' | 'cron' | null;
  schedule_spec: Record<string, unknown> | null;
  timezone: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: 'ok' | 'failed' | null;
  last_error_key: string | null;
  last_rows: number | null;
  last_removed: number | null;
  full_every_days: number;
}

export function Connections({
  workspaceId,
  permissions,
}: {
  workspaceId: string;
  permissions: string[];
}) {
  const { t, fmt } = useI18n();
  const params = useSearchParams();
  const [data, setData] = useState<{ connections: Connection[]; syncs: Sync[] } | null>(null);
  const [editing, setEditing] = useState<Partial<Connection> | null>(null);
  const [adding, setAdding] = useState<Connection | null>(null);
  const [scheduling, setScheduling] = useState<Sync | null>(null);
  const [toolsOf, setToolsOf] = useState<Connection | null>(null);
  const manage = permissions.includes('integrations.manage');
  const use = permissions.includes('integrations.use') || manage;

  const load = useCallback(async () => {
    try {
      setData(await terminalApi('connections.list', { workspaceId }));
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }, [workspaceId, t]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  // Back from Accurate's consent page.
  useEffect(() => {
    const result = params.get('oauth');
    if (result === 'pending') toast.success(t('ps.conn.oauthPending'));
    else if (result) toast.error(t(`ps.conn.oauth.${result}` as any));
  }, [params, t]);

  const act = async (action: string, payload: Record<string, unknown>, done?: string) => {
    try {
      await terminalApi(action, payload);
      if (done) toast.success(done);
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  if (!use) return <Empty icon={Plug} title={t('ps.conn.noAccess')} />;
  if (!data) return <div className="h-32 rounded-xl animate-pulse bg-[var(--surface-3)]" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.75rem] text-muted-foreground max-w-2xl">{t('ps.conn.intro')}</p>
        {manage && (
          <button type="button" className={primaryCls} onClick={() => setEditing({})}>
            <Plus size={13} /> {t('ps.conn.new')}
          </button>
        )}
      </div>

      {data.connections.length === 0 ? (
        <Empty icon={Plug} title={t('ps.conn.empty')} hint={t('ps.conn.emptyHint')} />
      ) : (
        data.connections.map((c) => {
          const syncs = data.syncs.filter((s) => s.connection_id === c.id);
          const databases: { id: string; alias: string | null }[] = c.config.info?.databases ?? [];
          return (
            <section key={c.id} className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[0.9rem] font-semibold text-foreground">{c.name}</p>
                  <p className="text-[0.7rem] text-muted-foreground flex flex-wrap items-center gap-2">
                    <span>{t(`ps.conn.kind.${c.kind}` as any)}</span>
                    <Status value={`conn_${c.status}`} />
                    {c.last_tested_at && (
                      <span>{t('ps.conn.tested', { when: fmt.dateTime(c.last_tested_at) })}</span>
                    )}
                    {c.config.info?.version && (
                      <span>{t('ps.conn.version', { version: c.config.info.version })}</span>
                    )}
                  </p>
                  {c.last_error_key && c.status !== 'ok' && (
                    <p className="text-[0.7rem] text-red-600 dark:text-red-400 mt-1">
                      {t('ps.job.error', { code: c.last_error_key })}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {CONNECTORS[c.kind].oauth && manage && (
                    <a
                      className={buttonCls}
                      href={`/api/terminal/connectors/accurate?connectionId=${c.id}`}
                    >
                      <KeyRound size={11} /> {t('ps.conn.authorise')}
                    </a>
                  )}
                  {c.kind === 'mcp' && (
                    <button type="button" className={buttonCls} onClick={() => setToolsOf(c)}>
                      <ListChecks size={11} /> {t('ps.mcp.tools')}
                    </button>
                  )}
                  {(c.kind === 'rest' || c.kind === 'mcp') &&
                    c.config.auth === 'oauth2_code' &&
                    manage && (
                      <>
                        <a
                          className={buttonCls}
                          href={`/api/terminal/connectors/oauth?connectionId=${c.id}`}
                        >
                          <KeyRound size={11} /> {t('ps.conn.authoriseRest')}
                        </a>
                        {c.status !== 'needs_auth' && (
                          <button
                            type="button"
                            className={buttonCls}
                            onClick={() =>
                              confirm(t('ps.conn.revokeConfirm', { name: c.name })) &&
                              act('connection.revoke', { id: c.id }, t('ps.conn.revoking'))
                            }
                          >
                            <Ban size={11} /> {t('ps.conn.revoke')}
                          </button>
                        )}
                      </>
                    )}
                  <button
                    type="button"
                    className={buttonCls}
                    onClick={() => act('connection.test', { id: c.id }, t('ps.conn.testing'))}
                  >
                    <RefreshCw size={11} /> {t('ps.conn.test')}
                  </button>
                  {manage && (
                    <button type="button" className={buttonCls} onClick={() => setEditing(c)}>
                      <Pencil size={11} /> {t('ps.conn.edit')}
                    </button>
                  )}
                  {manage && (
                    <button
                      type="button"
                      className={`${buttonCls} hover:text-red-500`}
                      onClick={() =>
                        confirm(t('ps.conn.removeConfirm', { name: c.name })) &&
                        act('connection.delete', { id: c.id })
                      }
                    >
                      <Trash2 size={11} /> {t('ps.ds.delete')}
                    </button>
                  )}
                </div>
              </div>

              {c.kind === 'accurate' && databases.length > 1 && manage && (
                <label className="block text-[0.7rem] text-muted-foreground max-w-sm">
                  {t('ps.conn.database')}
                  <select
                    className={inputCls}
                    value={c.config.database_id ?? ''}
                    onChange={(e) =>
                      act('connection.option', { id: c.id, databaseId: e.target.value })
                    }
                    style={{ colorScheme: 'light dark' }}
                  >
                    <option value="">{t('ps.conn.pickDatabase')}</option>
                    {databases.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.alias ?? d.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="space-y-1.5">
                {syncs.map((s) => (
                  <div
                    key={s.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.75rem]"
                  >
                    <span
                      className="font-medium text-foreground max-w-xs truncate"
                      title={s.source?.mode === 'query' ? s.source.sql : (s.label ?? undefined)}
                    >
                      {syncName(s, t)}
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <Link
                      href={`/terminal/datasets/${s.dataset_id}`}
                      className="text-foreground underline"
                    >
                      {s.dataset_name ?? '—'}
                    </Link>
                    {s.last_status && (
                      <Status value={s.last_status === 'ok' ? 'succeeded' : 'failed'} />
                    )}
                    {s.last_run_at && (
                      <span className="text-muted-foreground">
                        {t('ps.sync.last', {
                          when: fmt.dateTime(s.last_run_at),
                          rows: fmt.number(s.last_rows ?? 0),
                          removed: fmt.number(s.last_removed ?? 0),
                        })}
                      </span>
                    )}
                    {s.last_error_key && s.last_status === 'failed' && (
                      <span className="text-red-600 dark:text-red-400">
                        {t('ps.job.error', { code: s.last_error_key })}
                      </span>
                    )}
                    <span className="text-muted-foreground">
                      {s.schedule_kind && s.enabled
                        ? t('ps.pl.nextRun', { when: fmt.dateTime(s.next_run_at) })
                        : t('ps.pl.notScheduled')}
                    </span>
                    <span className="ml-auto flex gap-1">
                      <button
                        type="button"
                        className={buttonCls}
                        onClick={() => act('sync.run', { id: s.id }, t('ps.sync.queued'))}
                      >
                        <Play size={11} /> {t('ps.pl.runNow')}
                      </button>
                      {permissions.includes('pipelines.schedule') && (
                        <button
                          type="button"
                          className={buttonCls}
                          onClick={() => setScheduling(s)}
                        >
                          <CalendarClock size={11} /> {t('ps.pl.schedule')}
                        </button>
                      )}
                      {manage && (
                        <button
                          type="button"
                          className={`${buttonCls} hover:text-red-500`}
                          aria-label={t('ps.ds.delete')}
                          onClick={() =>
                            confirm(t('ps.sync.removeConfirm')) && act('sync.delete', { id: s.id })
                          }
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </span>
                  </div>
                ))}
                {c.status === 'ok' &&
                  (CONNECTORS[c.kind].database ||
                    CONNECTORS[c.kind].rest ||
                    CONNECTORS[c.kind].web ||
                    CONNECTORS[c.kind].mcp ||
                    syncs.length < CONNECTORS[c.kind].objects.length) && (
                    <button type="button" className={buttonCls} onClick={() => setAdding(c)}>
                      {CONNECTORS[c.kind].database ? (
                        <Database size={11} />
                      ) : CONNECTORS[c.kind].rest ||
                        CONNECTORS[c.kind].web ||
                        CONNECTORS[c.kind].mcp ? (
                        <Globe size={11} />
                      ) : (
                        <Plus size={11} />
                      )}{' '}
                      {CONNECTORS[c.kind].database
                        ? t('ps.dbs.add')
                        : CONNECTORS[c.kind].rest
                          ? t('ps.rest.add')
                          : CONNECTORS[c.kind].web
                            ? t('ps.web.add')
                            : CONNECTORS[c.kind].mcp
                              ? t('ps.mcp.add')
                              : t('ps.sync.add')}
                    </button>
                  )}
              </div>
            </section>
          );
        })
      )}

      {editing && (
        <ConnectionDialog
          workspaceId={workspaceId}
          connection={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {adding && CONNECTORS[adding.kind].database && (
        <DbSyncDialog
          connection={adding}
          canQuery={manage}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void load();
          }}
        />
      )}
      {adding && CONNECTORS[adding.kind].rest && (
        <RestSyncDialog
          connection={adding}
          canPost={manage}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void load();
          }}
        />
      )}
      {adding && CONNECTORS[adding.kind].mcp && (
        <McpSyncDialog
          connection={adding}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void load();
          }}
        />
      )}
      {toolsOf && (
        <McpToolsDialog connection={toolsOf} canApprove={manage} onClose={() => setToolsOf(null)} />
      )}
      {adding && CONNECTORS[adding.kind].web && (
        <WebSyncDialog
          connection={adding}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            void load();
          }}
        />
      )}
      {adding &&
        !CONNECTORS[adding.kind].database &&
        !CONNECTORS[adding.kind].rest &&
        !CONNECTORS[adding.kind].web &&
        !CONNECTORS[adding.kind].mcp && (
          <SyncDialog
            connection={adding}
            taken={data.syncs
              .filter((s) => s.connection_id === adding.id)
              .map((s) => s.object as ObjectKey)}
            onClose={() => setAdding(null)}
            onSaved={() => {
              setAdding(null);
              void load();
            }}
          />
        )}
      {scheduling && (
        <SyncScheduleDialog
          sync={scheduling}
          onClose={() => setScheduling(null)}
          onSaved={() => {
            setScheduling(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ConnectionDialog({
  workspaceId,
  connection,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  connection: Partial<Connection>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const isNew = !connection.id;
  const [kind, setKind] = useState<ConnectorKind>(connection.kind ?? 'odoo');
  const [name, setName] = useState(connection.name ?? '');
  const [values, setValues] = useState<Record<string, string>>(
    () =>
      Object.fromEntries(
        Object.entries(connection.config ?? {}).filter(([, v]) => typeof v === 'string')
      ) as Record<string, string>
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Selects count with their first option until one is picked (as the server does).
  const effective = { ...values };
  for (const f of CONNECTORS[kind].fields)
    if (f.kind === 'select' && !effective[f.key] && f.options) effective[f.key] = f.options[0];
  const shown = CONNECTORS[kind].fields.filter((f) => fieldShown(f, effective));
  const basic = shown.filter((f) => !f.advanced);
  const advanced = shown.filter((f) => f.advanced);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await terminalApi('connection.save', {
        workspaceId,
        id: connection.id ?? null,
        kind,
        name,
        values,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={isNew ? t('ps.conn.new') : t('ps.conn.editTitle', { name: connection.name ?? '' })}
      onClose={onClose}
    >
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {isNew && (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.conn.kind')}
          <select
            className={inputCls}
            value={kind}
            onChange={(e) => setKind(e.target.value as ConnectorKind)}
            style={{ colorScheme: 'light dark' }}
          >
            {CONNECTOR_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`ps.conn.kind.${k}` as any)}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-[0.7rem] text-muted-foreground">{t(`ps.conn.help.${kind}` as any)}</p>
      {isNew && kind === 'rest' && (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.conn.template')}
          <select
            className={inputCls}
            defaultValue="blank"
            onChange={(e) => {
              const tpl = REST_TEMPLATES.find((x) => x.id === e.target.value);
              if (tpl) setValues({ ...tpl.values });
            }}
            style={{ colorScheme: 'light dark' }}
          >
            {REST_TEMPLATES.map((x) => (
              <option key={x.id} value={x.id}>
                {t(`ps.conn.tpl.${x.id}` as any)}
              </option>
            ))}
          </select>
          <span>{t('ps.conn.templateNote')}</span>
        </label>
      )}
      <label className="block text-[0.7rem] text-muted-foreground">
        {t('ps.ds.name')}
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </label>
      {basic.map((f) => field(f))}
      {kind === 'mcp' && effective.auth === 'oauth2_code' && (
        <p className="text-[0.68rem] text-muted-foreground">{t('ps.conn.mcpOauthNote')}</p>
      )}
      {(kind === 'rest' || kind === 'mcp') && effective.auth === 'oauth2_code' && (
        <p className="text-[0.68rem] text-muted-foreground break-all">
          {t('ps.conn.redirectUri', {
            uri: `${typeof window === 'undefined' ? '' : window.location.origin}/api/terminal/connectors/oauth`,
          })}
        </p>
      )}
      {kind === 'rest' && effective.auth === 'hmac' && effective.hmac_scheme === 'custom' && (
        <p className="text-[0.68rem] text-muted-foreground">{t('ps.conn.hmacHint')}</p>
      )}
      {advanced.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2 space-y-2">
          <summary className="cursor-pointer text-[0.72rem] text-foreground">
            {t('ps.conn.advanced')}
          </summary>
          {advanced.map((f) => field(f))}
        </details>
      )}
      <p className="text-[0.68rem] text-muted-foreground">{t('ps.conn.secretNote')}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonCls} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className={primaryCls} disabled={busy || !name.trim()} onClick={save}>
          {busy && <Loader2 size={13} className="animate-spin" />} {t('common.save')}
        </button>
      </div>
    </Dialog>
  );

  function field(f: ConfigField) {
    return (
      <label
        key={`${f.key}:${Object.keys(f.when ?? {}).join()}`}
        className="block text-[0.7rem] text-muted-foreground"
      >
        {t(`ps.conn.field.${f.key}` as any)}
        {f.required ? ' *' : ''}
        {f.kind === 'select' ? (
          <select
            className={inputCls}
            value={values[f.key] ?? f.options?.[0] ?? ''}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            style={{ colorScheme: 'light dark' }}
          >
            {f.options?.map((o) => (
              <option key={o} value={o}>
                {t(`ps.conn.opt.${o}` as any)}
              </option>
            ))}
          </select>
        ) : f.kind === 'textarea' || f.multiline ? (
          <textarea
            className={`${inputCls} font-mono`}
            rows={4}
            maxLength={f.max ?? (f.multiline ? 8000 : undefined)}
            spellCheck={false}
            autoComplete="off"
            placeholder={f.kind === 'secret' && !isNew ? t('ps.conn.secretKept') : f.placeholder}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          />
        ) : (
          <input
            className={inputCls}
            type={f.kind === 'secret' ? 'password' : 'text'}
            autoComplete={f.kind === 'secret' ? 'new-password' : 'off'}
            placeholder={f.kind === 'secret' && !isNew ? t('ps.conn.secretKept') : f.placeholder}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          />
        )}
      </label>
    );
  }
}

function SyncDialog({
  connection,
  taken,
  onClose,
  onSaved,
}: {
  connection: Connection;
  taken: ObjectKey[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const free = CONNECTORS[connection.kind].objects.filter((o) => !taken.includes(o));
  const [object, setObject] = useState<ObjectKey>(free[0]);
  const [name, setName] = useState(`${connection.name} · ${t(`ps.obj.${free[0]}` as any)}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const incremental = CONNECTORS[connection.kind].incremental.includes(object);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await terminalApi('sync.create', { connectionId: connection.id, object, datasetName: name });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('ps.sync.add')} onClose={onClose}>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      <label className="block text-[0.7rem] text-muted-foreground">
        {t('ps.sync.object')}
        <select
          className={inputCls}
          value={object}
          onChange={(e) => {
            const next = e.target.value as ObjectKey;
            setObject(next);
            setName(`${connection.name} · ${t(`ps.obj.${next}` as any)}`);
          }}
          style={{ colorScheme: 'light dark' }}
        >
          {free.map((o) => (
            <option key={o} value={o}>
              {t(`ps.obj.${o}` as any)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-[0.7rem] text-muted-foreground">
        {t('ps.sync.dataset')}
        <input
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </label>
      <p className="text-[0.7rem] text-muted-foreground">
        {incremental ? t('ps.sync.incremental') : t('ps.sync.fullOnly')}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonCls} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className={primaryCls} disabled={busy || !name.trim()} onClick={save}>
          {busy && <Loader2 size={13} className="animate-spin" />} {t('ps.sync.create')}
        </button>
      </div>
    </Dialog>
  );
}

function SyncScheduleDialog({
  sync,
  onClose,
  onSaved,
}: {
  sync: Sync;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [days, setDays] = useState(sync.full_every_days);
  return (
    <ScheduleForm
      title={t('ps.sync.scheduleTitle', { name: syncName(sync, t) })}
      hint={t('ps.sync.scheduleHint')}
      current={{ kind: sync.schedule_kind, spec: sync.schedule_spec, timezone: sync.timezone }}
      onSave={(built) =>
        terminalApi('sync.schedule', { id: sync.id, ...built, fullEveryDays: days, enabled: true })
      }
      onRemove={
        sync.schedule_kind
          ? () => terminalApi('sync.schedule', { id: sync.id, kind: null, fullEveryDays: days })
          : undefined
      }
      onClose={onClose}
      onSaved={onSaved}
      extra={
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.sync.fullEvery')}
          <input
            type="number"
            min={1}
            max={90}
            className={inputCls}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </label>
      }
    />
  );
}

const syncName = (s: Sync, t: (key: any, vars?: any) => string) =>
  s.source
    ? (s.label ??
      (s.source.mode === 'rest'
        ? restSourceLabel(s.source)
        : s.source.mode === 'web'
          ? webSourceLabel(s.source)
          : s.source.mode === 'mcp'
            ? mcpSourceLabel(s.source)
            : dbSourceLabel(s.source)))
    : t(`ps.obj.${s.object}`);

/** An example query (SQL, not translated). */
const SQL_EXAMPLE = "SELECT id, name, updated_at FROM sales.orders WHERE status <> 'draft'";

interface TableInfo {
  schema: string;
  name: string;
  view: boolean;
}

/**
 * A sync of a database: a table (or view), or — for those who manage
 * connections, signed in with two-factor — a read-only query. The worker
 * describes the columns; the user checks their types and picks the key (rows
 * are updated by it) and the "changed" column (later runs read only newer rows).
 */
function DbSyncDialog({
  connection,
  canQuery,
  onClose,
  onSaved,
}: {
  connection: Connection;
  canQuery: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'table' | 'query'>('table');
  const [tables, setTables] = useState<{ tables: TableInfo[]; truncated: boolean } | null>(null);
  const [table, setTable] = useState('');
  const [sql, setSql] = useState('');
  const [columns, setColumns] = useState<DbColumn[] | null>(null);
  const [key, setKey] = useState('');
  const [changed, setChanged] = useState('');
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const ask = async <T,>(source: DbSource | null, then: (answer: T) => void) => {
    setWorking(true);
    setError('');
    try {
      then(await askWorker<T>(connection.id, source));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setWorking(false);
    }
  };

  useEffect(() => {
    void ask<{ tables: TableInfo[]; truncated: boolean }>(null, setTables);
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const source = (): DbSource | null => {
    if (mode === 'query') return sql.trim() ? { mode: 'query', sql } : null;
    const picked = table === '' ? undefined : tables?.tables[Number(table)];
    return picked ? { mode: 'table', schema: picked.schema, table: picked.name } : null;
  };

  const describe = () => {
    const s = source();
    if (!s) return;
    void ask<{ columns: DbColumn[]; key: string | null }>(s, (answer) => {
      setColumns(answer.columns);
      setKey(answer.key ?? '');
      setChanged(
        answer.columns.find(
          (c) => c.type === 'timestamp' && /updated|modified|changed/i.test(c.name)
        )?.name ?? ''
      );
      if (!name.trim())
        setName(`${connection.name} · ${s.mode === 'table' ? s.table : t('ps.dbs.query')}`);
    });
  };

  const pick = (next: { mode?: 'table' | 'query'; table?: string; sql?: string }) => {
    if (next.mode !== undefined) setMode(next.mode);
    if (next.table !== undefined) setTable(next.table);
    if (next.sql !== undefined) setSql(next.sql);
    setColumns(null);
  };

  const save = async () => {
    const s = source();
    if (!s || !columns) return;
    setWorking(true);
    setError('');
    try {
      await terminalApi('sync.createSource', {
        connectionId: connection.id,
        source: { ...s, key: key || null, changed: (key && changed) || null },
        columns: columns.map((c) => ({ name: c.name, type: c.type })),
        datasetName: name,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setWorking(false);
    }
  };

  const changedOptions = (columns ?? []).filter((c) => CHANGED_TYPES.includes(c.type));

  return (
    <Dialog title={t('ps.dbs.add')} onClose={onClose} wide>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {canQuery && (
        <div className="flex gap-3 text-[0.75rem]" role="radiogroup">
          {(['table', 'query'] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="dbs-mode"
                checked={mode === m}
                onChange={() => pick({ mode: m })}
              />
              {t(`ps.dbs.mode.${m}` as any)}
            </label>
          ))}
        </div>
      )}
      {mode === 'table' ? (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.dbs.table')}
          <select
            className={inputCls}
            value={table}
            disabled={!tables}
            onChange={(e) => pick({ table: e.target.value })}
            style={{ colorScheme: 'light dark' }}
          >
            <option value="">{tables ? t('ps.dbs.pickTable') : t('ps.dbs.loadingTables')}</option>
            {tables?.tables.map((x, i) => (
              <option key={`${x.schema}.${x.name}`} value={String(i)}>
                {x.schema}.{x.name}
                {x.view ? ` (${t('ps.dbs.view')})` : ''}
              </option>
            ))}
          </select>
          {tables?.truncated && <span>{t('ps.dbs.truncated')}</span>}
        </label>
      ) : (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.dbs.sql')}
          <textarea
            className={`${inputCls} font-mono`}
            rows={6}
            maxLength={20000}
            spellCheck={false}
            placeholder={SQL_EXAMPLE}
            value={sql}
            onChange={(e) => pick({ sql: e.target.value })}
          />
          <span>{t('ps.dbs.sqlHint')}</span>
        </label>
      )}
      {!columns && (
        <button
          type="button"
          className={buttonCls}
          disabled={working || !source()}
          onClick={describe}
        >
          {working && <Loader2 size={11} className="animate-spin" />} {t('ps.dbs.describe')}
        </button>
      )}

      {columns && (
        <>
          <div className="max-h-56 overflow-auto rounded-lg border border-border">
            <table className="w-full text-[0.72rem]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left font-medium">{t('ps.dbs.column')}</th>
                  <th className="px-2 py-1 text-left font-medium">{t('ps.dbs.sourceType')}</th>
                  <th className="px-2 py-1 text-left font-medium">{t('ps.dbs.datasetType')}</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c, i) => (
                  <tr key={c.name} className="border-t border-border">
                    <td className="px-2 py-1 font-mono text-foreground">{c.name}</td>
                    <td className="px-2 py-1 text-muted-foreground">{c.pgType}</td>
                    <td className="px-2 py-1">
                      <select
                        className="bg-transparent text-foreground"
                        aria-label={t('ps.dbs.datasetType')}
                        value={c.type}
                        onChange={(e) => {
                          const next = [...columns];
                          next[i] = { ...c, type: e.target.value as ColumnType };
                          setColumns(next);
                          if (changed === c.name && !CHANGED_TYPES.includes(next[i].type))
                            setChanged('');
                        }}
                        style={{ colorScheme: 'light dark' }}
                      >
                        {COLUMN_TYPES.map((ty) => (
                          <option key={ty} value={ty}>
                            {t(`ps.type.${ty}` as any)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.dbs.key')}
              <select
                className={inputCls}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                style={{ colorScheme: 'light dark' }}
              >
                <option value="">{t('ps.dbs.noKey')}</option>
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                    {c.primaryKey ? ` (${t('ps.dbs.primaryKey')})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.dbs.changed')}
              <select
                className={inputCls}
                value={key ? changed : ''}
                disabled={!key}
                onChange={(e) => setChanged(e.target.value)}
                style={{ colorScheme: 'light dark' }}
              >
                <option value="">{t('ps.dbs.noChanged')}</option>
                {changedOptions.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-[0.7rem] text-muted-foreground">
            {!key
              ? t('ps.dbs.howNoKey')
              : changed
                ? t('ps.dbs.howIncremental')
                : t('ps.dbs.howFull')}
          </p>
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.sync.dataset')}
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </label>
        </>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonCls} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={primaryCls}
          disabled={working || !columns || !name.trim()}
          onClick={save}
        >
          {working && columns && <Loader2 size={13} className="animate-spin" />}{' '}
          {t('ps.sync.create')}
        </button>
      </div>
    </Dialog>
  );
}
