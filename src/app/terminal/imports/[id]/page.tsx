'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { COLUMN_TYPES, type ColumnType } from '@/lib/terminal/tabular';
import { ERP_TARGETS, type ErpTarget } from '@/lib/terminal/erpTargets';
import {
  terminalApi,
  type AnalyzedImport,
  type DatasetInfo,
  type Overview,
} from '@/lib/terminal/client';
import { useWorkspace } from '@/app/erp/lib/WorkspaceContext';
import {
  Status,
  buttonCls,
  bytes,
  errorMessage,
  inputCls,
  primaryCls,
} from '../../components/shared';

type Target = 'new_dataset' | 'dataset' | 'erp';

interface MapRow {
  source: string;
  target: string;
  label: string;
  type: ColumnType;
  key: boolean;
  sensitive: boolean;
  skip: boolean;
}

export default function ImportPage() {
  const { id } = useParams<{ id: string }>();
  const { t, fmt } = useI18n();
  const { active } = useWorkspace();
  const [data, setData] = useState<AnalyzedImport | null>(null);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [target, setTarget] = useState<Target>('new_dataset');
  const [datasetId, setDatasetId] = useState('');
  const [erpEntity, setErpEntity] = useState<ErpTarget>('customers');
  const [mode, setMode] = useState<'append' | 'upsert' | 'replace'>('append');
  const [name, setName] = useState('');
  const [rows, setRows] = useState<MapRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await terminalApi<AnalyzedImport>('import.get', { id });
      setData(next);
      setError('');
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }, [id, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!active?.id) return;
    terminalApi<Overview>('overview', { workspaceId: active.id })
      .then((o) => {
        setDatasets(o.datasets.filter((d) => d.status === 'ready'));
        setPermissions(o.permissions);
      })
      .catch(() => undefined);
  }, [active?.id]);

  const status = data?.import.status;
  useEffect(() => {
    if (status !== 'analyzing' && status !== 'committing' && status !== 'uploaded') return;
    const timer = setTimeout(load, 2000);
    return () => clearTimeout(timer);
  }, [status, data, load]);

  // The mapping starts from the analysis: every column to a column of the same name.
  const analysis = data?.import.analysis ?? null;
  useEffect(() => {
    if (!analysis) return;
    setName((n) => n || (data?.import.file_name ?? '').replace(/\.[^.]+$/, ''));
    setRows(
      analysis.columns.map((c) => ({
        source: c.name,
        target: '',
        label: c.name,
        type: c.type,
        key: false,
        sensitive: false,
        skip: false,
      }))
    );
  }, [analysis, data?.import.file_name]);

  const chosen = datasets.find((d) => d.id === datasetId) ?? null;
  // For an existing dataset, columns are matched by name when possible.
  useEffect(() => {
    if (target !== 'dataset' || !chosen) return;
    setRows((rs) =>
      rs.map((r) => ({
        ...r,
        target:
          chosen.columns.find((c) => !c.hidden && c.label.toLowerCase() === r.source.toLowerCase())
            ?.physical ?? '',
      }))
    );
  }, [target, chosen]);
  useEffect(() => {
    if (target !== 'erp') return;
    setMode('append');
    setRows((rs) =>
      rs.map((r) => ({
        ...r,
        target:
          ERP_TARGETS[erpEntity].fields.find(
            (f) => f.key === r.source.toLowerCase().replace(/\s+/g, '_')
          )?.key ?? '',
      }))
    );
  }, [target, erpEntity]);

  const reanalyze = async (options: Record<string, unknown>) => {
    try {
      await terminalApi('import.reanalyze', {
        id,
        options: { ...(analysis?.options ?? {}), ...options },
      });
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      await terminalApi('import.commit', {
        id,
        mapping: {
          target,
          mode,
          name,
          datasetId: target === 'dataset' ? datasetId : null,
          erpEntity: target === 'erp' ? erpEntity : null,
          columns: rows.map((r) => ({
            ...r,
            skip: r.skip || (target !== 'new_dataset' && !r.target),
          })),
        },
      });
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await terminalApi('import.cancel', { id });
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  const ready = useMemo(() => {
    const used = rows.filter((r) => !r.skip && (target === 'new_dataset' || r.target));
    if (!used.length) return false;
    if (target === 'new_dataset') return !!name.trim() && used.every((r) => r.label.trim());
    if (target === 'dataset')
      return !!chosen && (mode !== 'upsert' || chosen.columns.some((c) => c.key));
    return ERP_TARGETS[erpEntity].fields
      .filter((f) => f.required)
      .every((f) => used.some((r) => r.target === f.key));
  }, [rows, target, name, chosen, mode, erpEntity]);

  if (error)
    return (
      <p role="alert" className="text-[0.8rem] text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!data) return <div className="h-40 rounded-xl animate-pulse bg-[var(--surface-3)]" />;
  const imp = data.import;
  const canErp = (e: ErpTarget) => permissions.includes(e);

  return (
    <div className="space-y-4">
      <Link
        href="/terminal?tab=imports"
        className="inline-flex items-center gap-1 text-[0.72rem] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={12} /> {t('ps.tab.imports')}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.2rem] font-bold text-foreground">{imp.file_name}</h1>
          <p className="text-[0.75rem] text-muted-foreground mt-0.5 flex flex-wrap items-center gap-2">
            <Status value={imp.status} />
            <span>{bytes(imp.size_bytes)}</span>
            {imp.rows_total !== null && (
              <span>{t('ps.ds.rowsCount', { count: fmt.number(imp.rows_total) })}</span>
            )}
          </p>
          {imp.error_key && (
            <p className="text-[0.72rem] text-red-600 dark:text-red-400 mt-1">
              {t('ps.imp.failed', { code: imp.error_key })}
            </p>
          )}
        </div>
        {(imp.status === 'analyzing' ||
          imp.status === 'analyzed' ||
          imp.status === 'committing') && (
          <button type="button" className={`${buttonCls} hover:text-red-500`} onClick={cancel}>
            <XCircle size={12} /> {t('ps.imp.cancel')}
          </button>
        )}
      </div>

      {(imp.status === 'analyzing' || imp.status === 'uploaded') && (
        <p className="flex items-center gap-2 text-[0.8rem] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> {t('ps.imp.analyzing')}
        </p>
      )}

      {imp.status === 'committing' && (
        <p className="flex items-center gap-2 text-[0.8rem] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          {t('ps.imp.committing', {
            ok: fmt.number(imp.rows_ok),
            rejected: fmt.number(imp.rows_rejected),
          })}
        </p>
      )}

      {imp.status === 'committed' && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-1">
          <p className="text-[0.85rem] text-foreground">
            {t('ps.imp.done', {
              ok: fmt.number(imp.rows_ok),
              rejected: fmt.number(imp.rows_rejected),
            })}
          </p>
          {imp.target_dataset_id && (
            <Link
              href={`/terminal/datasets/${imp.target_dataset_id}`}
              className="text-[0.75rem] text-foreground underline"
            >
              {t('ps.imp.openDataset')}
            </Link>
          )}
        </div>
      )}

      {analysis && imp.status === 'analyzed' && (
        <>
          <section className="rounded-xl border border-border bg-card p-4 space-y-3">
            <h2 className="text-[0.85rem] font-semibold text-foreground">{t('ps.imp.read')}</h2>
            <div className="flex flex-wrap gap-3 text-[0.72rem]">
              {analysis.sheets && analysis.sheets.length > 1 && (
                <label className="text-muted-foreground">
                  {t('ps.imp.sheet')}
                  <select
                    className={inputCls}
                    value={analysis.sheet}
                    onChange={(e) => reanalyze({ sheet: e.target.value })}
                    style={{ colorScheme: 'light dark' }}
                  >
                    {analysis.sheets.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
              )}
              {analysis.delimiter && (
                <label className="text-muted-foreground">
                  {t('ps.imp.delimiter')}
                  <select
                    className={inputCls}
                    value={analysis.delimiter}
                    onChange={(e) => reanalyze({ delimiter: e.target.value })}
                    style={{ colorScheme: 'light dark' }}
                  >
                    {[',', ';', '\t', '|'].map((d) => (
                      <option key={d} value={d}>
                        {d === '\t' ? t('ps.imp.tab') : d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="text-muted-foreground">
                {t('ps.imp.decimal')}
                <select
                  className={inputCls}
                  value={analysis.decimal}
                  onChange={(e) => reanalyze({ decimal: e.target.value })}
                  style={{ colorScheme: 'light dark' }}
                >
                  <option value=".">1,234.56</option>
                  <option value=",">1.234,56</option>
                </select>
              </label>
              <label className="flex items-end gap-1 text-foreground">
                <input
                  type="checkbox"
                  checked={analysis.header}
                  onChange={(e) => reanalyze({ header: e.target.checked })}
                />{' '}
                {t('ps.imp.header')}
              </label>
              {analysis.encoding && (
                <span className="self-end text-muted-foreground">
                  {t('ps.imp.encoding', { encoding: analysis.encoding })}
                </span>
              )}
              <button
                type="button"
                className={`${buttonCls} self-end`}
                onClick={() => reanalyze({})}
              >
                <RefreshCw size={11} /> {t('ps.imp.reread')}
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="text-[0.7rem]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    {analysis.columns.map((c) => (
                      <th key={c.name} className="px-2 py-1 whitespace-nowrap">
                        {c.name}{' '}
                        <span className="font-normal">· {t(`ps.type.${c.type}` as any)}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {analysis.preview.slice(0, 8).map((r, i) => (
                    <tr key={i} className="border-t border-border">
                      {r.map((v, j) => (
                        <td key={j} className="px-2 py-1 whitespace-nowrap max-w-[12rem] truncate">
                          {v ?? ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-4 space-y-3">
            <h2 className="text-[0.85rem] font-semibold text-foreground">{t('ps.imp.where')}</h2>
            <div className="flex flex-wrap gap-4 text-[0.78rem]">
              {(['new_dataset', 'dataset', 'erp'] as Target[]).map((v) => (
                <label key={v} className="flex items-center gap-1.5 text-foreground">
                  <input
                    type="radio"
                    name="target"
                    checked={target === v}
                    onChange={() => setTarget(v)}
                  />{' '}
                  {t(`ps.imp.target.${v}` as any)}
                </label>
              ))}
            </div>
            {target === 'new_dataset' && (
              <label className="block text-[0.7rem] text-muted-foreground max-w-md">
                {t('ps.ds.name')}
                <input
                  className={inputCls}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={120}
                />
              </label>
            )}
            {target === 'dataset' && (
              <div className="flex flex-wrap gap-3">
                <select
                  className={`${inputCls} max-w-xs`}
                  value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)}
                  aria-label={t('ps.imp.pickDataset')}
                  style={{ colorScheme: 'light dark' }}
                >
                  <option value="">{t('ps.imp.pickDataset')}</option>
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.folder ? `${d.folder} / ${d.name}` : d.name}
                    </option>
                  ))}
                </select>
                <select
                  className={`${inputCls} w-48`}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as any)}
                  aria-label={t('ps.imp.mode')}
                  style={{ colorScheme: 'light dark' }}
                >
                  {(['append', 'upsert', 'replace'] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`ps.mode.${m}` as any)}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {target === 'erp' && (
              <div className="space-y-1">
                <select
                  className={`${inputCls} max-w-xs`}
                  value={erpEntity}
                  onChange={(e) => setErpEntity(e.target.value as ErpTarget)}
                  aria-label={t('ps.imp.erpList')}
                  style={{ colorScheme: 'light dark' }}
                >
                  {(Object.keys(ERP_TARGETS) as ErpTarget[]).map((e) => (
                    <option key={e} value={e} disabled={!canErp(e)}>
                      {t(`ps.erp.${e}` as any)}
                    </option>
                  ))}
                </select>
                <p className="text-[0.7rem] text-muted-foreground">{t('ps.imp.erpHint')}</p>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-[0.72rem]">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="px-2 py-1">{t('ps.imp.fileColumn')}</th>
                    <th className="px-2 py-1">{t('ps.imp.goesTo')}</th>
                    {target === 'new_dataset' && (
                      <>
                        <th className="px-2 py-1">{t('ps.ds.columnType')}</th>
                        <th className="px-2 py-1">{t('ps.ds.key')}</th>
                        <th className="px-2 py-1">{t('ps.ds.sensitive')}</th>
                      </>
                    )}
                    <th className="px-2 py-1">{t('ps.imp.skip')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const set = (patch: Partial<MapRow>) =>
                      setRows(rows.map((x, n) => (n === i ? { ...x, ...patch } : x)));
                    return (
                      <tr key={r.source} className="border-b border-border last:border-0">
                        <td className="px-2 py-1 text-foreground">{r.source}</td>
                        <td className="px-2 py-1">
                          {target === 'new_dataset' ? (
                            <input
                              className={inputCls}
                              disabled={r.skip}
                              value={r.label}
                              aria-label={t('ps.ds.columnName')}
                              onChange={(e) => set({ label: e.target.value })}
                            />
                          ) : (
                            <select
                              className={inputCls}
                              disabled={r.skip}
                              value={r.target}
                              aria-label={t('ps.imp.goesTo')}
                              onChange={(e) => set({ target: e.target.value })}
                              style={{ colorScheme: 'light dark' }}
                            >
                              <option value="">{t('ps.imp.notImported')}</option>
                              {target === 'dataset'
                                ? chosen?.columns
                                    .filter((c) => !c.hidden && c.provisioned)
                                    .map((c) => (
                                      <option key={c.physical} value={c.physical}>
                                        {c.label} · {t(`ps.type.${c.type}` as any)}
                                      </option>
                                    ))
                                : ERP_TARGETS[erpEntity].fields.map((f) => (
                                    <option key={f.key} value={f.key}>
                                      {t(`ps.erpField.${f.key}` as any)}
                                      {f.required ? ' *' : ''}
                                    </option>
                                  ))}
                            </select>
                          )}
                        </td>
                        {target === 'new_dataset' && (
                          <>
                            <td className="px-2 py-1">
                              <select
                                className={inputCls}
                                disabled={r.skip}
                                value={r.type}
                                aria-label={t('ps.ds.columnType')}
                                onChange={(e) => set({ type: e.target.value as ColumnType })}
                                style={{ colorScheme: 'light dark' }}
                              >
                                {COLUMN_TYPES.map((ty) => (
                                  <option key={ty} value={ty}>
                                    {t(`ps.type.${ty}` as any)}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-1">
                              <input
                                type="checkbox"
                                disabled={r.skip}
                                checked={r.key}
                                aria-label={t('ps.ds.key')}
                                onChange={(e) => set({ key: e.target.checked })}
                              />
                            </td>
                            <td className="px-2 py-1">
                              <input
                                type="checkbox"
                                disabled={r.skip}
                                checked={r.sensitive}
                                aria-label={t('ps.ds.sensitive')}
                                onChange={(e) => set({ sensitive: e.target.checked })}
                              />
                            </td>
                          </>
                        )}
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            checked={r.skip}
                            aria-label={t('ps.imp.skip')}
                            onChange={(e) => set({ skip: e.target.checked })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {target === 'dataset' &&
              mode === 'upsert' &&
              chosen &&
              !chosen.columns.some((c) => c.key) && (
                <p role="alert" className="text-[0.72rem] text-amber-700 dark:text-amber-400">
                  {t('ps.err.no_key')}
                </p>
              )}
            <p className="text-[0.7rem] text-muted-foreground">{t('ps.imp.rejectHint')}</p>
            <button type="button" className={primaryCls} disabled={!ready || busy} onClick={commit}>
              {busy && <Loader2 size={13} className="animate-spin" />}{' '}
              {t('ps.imp.commit', { count: fmt.number(imp.rows_total ?? 0) })}
            </button>
          </section>
        </>
      )}

      {data.rejects.length > 0 && (
        <section className="rounded-xl border border-border bg-card p-4 space-y-2">
          <h2 className="text-[0.85rem] font-semibold text-foreground">
            {t('ps.imp.rejected', { count: fmt.number(imp.rows_rejected) })}
          </h2>
          <ul className="text-[0.72rem] space-y-1">
            {data.rejects.map((r) => (
              <li key={r.row_number} className="flex flex-wrap gap-2">
                <span className="text-muted-foreground">
                  {t('ps.imp.line', { line: r.row_number })}
                </span>
                <span className="text-foreground">{t(`ps.reject.${r.reason}` as any)}</span>
                {r.column_name && <span className="text-muted-foreground">{r.column_name}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
