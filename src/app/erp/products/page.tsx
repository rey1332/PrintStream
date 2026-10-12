'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '../lib/WorkspaceContext';
import { INDUSTRY_DEFAULT_UNIT } from '@/lib/industry';
import { productService } from '../lib/erpService';
import { createClient } from '@/lib/data/client';
import { rpcWorkspaceId } from '../lib/workspace';
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  AlertTriangle,
  Upload,
  Download,
  AlertCircle,
  Search,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { tr } from '@/lib/i18n/translate';
import type { MessageKey } from '@/lib/i18n/messages';
import { Pagination, useServerPage } from '../components/Pagination';
import { UNIT_CODES, UNIT_LABEL, isUnit, roundQty, type UnitCode } from '@/lib/units';

interface Product {
  id?: string;
  name: string;
  sku: string;
  category: string;
  purchasePrice: number;
  sellingPrice: number;
  currentStock: number;
  minStock: number;
  maxStock: number;
  unit: UnitCode;
  /** Ton per m³, for converting between weight and volume. */
  density: number | null;
}

const emptyProduct = (): Omit<Product, 'id'> => ({
  name: '',
  sku: '',
  category: '',
  purchasePrice: 0,
  sellingPrice: 0,
  currentStock: 0,
  minStock: 0,
  maxStock: 100,
  unit: 'm3',
  density: null,
});

// "12,5" and "12.5" both read as 12.5; quantities keep three decimals.
const csvNumber = (value: string | undefined, fallback: number) => {
  const n = Number((value ?? '').replace(',', '.'));
  return value && Number.isFinite(n) ? n : fallback;
};

interface ImportRow {
  row: number;
  data: Partial<Product>;
  errors: MessageKey[];
  valid: boolean;
}

function parseProductCSV(text: string): ImportRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((line, idx) => {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      raw[h] = cols[i] || '';
    });
    const data: Partial<Product> = {
      name: raw['name'] || raw['product_name'] || '',
      sku: raw['sku'] || '',
      category: raw['category'] || '',
      purchasePrice: parseFloat(raw['purchase_price'] || raw['purchaseprice'] || '0') || 0,
      sellingPrice: parseFloat(raw['selling_price'] || raw['sellingprice'] || '0') || 0,
      currentStock: roundQty(
        csvNumber(raw['current_stock'] || raw['currentstock'] || raw['stock'], 0)
      ),
      minStock: roundQty(csvNumber(raw['min_stock'] || raw['minstock'], 0)),
      maxStock: roundQty(csvNumber(raw['max_stock'] || raw['maxstock'], 100)),
      unit: isUnit(raw['unit']) ? raw['unit'] : 'pcs',
      density: csvNumber(raw['density'], 0) > 0 ? csvNumber(raw['density'], 0) : null,
    };
    const errors: MessageKey[] = [];
    if (!data.name) errors.push('party.nameRequired');
    if (raw['unit'] && !isUnit(raw['unit'])) errors.push('prod.badUnit');
    if (
      data.sellingPrice !== undefined &&
      data.purchasePrice !== undefined &&
      data.sellingPrice < data.purchasePrice
    )
      errors.push('prod.sellBelowBuy');
    return { row: idx + 2, data, errors, valid: errors.length === 0 };
  });
}

