'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Plus,
  Save,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { WORKSPACE_ROLES } from '@/app/erp/lib/erpRules';
import {
  downloadDatasetCsv,
  terminalApi,
  type DatasetColumn,
  type DatasetDetail,
} from '@/lib/terminal/client';
import { ColumnsEditor, type ColumnDraft } from '../../components/dialogs';
import { DatasetEntity } from '../../components/DatasetEntity';
import {
  Status,
  buttonCls,
  bytes,
  errorMessage,
  inputCls,
  primaryCls,
} from '../../components/shared';

const PAGE = 100;
const SECTIONS = ['data', 'columns', 'meaning', 'access', 'history'] as const;
type Section = (typeof SECTIONS)[number];
const GRANTABLE = [
  'datasets.view',
  'datasets.query',
  'datasets.import',
  'datasets.edit',
  'datasets.export',
  'datasets.schema',
];

export default function DatasetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { t, fmt } = useI18n();
  const [detail, setDetail] = useState<DatasetDetail | null>(null);
  const [error, setError] = useState('');
  const [section, setSection] = useState<Section>('data');
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ row: number; col: string; value: string } | null>(null);
  const [adding, setAdding] = useState<Record<string, string> | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(
        await terminalApi<DatasetDetail>('dataset.get', {
          id,
          offset,
          limit: PAGE,
          sort: sort?.col,
          desc: sort?.desc,
        })
      );
      setError('');
    } catch (e) {
      setError(errorMessage(e, t));
    }
  }, [id, offset, sort, t]);

  useEffect(() => {
    load();
  }, [load]);

  // A table being built or changed by the worker: look again shortly.
  useEffect(() => {
    if (detail?.dataset.status !== 'provisioning' && detail?.dataset.status !== 'altering') return;
    const timer = setTimeout(load, 2500);
    return () => clearTimeout(timer);
  }, [detail, load]);

  const rows = async (payload: Record<string, unknown>) => {
    try {
      await terminalApi('dataset.rows', { id, ...payload });
      await load();
      return true;
    } catch (e) {
      toast.error(errorMessage(e, t));
      return false;
    }
  };

  if (error)
    return (
      <p role="alert" className="text-[0.8rem] text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  if (!detail) return <div className="h-40 rounded-xl animate-pulse bg-[var(--surface-3)]" />;
  const { dataset: ds, page, can } = detail;
  const cols = page.columns;

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadDatasetCsv(ds.id, ds.name);
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setExporting(false);
    }
  };

  const remove = async () => {
    if (!confirm(t('ps.ds.deleteConfirm', { name: ds.name }))) return;
    try {
      await terminalApi('dataset.delete', { id: ds.id });
      toast.success(t('ps.ds.deleted'));
      router.push('/terminal?tab=datasets');
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  return (
    <div className="space-y-4">
      <Link
        href="/terminal?tab=datasets"
        className="inline-flex items-center gap-1 text-[0.72rem] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={12} /> {t('ps.tab.datasets')}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.2rem] font-bold text-foreground">{ds.name}</h1>
          <p className="text-[0.75rem] text-muted-foreground mt-0.5 flex flex-wrap items-center gap-2">
            {ds.folder && <span>{ds.folder}</span>}
            <Status value={ds.status} />
            <span>{t('ps.ds.rowsCount', { count: fmt.number(page.total || ds.rowCount) })}</span>
            <span>{bytes(ds.sizeBytes)}</span>
            {ds.access === 'restricted' && <span>{t('ps.ds.restrictedBadge')}</span>}
          </p>
          {ds.description && (
            <p className="text-[0.75rem] text-muted-foreground mt-1 max-w-2xl">{ds.description}</p>
          )}
          {ds.status === 'failed' && (
            <p className="text-[0.72rem] text-red-600 dark:text-red-400 mt-1">
              {t('ps.ds.failed', { code: ds.error ?? '' })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {can.export && (
            <button type="button" className={buttonCls} disabled={exporting} onClick={exportCsv}>
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}{' '}
              {t('ps.ds.export')}
            </button>
          )}
          {can.delete && (
            <button type="button" className={`${buttonCls} hover:text-red-500`} onClick={remove}>
              <Trash2 size={12} /> {t('ps.ds.delete')}
            </button>
          )}
        </div>
      </div>

      <div role="tablist" className="flex gap-1 border-b border-border">
        {SECTIONS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={section === s}
            onClick={() => setSection(s)}
            className={`px-3 py-2 text-[0.78rem] -mb-px border-b-2 ${section === s ? 'border-foreground text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(`ps.ds.section.${s}` as any)}
          </button>
        ))}
      </div>

      {section === 'data' && (
        <div className="space-y-2">
          {!page.unmasked && cols.some((c) => c.sensitive) && (
            <p className="text-[0.7rem] text-muted-foreground">{t('ps.ds.masked')}</p>
          )}
          {can.edit && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonCls} onClick={() => setAdding({})}>
                <Plus size={12} /> {t('ps.ds.addRow')}
              </button>
              {selected.size > 0 && (
                <button
                  type="button"
                  className={`${buttonCls} hover:text-red-500`}
                  onClick={async () => {
                    if (!confirm(t('ps.ds.deleteRowsConfirm', { count: selected.size }))) return;
                    if (await rows({ op: 'delete', rowIds: [...selected] })) setSelected(new Set());
                  }}
                >
                  <Trash2 size={12} /> {t('ps.ds.deleteRows', { count: selected.size })}
                </button>
              )}
            </div>
          )}
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[0.75rem]">
              <thead>
                <tr className="text-left text-[0.66rem] text-muted-foreground border-b border-border">
                  {can.edit && <th className="px-2 py-2 w-6" />}
                  {cols.map((c) => (
                    <th key={c.physical} className="px-2 py-2 whitespace-nowrap">
                      <button
                        type="button"
                        className="hover:text-foreground"
                        onClick={() => {
                          setOffset(0);
                          setSort(
                            sort?.col === c.physical
                              ? { col: c.physical, desc: !sort.desc }
                              : { col: c.physical, desc: false }
                          );
                        }}
                      >
                        {c.label}
                        {c.unit && ` (${c.unit})`}
                        {sort?.col === c.physical && (sort.desc ? ' ↓' : ' ↑')}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {adding && (
                  <tr className="border-b border-border bg-[var(--surface-3)]">
                    <td className="px-2 py-1">
                      <button
                        type="button"
                        aria-label={t('common.save')}
                        className="text-foreground"
                        onClick={async () => {
                          if (await rows({ op: 'add', values: adding })) setAdding(null);
                        }}
                      >
                        <Save size={12} />
                      </button>
                    </td>
                    {cols.map((c) => (
                      <td key={c.physical} className="px-1 py-1">
                        <input
                          className={inputCls}
                          value={adding[c.physical] ?? ''}
                          aria-label={c.label}
                          onChange={(e) => setAdding({ ...adding, [c.physical]: e.target.value })}
                        />
                      </td>
                    ))}
                  </tr>
                )}
                {page.rows.map((r) => {
                  const rowId = Number(r._id);
                  return (
                    <tr key={rowId} className="border-b border-border last:border-0">
                      {can.edit && (
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            aria-label={t('ps.ds.selectRow')}
                            checked={selected.has(rowId)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(rowId);
                              else next.delete(rowId);
                              setSelected(next);
                            }}
                          />
                        </td>
                      )}
                      {cols.map((c) => (
                        <td
                          key={c.physical}
                          className="px-2 py-1 whitespace-nowrap max-w-[18rem] truncate"
                          onDoubleClick={() =>
                            can.edit &&
                            !(c.sensitive && !page.unmasked) &&
                            setEditing({
                              row: rowId,
                              col: c.physical,
                              value: cellText(r[c.physical]),
                            })
                          }
                        >
                          {editing?.row === rowId && editing.col === c.physical ? (
                            <input
                              autoFocus
                              className={inputCls}
                              value={editing.value}
                              aria-label={c.label}
                              onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                              onKeyDown={async (e) => {
                                if (e.key === 'Escape') setEditing(null);
                                if (
                                  e.key === 'Enter' &&
                                  (await rows({
                                    op: 'update',
                                    rowId,
                                    values: { [c.physical]: editing.value },
                                  }))
                                )
                                  setEditing(null);
                              }}
                            />
                          ) : (
                            <CellValue column={c} value={r[c.physical]} />
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
                {!page.rows.length && (
                  <tr>
                    <td
                      colSpan={cols.length + 1}
                      className="px-3 py-6 text-center text-muted-foreground"
                    >
                      {ds.status === 'ready' ? t('ps.ds.noRows') : t('ps.ds.preparing')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground">
            <span>
              {page.total
                ? t('ps.ds.range', {
                    from: fmt.number(offset + 1),
                    to: fmt.number(Math.min(offset + PAGE, page.total)),
                    total: fmt.number(page.total),
                  })
                : ''}
              {can.edit && ` · ${t('ps.ds.editHint')}`}
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                className={buttonCls}
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
                aria-label={t('ps.ds.prev')}
              >
                <ChevronLeft size={12} />
              </button>
              <button
                type="button"
                className={buttonCls}
                disabled={offset + PAGE >= page.total}
                onClick={() => setOffset(offset + PAGE)}
                aria-label={t('ps.ds.next')}
              >
                <ChevronRight size={12} />
              </button>
            </div>
          </div>
        </div>
      )}

      {section === 'columns' && <ColumnsSection detail={detail} onSaved={load} />}
      {section === 'meaning' && (
        <DatasetEntity
          datasetId={detail.dataset.id}
          workspaceId={detail.dataset.workspaceId}
          columns={detail.dataset.columns.filter((c) => !c.hidden).map((c) => c.label)}
          editable={detail.can.schema}
        />
      )}
      {section === 'access' && <AccessSection detail={detail} onSaved={load} />}

      {section === 'history' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-[0.85rem] font-semibold text-foreground mb-2">
              {t('ps.ds.versions')}
            </h2>
            <ul className="space-y-1 text-[0.72rem]">
              {detail.versions.map((v) => (
                <li key={v.version} className="flex justify-between gap-2">
                  <span className="text-foreground">
                    {t('ps.ds.version', { version: v.version })}
                  </span>
                  <span className="text-muted-foreground truncate">
                    {Object.keys(v.change).join(', ')}
                  </span>
                  <span className="text-muted-foreground">{fmt.dateTime(v.created_at)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="rounded-xl border border-border bg-card p-4">
            <h2 className="text-[0.85rem] font-semibold text-foreground mb-2">
              {t('ps.ds.lineage')}
            </h2>
            {detail.lineage.length === 0 ? (
              <p className="text-[0.72rem] text-muted-foreground">{t('ps.ds.noLineage')}</p>
            ) : (
              <ul className="space-y-1 text-[0.72rem]">
                {detail.lineage.map((l, i) => (
                  <li key={i} className="text-foreground">
                    {l.to_id === ds.id
                      ? t('ps.ds.fedBy', {
                          kind: t(`ps.lin.${l.from_kind}` as any),
                          via: t(`ps.lin.${l.via_kind}` as any),
                        })
                      : t('ps.ds.feeds', {
                          kind: t(`ps.lin.${l.to_kind}` as any),
                          via: t(`ps.lin.${l.via_kind}` as any),
                        })}
                    <span className="ml-2 text-muted-foreground">{fmt.dateTime(l.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

const cellText = (v: unknown) =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function CellValue({ column, value }: { column: DatasetColumn; value: unknown }) {
  const { fmt } = useI18n();
  if (value === null || value === undefined)
    return <span className="text-muted-foreground">—</span>;
  if ((column.type === 'integer' || column.type === 'decimal') && typeof value !== 'object') {
    const n = Number(value);
    if (Number.isFinite(n)) return <span className="tabular-nums">{fmt.number(n)}</span>;
  }
  if (column.type === 'boolean') return <span>{value ? '✓' : '✗'}</span>;
  return <span>{cellText(value)}</span>;
}

function ColumnsSection({ detail, onSaved }: { detail: DatasetDetail; onSaved: () => void }) {
  const { t } = useI18n();
  const ds = detail.dataset;
  const [edits, setEdits] = useState<Record<string, Partial<DatasetColumn>>>({});
  const [added, setAdded] = useState<ColumnDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const editable = detail.can.schema && (ds.status === 'ready' || ds.status === 'failed');
  const set = (physical: string, patch: Partial<DatasetColumn>) =>
    setEdits({ ...edits, [physical]: { ...edits[physical], ...patch } });

  const save = async () => {
    setBusy(true);
    try {
      await terminalApi('dataset.alter', {
        id: ds.id,
        changes: {
          columns: Object.entries(edits).map(([physical, e]) => ({ physical, ...e })),
          add: added.filter((c) => c.label.trim()),
        },
      });
      setEdits({});
      setAdded([]);
      toast.success(t('ps.ds.saved'));
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[0.72rem] text-muted-foreground">{t('ps.ds.columnsIntro')}</p>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-[0.75rem]">
          <thead>
            <tr className="text-left text-[0.66rem] text-muted-foreground border-b border-border">
              <th className="px-3 py-2">{t('ps.ds.columnName')}</th>
              <th className="px-3 py-2">{t('ps.ds.columnType')}</th>
              <th className="px-3 py-2">{t('ps.ds.unit')}</th>
              <th className="px-3 py-2">{t('ps.ds.key')}</th>
              <th className="px-3 py-2">{t('ps.ds.sensitive')}</th>
              <th className="px-3 py-2">{t('ps.ds.hidden')}</th>
            </tr>
          </thead>
          <tbody>
            {ds.columns.map((c) => {
              const e = { ...c, ...edits[c.physical] };
              return (
                <tr key={c.physical} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5">
                    <input
                      className={inputCls}
                      disabled={!editable}
                      value={e.label}
                      aria-label={t('ps.ds.columnName')}
                      onChange={(x) => set(c.physical, { label: x.target.value })}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {t(`ps.type.${c.type}` as any)}
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      className={`${inputCls} w-20`}
                      disabled={!editable}
                      value={e.unit}
                      aria-label={t('ps.ds.unit')}
                      onChange={(x) => set(c.physical, { unit: x.target.value })}
                    />
                  </td>
                  <td className="px-3 py-1.5">{c.key ? '✓' : ''}</td>
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={e.sensitive}
                      aria-label={t('ps.ds.sensitive')}
                      onChange={(x) => set(c.physical, { sensitive: x.target.checked })}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={e.hidden}
                      aria-label={t('ps.ds.hidden')}
                      onChange={(x) => set(c.physical, { hidden: x.target.checked })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editable && (
        <>
          <ColumnsEditor columns={added} onChange={setAdded} />
          <button
            type="button"
            className={primaryCls}
            disabled={busy || (!Object.keys(edits).length && !added.some((c) => c.label.trim()))}
            onClick={save}
          >
            {busy && <Loader2 size={13} className="animate-spin" />} {t('ps.ds.saveColumns')}
          </button>
        </>
      )}
    </div>
  );
}

function AccessSection({ detail, onSaved }: { detail: DatasetDetail; onSaved: () => void }) {
  const { t } = useI18n();
  const ds = detail.dataset;
  const [restricted, setRestricted] = useState(ds.access === 'restricted');
  const [grants, setGrants] = useState(
    detail.grants.map((g) => ({
      kind: g.grantee_kind,
      grantee: g.grantee,
      permissions: g.permissions,
    }))
  );
  const [busy, setBusy] = useState(false);
  const editable = detail.can.share;

  const save = async () => {
    setBusy(true);
    try {
      await terminalApi('item.access', {
        kind: 'dataset',
        id: ds.id,
        access: restricted ? 'restricted' : 'workspace',
        grants: restricted ? grants : [],
      });
      toast.success(t('ps.ds.saved'));
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 max-w-2xl">
      <label className="flex items-center gap-2 text-[0.78rem] text-foreground">
        <input
          type="checkbox"
          disabled={!editable}
          checked={restricted}
          onChange={(e) => setRestricted(e.target.checked)}
        />
        {t('ps.ds.restricted')}
      </label>
      <p className="text-[0.72rem] text-muted-foreground">
        {restricted ? t('ps.acc.restrictedHint') : t('ps.acc.workspaceHint')}
      </p>
      {restricted && (
        <div className="space-y-2">
          {grants.map((g, i) => (
            <div key={i} className="rounded-lg border border-border p-2 space-y-1">
              <div className="flex gap-2 items-center">
                <select
                  className={`${inputCls} w-36`}
                  disabled={!editable}
                  value={g.kind}
                  aria-label={t('ps.acc.who')}
                  onChange={(e) =>
                    setGrants(
                      grants.map((x, n) =>
                        n === i ? { ...x, kind: e.target.value as any, grantee: '' } : x
                      )
                    )
                  }
                  style={{ colorScheme: 'light dark' }}
                >
                  <option value="role">{t('ps.acc.role')}</option>
                  <option value="member">{t('ps.acc.member')}</option>
                  <option value="custom_role">{t('ps.acc.customRole')}</option>
                </select>
                {g.kind === 'role' ? (
                  <select
                    className={inputCls}
                    disabled={!editable}
                    value={g.grantee}
                    aria-label={t('ps.acc.role')}
                    onChange={(e) =>
                      setGrants(
                        grants.map((x, n) => (n === i ? { ...x, grantee: e.target.value } : x))
                      )
                    }
                    style={{ colorScheme: 'light dark' }}
                  >
                    <option value="">—</option>
                    {WORKSPACE_ROLES.filter((r) => r !== 'owner').map((r) => (
                      <option key={r} value={r}>
                        {t(`role.${r}` as any)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={inputCls}
                    disabled={!editable}
                    value={g.grantee}
                    placeholder={t('ps.acc.idPlaceholder')}
                    aria-label={t('ps.acc.who')}
                    onChange={(e) =>
                      setGrants(
                        grants.map((x, n) =>
                          n === i ? { ...x, grantee: e.target.value.trim() } : x
                        )
                      )
                    }
                  />
                )}
                <button
                  type="button"
                  className="p-1 text-muted-foreground hover:text-red-500"
                  aria-label={t('ps.acc.remove')}
                  disabled={!editable}
                  onClick={() => setGrants(grants.filter((_, n) => n !== i))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="flex flex-wrap gap-3">
                {GRANTABLE.map((p) => (
                  <label
                    key={p}
                    className="flex items-center gap-1 text-[0.7rem] text-muted-foreground"
                  >
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={g.permissions.includes(p)}
                      onChange={(e) =>
                        setGrants(
                          grants.map((x, n) =>
                            n === i
                              ? {
                                  ...x,
                                  permissions: e.target.checked
                                    ? [...x.permissions, p]
                                    : x.permissions.filter((q) => q !== p),
                                }
                              : x
                          )
                        )
                      }
                    />
                    {t(`perm.${p}` as any)}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {editable && (
            <button
              type="button"
              className={buttonCls}
              onClick={() =>
                setGrants([
                  ...grants,
                  { kind: 'role', grantee: '', permissions: ['datasets.view', 'datasets.query'] },
                ])
              }
            >
              <Plus size={12} /> {t('ps.acc.add')}
            </button>
          )}
        </div>
      )}
      {editable && (
        <button type="button" className={primaryCls} disabled={busy} onClick={save}>
          {busy && <Loader2 size={13} className="animate-spin" />} {t('common.save')}
        </button>
      )}
    </div>
  );
}
