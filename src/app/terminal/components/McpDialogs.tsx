'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi } from '@/lib/terminal/client';
import { argumentsTemplate, parseMcpSource, type McpSource } from '@/lib/terminal/mcpSource';
import type { RestColumn } from '@/lib/terminal/restSource';
import { askWorker } from './connectorAsk';
import { Dialog, buttonCls, errorMessage, inputCls, primaryCls } from './shared';
import { ColumnTypesTable, SamplePreview } from './SourceColumns';

interface ToolRow {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  input_schema: Record<string, unknown> | null;
  read_only: boolean | null;
  seen_at: string;
  was_approved: boolean;
  approved: boolean;
}

/** Example records path (JSON syntax, not translated). */
const RECORDS_EXAMPLE = 'items';

function useTools(connectionId: string) {
  const { t } = useI18n();
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const load = useCallback(async () => {
    try {
      setTools(await terminalApi<ToolRow[]>('mcpTools.list', { connectionId }));
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }, [connectionId, t]);
  useEffect(() => {
    void load();
  }, [load]);
  return { tools, load };
}

/**
 * An MCP server's tools as last listed: each with the server's own
 * description (quoted, never followed), its read-only hint and schema, and
 * whether it is approved as it is now. Managers approve or withdraw.
 */
export function McpToolsDialog({
  connection,
  canApprove,
  onClose,
}: {
  connection: { id: string; name: string };
  canApprove: boolean;
  onClose: () => void;
}) {
  const { t, fmt } = useI18n();
  const { tools, load } = useTools(connection.id);
  const [asking, setAsking] = useState(false);

  const refresh = async () => {
    setAsking(true);
    try {
      await askWorker(connection.id, null);
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setAsking(false);
    }
  };

  const approve = async (tool: ToolRow, yes: boolean) => {
    if (yes && !confirm(t('ps.mcp.approveConfirm', { name: tool.name }))) return;
    try {
      await terminalApi('mcpTool.approve', { id: tool.id, approve: yes });
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  return (
    <Dialog title={t('ps.mcp.toolsTitle', { name: connection.name })} onClose={onClose} wide>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.7rem] text-muted-foreground max-w-xl">
          {t('ps.mcp.descriptionNote')}
        </p>
        <button type="button" className={buttonCls} disabled={asking} onClick={refresh}>
          {asking ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}{' '}
          {t('ps.mcp.refresh')}
        </button>
      </div>
      {!tools ? (
        <div className="h-16 rounded-lg animate-pulse bg-[var(--surface-3)]" />
      ) : tools.length === 0 ? (
        <p className="text-[0.75rem] text-muted-foreground">{t('ps.mcp.noTools')}</p>
      ) : (
        <ul className="max-h-[60vh] space-y-2 overflow-auto">
          {tools.map((tool) => (
            <li key={tool.id} className="rounded-lg border border-border px-3 py-2 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-[0.75rem]">
                <span className="font-mono font-medium text-foreground">{tool.name}</span>
                {tool.title && <span className="text-muted-foreground">{tool.title}</span>}
                <span
                  className={
                    tool.approved
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : tool.was_approved
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground'
                  }
                >
                  {tool.approved
                    ? t('ps.mcp.approved')
                    : tool.was_approved
                      ? t('ps.mcp.changed')
                      : t('ps.mcp.notApproved')}
                </span>
                <span className="text-muted-foreground">
                  ·{' '}
                  {tool.read_only === true
                    ? t('ps.mcp.readOnly')
                    : tool.read_only === false
                      ? t('ps.mcp.mayAct')
                      : t('ps.mcp.noHint')}
                </span>
                <span className="text-muted-foreground">
                  · {t('ps.mcp.listed', { when: fmt.dateTime(tool.seen_at) })}
                </span>
                {canApprove && (
                  <span className="ml-auto">
                    {tool.approved ? (
                      <button
                        type="button"
                        className={buttonCls}
                        onClick={() => approve(tool, false)}
                      >
                        <ShieldOff size={11} /> {t('ps.mcp.unapprove')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={buttonCls}
                        onClick={() => approve(tool, true)}
                      >
                        <ShieldCheck size={11} /> {t('ps.mcp.approve')}
                      </button>
                    )}
                  </span>
                )}
              </div>
              {tool.description && (
                <blockquote className="max-h-32 overflow-auto whitespace-pre-wrap border-l-2 border-border pl-2 text-[0.7rem] text-muted-foreground">
                  {tool.description}
                </blockquote>
              )}
              {tool.input_schema && (
                <details className="text-[0.68rem]">
                  <summary className="cursor-pointer text-muted-foreground">
                    {t('ps.mcp.schema')}
                  </summary>
                  <pre className="max-h-40 overflow-auto rounded bg-[var(--surface-3)] p-2 font-mono">
                    {JSON.stringify(tool.input_schema, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

interface Preview {
  columns: RestColumn[];
  sample: Record<string, unknown>[];
  count: number;
  key: string | null;
}

/**
 * A sync of an MCP server, in two steps: the call (an approved tool with its
 * arguments, or a resource), checked by calling it once, then the columns,
 * key and dataset.
 */
export function McpSyncDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: { id: string; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  const { tools } = useTools(connection.id);
  const approved = (tools ?? []).filter((x) => x.approved);
  const [step, setStep] = useState(1);
  const [what, setWhat] = useState<'tool' | 'resource'>('tool');
  const [name, setName] = useState('');
  const [args, setArgs] = useState('{}');
  const [records, setRecords] = useState('');
  const [resources, setResources] = useState<{ uri: string; name: string | null }[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [columns, setColumns] = useState<RestColumn[]>([]);
  const [key, setKey] = useState('');
  const [dataset, setDataset] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const source = (): McpSource | null =>
    parseMcpSource({
      mode: 'mcp',
      what,
      name,
      arguments: args,
      records: records.trim(),
      key: key || null,
    });
  const valid = source() !== null;

  const pickWhat = async (next: 'tool' | 'resource') => {
    setWhat(next);
    setName('');
    setPreview(null);
    if (next === 'resource' && !resources) {
      setWorking(true);
      try {
        const answer = await askWorker<{ resources: { uri: string; name: string | null }[] }>(
          connection.id,
          null
        );
        setResources(answer.resources);
      } catch (e) {
        setError(errorMessage(e, t));
      } finally {
        setWorking(false);
      }
    }
  };

  const call = async () => {
    const s = source();
    if (!s) return;
    setWorking(true);
    setError('');
    try {
      const answer = await askWorker<Preview>(connection.id, { ...s, key: null });
      setPreview(answer);
      setColumns(answer.columns);
      if (!answer.columns.some((c) => c.name === key)) setKey(answer.key ?? '');
      if (!dataset.trim()) setDataset(`${connection.name} · ${s.name}`.slice(0, 120));
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setWorking(false);
    }
  };

  const save = async () => {
    const s = source();
    if (!s || !columns.length) return;
    setWorking(true);
    setError('');
    try {
      await terminalApi('sync.createSource', {
        connectionId: connection.id,
        source: s,
        columns: columns.map((c) => ({ name: c.name, type: c.type })),
        datasetName: dataset,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setWorking(false);
    }
  };

  return (
    <Dialog title={t('ps.mcp.add')} onClose={onClose} wide>
      <p className="text-[0.7rem] text-muted-foreground">
        {t('ps.mcp.step', { n: step })} · {t(`ps.mcp.step${step}` as any)}
      </p>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {step === 1 && (
        <>
          <div className="flex gap-3 text-[0.75rem]" role="radiogroup">
            {(['tool', 'resource'] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="mcp-what"
                  checked={what === m}
                  onChange={() => void pickWhat(m)}
                />
                {t(`ps.mcp.what.${m}` as any)}
              </label>
            ))}
          </div>
          {what === 'tool' ? (
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.mcp.tool')}
              <select
                className={inputCls}
                value={name}
                disabled={!tools}
                onChange={(e) => {
                  setName(e.target.value);
                  setArgs(
                    argumentsTemplate(approved.find((x) => x.name === e.target.value)?.input_schema)
                  );
                  setPreview(null);
                }}
                style={{ colorScheme: 'light dark' }}
              >
                <option value="">{tools ? t('ps.mcp.pickTool') : t('ps.mcp.loading')}</option>
                {approved.map((x) => (
                  <option key={x.id} value={x.name}>
                    {x.name}
                    {x.title ? ` — ${x.title}` : ''}
                  </option>
                ))}
              </select>
              {tools && !approved.length && <span>{t('ps.mcp.noApproved')}</span>}
            </label>
          ) : (
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.mcp.resource')}
              <select
                className={inputCls}
                value={name}
                disabled={!resources}
                onChange={(e) => {
                  setName(e.target.value);
                  setPreview(null);
                }}
                style={{ colorScheme: 'light dark' }}
              >
                <option value="">
                  {resources ? t('ps.mcp.pickResource') : t('ps.mcp.loading')}
                </option>
                {resources?.map((r) => (
                  <option key={r.uri} value={r.uri}>
                    {r.name ? `${r.name} — ${r.uri}` : r.uri}
                  </option>
                ))}
              </select>
            </label>
          )}
          {what === 'tool' && (
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.mcp.arguments')}
              <textarea
                className={`${inputCls} font-mono`}
                rows={5}
                maxLength={20000}
                spellCheck={false}
                value={args}
                onChange={(e) => {
                  setArgs(e.target.value);
                  setPreview(null);
                }}
              />
              <span>{t('ps.mcp.argumentsHint')}</span>
            </label>
          )}
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.rest.records')}
            <input
              className={`${inputCls} font-mono`}
              placeholder={RECORDS_EXAMPLE}
              value={records}
              onChange={(e) => {
                setRecords(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <button type="button" className={buttonCls} disabled={working || !valid} onClick={call}>
            {working && <Loader2 size={11} className="animate-spin" />} {t('ps.mcp.preview')}
          </button>
          {preview && (
            <>
              <p className="text-[0.7rem] text-muted-foreground">
                {preview.count
                  ? t('ps.rest.previewCount', { count: fmt.number(preview.count) })
                  : t('ps.web.noRecords')}
              </p>
              <SamplePreview columns={preview.columns} sample={preview.sample} />
            </>
          )}
        </>
      )}
      {step === 2 && (
        <>
          <ColumnTypesTable
            columns={columns}
            onType={(i, type) => {
              const next = [...columns];
              next[i] = { ...columns[i], type };
              setColumns(next);
            }}
          />
          <label className="block text-[0.7rem] text-muted-foreground max-w-sm">
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
                </option>
              ))}
            </select>
          </label>
          <p className="text-[0.7rem] text-muted-foreground">{t('ps.mcp.how')}</p>
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.sync.dataset')}
            <input
              className={inputCls}
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
              maxLength={120}
            />
          </label>
        </>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={buttonCls}
          onClick={step === 1 ? onClose : () => setStep(1)}
        >
          {step === 1 ? t('common.cancel') : t('ps.rest.back')}
        </button>
        {step === 1 ? (
          <button
            type="button"
            className={primaryCls}
            disabled={working || !valid || !preview || !columns.length}
            onClick={() => setStep(2)}
          >
            {t('ps.rest.next')}
          </button>
        ) : (
          <button
            type="button"
            className={primaryCls}
            disabled={working || !columns.length || !dataset.trim() || !valid}
            onClick={save}
          >
            {working && <Loader2 size={13} className="animate-spin" />} {t('ps.sync.create')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