export default function ProductsPage() {
  const { user } = useAuth();
  const { can, active } = useWorkspace();
  const canEdit = can('products');
  const { t, fmt } = useI18n();
  // One page at a time, searched by the database.
  const list = useServerPage<Product>(
    (q) => (user ? productService.page(user.id, q) : Promise.resolve({ rows: [], total: 0 })),
    [user?.id]
  );
  const loading = list.loading;
  // Stock value of every product (at average cost), from the database.
  const [stockValue, setStockValue] = useState<number | null>(null);
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; data: Partial<Product> } | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [importModal, setImportModal] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState<{ success: number; failed: number } | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user || list.loading) return;
    createClient()
      .rpc('erp_dashboard_metrics', { p_workspace_id: rpcWorkspaceId() })
      .then(({ data, error: metricsError }) =>
        setStockValue(metricsError || !data ? null : Number(data.inventoryValue ?? 0))
      );
  }, [user, list.loading]);
  const loadError = list.error
    ? (list.error instanceof Error && list.error.message) || tr('prod.loadFailed')
    : '';

  async function handleSave() {
    if (!modal || !user) return;
    if (!modal.data.name) {
      setError(t('party.nameRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await productService.upsert(user.id, modal.data);
      list.reload();
      setModal(null);
    } catch (err: any) {
      setError(err?.message || t('prod.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAll() {
    if (!user || list.total === 0) return;
    const confirmed = window.confirm(t('prod.deleteAllConfirm', { count: list.total }));
    if (!confirmed) return;
    setDeletingAll(true);
    try {
      // Every product, not only the page shown.
      for (const id of await productService.allIds(user.id)) {
        await productService.remove(user.id, id);
      }
      list.reload();
    } catch (err) {
      console.error(err);
      alert(t('prod.deleteAllFailed'));
    } finally {
      setDeletingAll(false);
    }
  }

  async function handleDelete(id: string | null) {
    if (!id || !user) return;
    try {
      await productService.remove(user.id, id);
      list.reload();
      setDeleteId(null);
    } catch (err: any) {
      setError(err?.message || t('prod.deleteFailed'));
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setImportRows(parseProductCSV(text));
      setImportDone(null);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function handleImport() {
    if (!user) return;
    const valid = importRows.filter((r) => r.valid);
    if (!valid.length) return;
    setImporting(true);
    let success = 0;
    let failed = 0;
    for (const row of valid) {
      try {
        await productService.upsert(user.id, row.data);
        success++;
      } catch {
        failed++;
      }
    }
    list.reload();
    setImportDone({ success, failed });
    setImporting(false);
  }

  function downloadTemplate() {
    const csv =
      'name,sku,category,purchase_price,selling_price,current_stock,min_stock,max_stock,unit,density\nSplit 2/3,SPL-23,Aggregate,180000,250000,1250.5,200,5000,m3,1.45';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'products_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputCls =
    'w-full rounded-lg border px-3 py-2 text-[0.8rem] text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/40 transition-colors';
  const inputStyle = { background: 'var(--input)', borderColor: 'var(--border)' };
  const numFields: (keyof Product)[] = [
    'purchasePrice',
    'sellingPrice',
    'currentStock',
    'minStock',
    'maxStock',
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between max-lg:flex-wrap max-lg:gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('prod.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {loading
              ? t('common.loading')
              : stockValue === null
                ? t('prod.count', { count: list.total })
                : t('prod.summary', { count: list.total, value: fmt.money(stockValue) })}
          </p>
        </div>
        <div className={`flex items-center gap-2 max-lg:flex-wrap ${canEdit ? '' : 'hidden'}`}>
          <button
            onClick={handleDeleteAll}
            disabled={list.total === 0 || deletingAll || !!list.search}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium text-muted-foreground border border-border hover:text-foreground transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={14} /> {deletingAll ? t('common.deleting') : t('common.deleteAll')}
          </button>
          <button
            onClick={() => {
              setImportModal(true);
              setImportRows([]);
              setImportDone(null);
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium text-muted-foreground border border-border hover:text-foreground transition-all"
          >
            <Upload size={14} /> {t('common.importCsv')}
          </button>
          <button
            onClick={() => {
              setModal({
                mode: 'add',
                data: {
                  ...emptyProduct(),
                  unit: INDUSTRY_DEFAULT_UNIT[active?.industry ?? 'general'],
                },
              });
              setError('');
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground transition-all"
          >
            <Plus size={14} /> {t('prod.add')}
          </button>
        </div>
      </div>

      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          className="w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input pl-9 pr-3 py-2 text-[0.8rem] text-zinc-900 dark:text-foreground placeholder:text-zinc-400 dark:placeholder:text-muted-foreground outline-none focus:border-zinc-400 dark:focus:border-foreground/40"
          placeholder={t('prod.search')}
          value={list.search}
          onChange={(e) => list.setSearch(e.target.value)}
        />
      </div>

      {list.focusId && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-[var(--surface-2)] px-4 py-2 text-[0.78rem] text-muted-foreground">
          <span>{t('common.focusOnly')}</span>
          <button
            type="button"
            onClick={list.showAll}
            className="font-medium text-foreground underline"
          >
            {t('common.showAll')}
          </button>
        </div>
      )}
      {loadError && (
        <p role="alert" className="text-[0.8rem] text-red-600 dark:text-red-400">
          {loadError}
        </p>
      )}

      <div className="rounded-xl border border-border overflow-x-auto bg-card">
        <table className="w-full min-w-[800px]">
          <thead>
            <tr className="border-b border-border">
              {[
                t('prod.sku'),
                t('common.name'),
                t('common.category'),
                t('prod.buyPrice'),
                t('prod.sellPrice'),
                t('prod.stock'),
                t('prod.minMax'),
                t('prod.margin'),
                t('common.actions'),
              ].map((h) => (
                <th
                  key={h}
                  className="text-left px-4 py-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('prod.loading')}
                </td>
              </tr>
            ) : (
              list.items.map((p, i) => {
                const margin =
                  p.sellingPrice > 0
                    ? ((p.sellingPrice - p.purchasePrice) / p.sellingPrice) * 100
                    : 0;
                const lowStock = p.currentStock <= p.minStock;
                return (
                  <tr
                    key={p.id}
                    {...list.focusAttrs(p.id)}
                    className={`border-b border-border ${i === list.items.length - 1 ? 'border-b-0' : ''}`}
                  >
                    <td className="px-4 py-3 text-[0.72rem] text-muted-foreground font-mono">
                      {p.sku}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {lowStock && (
                          <AlertTriangle
                            size={11}
                            className="text-muted-foreground flex-shrink-0"
                          />
                        )}
                        <span className="text-[0.8rem] font-medium text-foreground">{p.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded text-[0.68rem] text-muted-foreground bg-muted">
                        {p.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">
                      {fmt.money(p.purchasePrice)}
                    </td>
                    <td className="px-4 py-3 text-[0.78rem] text-foreground font-medium">
                      {fmt.money(p.sellingPrice)}
                    </td>
                    <td
                      className={`px-4 py-3 text-[0.78rem] font-semibold ${lowStock ? 'text-muted-foreground' : 'text-foreground'}`}
                    >
                      {fmt.number(p.currentStock)} {t(UNIT_LABEL[p.unit])}
                    </td>
                    <td className="px-4 py-3 text-[0.72rem] text-muted-foreground">
                      {fmt.number(p.minStock)} / {fmt.number(p.maxStock)}
                    </td>
                    <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">
                      {fmt.number(margin, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {canEdit && (
                          <button
                            onClick={() => {
                              setModal({ mode: 'edit', data: { ...p } });
                              setError('');
                            }}
                            className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
                            title={t('common.edit')}
                            aria-label={t('common.edit')}
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => setDeleteId(p.id!)}
                            className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
            {!loading && list.items.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('prod.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination {...list.props} />
      </div>

      {importModal && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card flex flex-col max-h-[85vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div>
                <h2 className="text-[1rem] font-semibold text-foreground">
                  {t('prod.importTitle')}
                </h2>
                <p className="text-[0.72rem] text-muted-foreground mt-0.5">{t('prod.columns')}</p>
              </div>
              <button
                onClick={() => setImportModal(false)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground"
                >
                  <Upload size={14} /> {t('common.chooseCsv')}
                </button>
                <button
                  onClick={downloadTemplate}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.78rem] text-muted-foreground border border-border hover:text-foreground transition-colors"
                >
                  <Download size={13} /> {t('party.downloadTemplate')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
              {importRows.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[0.78rem] text-muted-foreground">
                    {t('party.validErrors', {
                      valid: importRows.filter((r) => r.valid).length,
                      invalid: importRows.filter((r) => !r.valid).length,
                    })}
                  </p>
                  <div className="rounded-lg border border-border overflow-hidden">
                    <div className="overflow-x-auto max-h-64 overflow-y-auto">
                      <table className="w-full text-[0.75rem]">
                        <thead className="sticky top-0 bg-muted">
                          <tr>
                            {[
                              t('party.row'),
                              t('common.name'),
                              t('prod.sku'),
                              t('common.category'),
                              t('prod.buy'),
                              t('prod.sell'),
                              t('prod.stock'),
                              t('common.status'),
                            ].map((h) => (
                              <th
                                key={h}
                                className="text-left px-3 py-2 text-muted-foreground font-medium"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {importRows.map((row) => (
                            <tr key={row.row} className="border-t border-border">
                              <td className="px-3 py-2 text-muted-foreground">{row.row}</td>
                              <td className="px-3 py-2 text-foreground">{row.data.name || '—'}</td>
                              <td className="px-3 py-2 text-muted-foreground font-mono">
                                {row.data.sku || '—'}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {row.data.category || '—'}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {fmt.money(row.data.purchasePrice ?? 0)}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {fmt.money(row.data.sellingPrice ?? 0)}
                              </td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {row.data.currentStock ?? 0}
                              </td>
                              <td className="px-3 py-2">
                                {row.valid ? (
                                  <span className="text-muted-foreground text-[0.68rem]">
                                    {t('party.valid')}
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1 text-muted-foreground text-[0.68rem]">
                                    <AlertCircle size={10} /> {t(row.errors[0])}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
              {importDone && (
                <div className="rounded-lg px-4 py-3 text-[0.8rem] bg-muted border border-border">
                  <p className="text-foreground">
                    {t('party.importComplete')}{' '}
                    <span className="font-semibold">
                      {t('party.inserted', { count: importDone.success })}
                    </span>
                    {importDone.failed > 0 && (
                      <span className="text-muted-foreground">
                        {t('party.failedCount', { count: importDone.failed })}
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-border flex gap-2 flex-shrink-0">
              <button
                onClick={() => setImportModal(false)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border transition-colors"
              >
                {importDone ? t('common.close') : t('common.cancel')}
              </button>
              {!importDone && (
                <button
                  onClick={handleImport}
                  disabled={importing || importRows.filter((r) => r.valid).length === 0}
                  className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-40"
                >
                  {importing
                    ? t('common.importing')
                    : t('common.importRecords', {
                        count: importRows.filter((r) => r.valid).length,
                      })}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[1rem] font-semibold text-foreground">
                {modal.mode === 'add' ? t('prod.add') : t('prod.edit')}
              </h2>
              <button
                onClick={() => setModal(null)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(['name', 'sku', 'category'] as const).map((field) => (
                <div key={field} className={field === 'name' ? 'col-span-2' : ''}>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1">
                    {t(`prod.field.${field}`)}
                  </label>
                  <input
                    className={inputCls}
                    style={inputStyle}
                    value={(modal.data as any)[field] || ''}
                    onChange={(e) =>
                      setModal({ ...modal, data: { ...modal.data, [field]: e.target.value } })
                    }
                  />
                </div>
              ))}
              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1">
                  {t('unit.label')}
                </label>
                <select
                  className={inputCls}
                  style={inputStyle}
                  value={modal.data.unit ?? 'pcs'}
                  onChange={(e) =>
                    setModal({
                      ...modal,
                      data: { ...modal.data, unit: e.target.value as UnitCode },
                    })
                  }
                >
                  {UNIT_CODES.map((u) => (
                    <option key={u} value={u}>
                      {t(UNIT_LABEL[u])}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1">
                  {t('unit.density')}
                </label>
                <input
                  type="number"
                  step="any"
                  min="0"
                  inputMode="decimal"
                  className={inputCls}
                  style={inputStyle}
                  value={modal.data.density ?? ''}
                  onChange={(e) =>
                    setModal({
                      ...modal,
                      data: {
                        ...modal.data,
                        density: e.target.value === '' ? null : Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
              <p className="col-span-2 -mt-1 text-[0.68rem] text-muted-foreground">
                {t('unit.densityHelp')}
              </p>
              {numFields.map((field) => (
                <div key={String(field)}>
                  <label className="block text-[0.7rem] text-muted-foreground mb-1">
                    {t(`prod.field.${field}` as MessageKey)}
                  </label>
                  <input
                    type="number"
                    step="any"
                    inputMode="decimal"
                    className={inputCls}
                    style={inputStyle}
                    value={(modal.data as any)[field] || 0}
                    onChange={(e) =>
                      setModal({
                        ...modal,
                        data: { ...modal.data, [field]: Number(e.target.value) },
                      })
                    }
                  />
                </div>
              ))}
            </div>
            {error && (
              <p className="text-[0.78rem] text-muted-foreground bg-muted rounded-lg px-3 py-2 border border-border">
                {error}
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setModal(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {saving ? (
                  t('common.saving')
                ) : (
                  <>
                    <Check size={13} /> {t('common.save')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-[1rem] font-semibold text-foreground">{t('prod.deleteTitle')}</h2>
            <p className="text-[0.8rem] text-muted-foreground">{t('party.cannotUndo')}</p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteId(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-red-600 text-white"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
