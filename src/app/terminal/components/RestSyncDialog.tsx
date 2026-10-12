'use client';

import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi } from '@/lib/terminal/client';
import { CHANGED_TYPES } from '@/lib/terminal/dbSource';
import {
  PAGINATION_STYLES,
  REST_TEMPLATES,
  parseRestSource,
  type Pagination,
  type PaginationStyle,
  type RestColumn,
  type RestOperation,
  type RestSource,
} from '@/lib/terminal/restSource';
import { askWorker } from './connectorAsk';
import { Dialog, buttonCls, errorMessage, inputCls, primaryCls } from './shared';
import { ColumnTypesTable, SamplePreview } from './SourceColumns';

const EXAMPLES = REST_TEMPLATES.filter((x) => x.endpoint);
const METHODS = ['GET', 'POST'] as const;
/** Example field paths and parameter names (API syntax, not translated). */
const EXAMPLE = { records: 'data.items', since: 'updated_since' };

/** "name=value" lines → pairs (lines without "=" are left out). */
function queryPairs(text: string): [string, string][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]);
}

/** Only the settings the chosen style uses. */
function cleanPagination(p: Pagination, method: 'GET' | 'POST'): Pagination {
  const keep: (keyof Pagination)[] = ['has_more_path'];
  if (p.style === 'page') keep.push('page_param', 'first_page', 'size_param', 'size');
  if (p.style === 'offset') keep.push('offset_param', 'size_param', 'size');
  if (p.style === 'cursor') keep.push('cursor_param', 'cursor_path', 'size_param', 'size');
  if (p.style === 'next_url') keep.push('next_path');
  if (method === 'POST' && ['page', 'offset', 'cursor'].includes(p.style)) keep.push('params_in');
  const out: Pagination = { style: p.style };
  for (const k of keep) if (p[k] !== undefined && p[k] !== '') (out as any)[k] = p[k];
  return out;
}

interface Preview {
  columns: RestColumn[];
  sample: Record<string, unknown>[];
  count: number;
  key: string | null;
}

/**
 * A sync of one endpoint of a REST API, in three steps: the endpoint (from
 * the OpenAPI description, an example, or typed), where its records are and
 * how it pages (checked by reading the first page), then the columns, key and
 * "changed" column. A POST endpoint is for those who manage connections.
 */
export function RestSyncDialog({
  connection,
  canPost,
  onClose,
  onSaved,
}: {
  connection: { id: string; name: string; config: Record<string, any> };
  canPost: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  const [step, setStep] = useState(1);
  const [ops, setOps] = useState<{ operations: RestOperation[]; openapi: boolean } | null>(null);
  const [method, setMethod] = useState<'GET' | 'POST'>('GET');
  const [path, setPath] = useState('/');
  const [query, setQuery] = useState('');
  const [body, setBody] = useState('{}');
  const [records, setRecords] = useState('');
  const [pagination, setPagination] = useState<Pagination>({ style: 'none' });
  const [sinceParam, setSinceParam] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [columns, setColumns] = useState<RestColumn[]>([]);
  const [key, setKey] = useState('');
  const [changed, setChanged] = useState('');
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!connection.config.openapi_url) return;
    setWorking(true);
    askWorker<{ operations: RestOperation[]; openapi: boolean }>(connection.id, null)
      .then(setOps)
      .catch((e) => setError(errorMessage(e, t)))
      .finally(() => setWorking(false));
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fill = (e: Partial<RestSource>) => {
    setMethod(e.method === 'POST' && canPost ? 'POST' : 'GET');
    setPath(e.path ?? '/');
    setQuery((e.query ?? []).map(([k, v]) => `${k}=${v}`).join('\n'));
    setBody(e.body ?? '{}');
    setRecords(e.records ?? '');
    setPagination(e.pagination ?? { style: 'none' });
    setSinceParam(e.since_param ?? '');
    setKey(e.key ?? '');
    setChanged(e.changed ?? '');
    setPreview(null);
  };

  const source = (): RestSource | null =>
    parseRestSource({
      mode: 'rest',
      method,
      path: path.trim(),
      query: queryPairs(query),
      body: method === 'POST' ? body : null,
      records: records.trim(),
      pagination: cleanPagination(pagination, method),
      since_param: sinceParam.trim() || null,
      key: key || null,
      changed: (key && changed) || null,
    });

  const read = async () => {
    const s = source();
    if (!s) return;
    setWorking(true);
    setError('');
    try {
      const answer = await askWorker<Preview>(connection.id, { ...s, key: null, changed: null });
      setPreview(answer);
      setColumns(answer.columns);
      if (!answer.columns.some((c) => c.name === key)) setKey(answer.key ?? '');
      if (!answer.columns.some((c) => c.name === changed))
        setChanged(
          answer.columns.find(
            (c) => CHANGED_TYPES.includes(c.type) && /updated|modified|changed|edited/i.test(c.name)
          )?.name ?? ''
        );
      if (!name.trim())
        setName(`${connection.name} · ${s.path.split('/').filter(Boolean).pop() ?? s.path}`);
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
        datasetName: name,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setWorking(false);
    }
  };

  const setP = (patch: Partial<Pagination>) => {
    setPagination({ ...pagination, ...patch });
    setPreview(null);
  };
  const pInput = (k: keyof Pagination, label: string, placeholder?: string, numeric = false) => (
    <label key={k} className="block text-[0.7rem] text-muted-foreground">
      {label}
      <input
        className={`${inputCls} font-mono`}
        inputMode={numeric ? 'numeric' : undefined}
        placeholder={placeholder}
        value={(pagination[k] as string | number | undefined) ?? ''}
        onChange={(e) =>
          setP({
            [k]: numeric ? (e.target.value ? Number(e.target.value) : undefined) : e.target.value,
          })
        }
      />
    </label>
  );
  const changedOptions = columns.filter((c) => CHANGED_TYPES.includes(c.type));
  const valid = source() !== null;

  return (
    <Dialog title={t('ps.rest.add')} onClose={onClose} wide>
      <p className="text-[0.7rem] text-muted-foreground">
        {t('ps.rest.step', { n: step })} · {t(`ps.rest.step${step}` as any)}
      </p>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {step === 1 && (
        <>
          {connection.config.openapi_url && (
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.rest.fromOpenapi')}
              <select
                className={inputCls}
                disabled={!ops}
                value=""
                onChange={(e) => {
                  const op = ops?.operations[Number(e.target.value)];
                  if (op)
                    fill({
                      method: op.method,
                      path: op.path,
                      records: op.records ?? '',
                      pagination: op.pagination ?? { style: 'none' },
                    });
                }}
                style={{ colorScheme: 'light dark' }}
              >
                <option value="">
                  {ops ? t('ps.rest.pickOperation') : t('ps.rest.loadingOperations')}
                </option>
                {ops?.operations.map((o, i) => (
                  <option key={`${o.method} ${o.path}`} value={String(i)}>
                    {o.method} {o.path}
                    {o.summary ? ` — ${o.summary}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.rest.example')}
            <select
              className={inputCls}
              value=""
              onChange={(e) => {
                const x = EXAMPLES.find((x) => x.id === e.target.value);
                if (x?.endpoint) fill(x.endpoint);
              }}
              style={{ colorScheme: 'light dark' }}
            >
              <option value="">{t('ps.rest.noExample')}</option>
              {EXAMPLES.map((x) => (
                <option key={x.id} value={x.id}>
                  {t(`ps.conn.tpl.${x.id}` as any)}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.rest.method')}
              <select
                className={inputCls}
                value={method}
                onChange={(e) => setMethod(e.target.value as 'GET' | 'POST')}
                style={{ colorScheme: 'light dark' }}
              >
                {METHODS.filter((m) => canPost || m === 'GET').map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.rest.path')}
              <input
                className={`${inputCls} font-mono`}
                value={path}
                maxLength={500}
                onChange={(e) => setPath(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.rest.query')}
            <textarea
              className={`${inputCls} font-mono`}
              rows={3}
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {method === 'POST' && (
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.rest.body')}
              <textarea
                className={`${inputCls} font-mono`}
                rows={4}
                maxLength={20000}
                spellCheck={false}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <span>{t('ps.rest.bodyHint')}</span>
            </label>
          )}
        </>
      )}

      {step === 2 && (
        <>
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.rest.records')}
            <input
              className={`${inputCls} font-mono`}
              placeholder={EXAMPLE.records}
              value={records}
              onChange={(e) => {
                setRecords(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.rest.pagination')}
              <select
                className={inputCls}
                value={pagination.style}
                onChange={(e) => setP({ style: e.target.value as PaginationStyle })}
                style={{ colorScheme: 'light dark' }}
              >
                {PAGINATION_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {t(`ps.rest.style.${s}` as any)}
                  </option>
                ))}
              </select>
            </label>
            {method === 'POST' && ['page', 'offset', 'cursor'].includes(pagination.style) && (
              <label className="block text-[0.7rem] text-muted-foreground">
                {t('ps.rest.params_in')}
                <select
                  className={inputCls}
                  value={pagination.params_in ?? 'query'}
                  onChange={(e) => setP({ params_in: e.target.value as 'query' | 'body' })}
                  style={{ colorScheme: 'light dark' }}
                >
                  <option value="query">{t('ps.rest.in.query')}</option>
                  <option value="body">{t('ps.rest.in.body')}</option>
                </select>
              </label>
            )}
            {pagination.style === 'page' && [
              pInput('page_param', t('ps.rest.page_param'), 'page'),
              pInput('first_page', t('ps.rest.first_page'), '1', true),
            ]}
            {pagination.style === 'offset' &&
              pInput('offset_param', t('ps.rest.offset_param'), 'offset')}
            {pagination.style === 'cursor' && [
              pInput('cursor_param', t('ps.rest.cursor_param'), 'cursor'),
              pInput('cursor_path', t('ps.rest.cursor_path'), 'meta.next_cursor'),
            ]}
            {['page', 'offset', 'cursor'].includes(pagination.style) && [
              pInput('size_param', t('ps.rest.size_param'), 'limit'),
              pInput('size', t('ps.rest.size'), '100', true),
            ]}
            {pagination.style === 'next_url' &&
              pInput('next_path', t('ps.rest.next_path'), 'links.next')}
            {pagination.style !== 'none' &&
              pInput('has_more_path', t('ps.rest.has_more_path'), 'has_more')}
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.rest.since_param')}
              <input
                className={`${inputCls} font-mono`}
                placeholder={EXAMPLE.since}
                value={sinceParam}
                onChange={(e) => setSinceParam(e.target.value)}
              />
            </label>
          </div>
          <p className="text-[0.68rem] text-muted-foreground">{t('ps.rest.pagingHint')}</p>
          <button type="button" className={buttonCls} disabled={working || !valid} onClick={read}>
            {working && <Loader2 size={11} className="animate-spin" />} {t('ps.rest.preview')}
          </button>
          {preview && (
            <>
              <p className="text-[0.7rem] text-muted-foreground">
                {preview.count
                  ? t('ps.rest.previewCount', { count: fmt.number(preview.count) })
                  : t('ps.rest.noRecords')}
              </p>
              <SamplePreview columns={preview.columns} sample={preview.sample} />
            </>
          )}
        </>
      )}

      {step === 3 && (
        <>
          <ColumnTypesTable
            columns={columns}
            onType={(i, type) => {
              const next = [...columns];
              next[i] = { ...columns[i], type };
              setColumns(next);
              if (changed === columns[i].name && !CHANGED_TYPES.includes(type)) setChanged('');
            }}
          />
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
              ? t('ps.rest.howNoKey')
              : changed && sinceParam.trim()
                ? t('ps.rest.howIncremental')
                : t('ps.rest.howFull')}
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
        <button
          type="button"
          className={buttonCls}
          onClick={step === 1 ? onClose : () => setStep(step - 1)}
        >
          {step === 1 ? t('common.cancel') : t('ps.rest.back')}
        </button>
        {step < 3 ? (
          <button
            type="button"
            className={primaryCls}
            disabled={working || !valid || (step === 2 && (!preview || !columns.length))}
            onClick={() => setStep(step + 1)}
          >
            {t('ps.rest.next')}
          </button>
        ) : (
          <button
            type="button"
            className={primaryCls}
            disabled={working || !columns.length || !name.trim()}
            onClick={save}
          >
            {working && <Loader2 size={13} className="animate-spin" />} {t('ps.sync.create')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
