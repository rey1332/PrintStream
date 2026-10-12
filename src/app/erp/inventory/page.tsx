'use client';

import { UNIT_LABEL } from '@/lib/units';
import React, { useState, useEffect, useCallback } from 'react';
import { ArrowDown, ArrowUp, X, Check, Plus, Package, AlertTriangle, Search } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/contexts/AuthContext';
import { inventoryService, inventorySummary, type StockRow } from '../lib/erpService';
import { WarehousePanel } from '../components/WarehousePanel';
import { RecordPicker } from '../components/RecordPicker';
import { productOption, useRecordSearch } from '../lib/pickers';
import { useWorkspace } from '../lib/WorkspaceContext';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { translateServerMessage } from '@/lib/i18n/translate';
import { movementNoteLabel } from '@/lib/i18n/labels';
import { Pagination, useServerPage } from '../components/Pagination';

type Movement = Awaited<ReturnType<typeof inventoryService.movements>>['rows'][number];

const REORDER_PAGE_SIZE = 10;

export default function InventoryPage() {
  const { user } = useAuth();
  const { can } = useWorkspace();
  const { t, fmt } = useI18n();
  const [figures, setFigures] = useState<Awaited<ReturnType<typeof inventorySummary>> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ type: 'in' | 'out' } | null>(null);
  const [form, setForm] = useState({ productId: '', productName: '', quantity: 1, note: '' });
  const pickers = useRecordSearch();
  const userId = user?.id;

  const none = <T,>() => Promise.resolve({ rows: [] as T[], total: 0 });
  const stock = useServerPage<StockRow>(
    (q) => (userId ? inventoryService.page(userId, q) : none<StockRow>()),
    [userId],
    undefined,
    { focus: false }
  );
  const reorder = useServerPage<StockRow>(
    (q) => (userId ? inventoryService.page(userId, q, { reorderOnly: true }) : none<StockRow>()),
    [userId],
    REORDER_PAGE_SIZE,
    { focus: false }
  );
  // Links from ERP → Search point at a stock movement.
  const history = useServerPage<Movement>(
    (q) => (userId ? inventoryService.movements(userId, q) : none<Movement>()),
    [userId]
  );

  const loadFigures = useCallback(() => {
    inventorySummary()
      .then(setFigures)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (userId) loadFigures();
  }, [userId, loadFigures]);

  useEffect(() => {
    const failed = stock.error || reorder.error || history.error;
    if (failed) setError(failed instanceof Error ? failed.message : String(failed));
  }, [stock.error, reorder.error, history.error]);

  function reloadAll() {
    loadFigures();
    stock.reload();
    reorder.reload();
    history.reload();
  }

  async function handleSubmit() {
    if (!modal || !form.productId || form.quantity <= 0) return;
    setSubmitting(true);
    setError(null);

    const { error: adjustmentError } = await createClient().rpc('erp_adjust_stock', {
      p_product_id: form.productId,
      p_movement_type: modal.type,
      p_quantity: form.quantity,
      p_note: form.note,
    });

    if (adjustmentError) {
      setError(translateServerMessage(adjustmentError.message));
      setSubmitting(false);
      return;
    }

    setModal(null);
    setForm({ productId: '', productName: '', quantity: 1, note: '' });
    reloadAll();
    setSubmitting(false);
  }

  const inputCls =
    'w-full rounded-lg border px-3 py-2 text-[0.8rem] text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/40 transition-colors';
  const inputStyle = { background: 'var(--input)', borderColor: 'var(--border)' };
  const searchCls =
    'w-full rounded-lg border border-border bg-input pl-8 pr-3 py-1.5 text-[0.78rem] text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/40';

  const reorderCount = figures?.reorderCount ?? reorder.total;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('inv.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {!figures
              ? t('common.loading')
              : t('inv.totalValue', { value: fmt.money(figures.stockValue) })}
          </p>
        </div>
        {can('inventory') && (
          <div className="flex gap-2">
            <button
              onClick={() => setModal({ type: 'in' })}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-40"
            >
              <ArrowDown size={14} /> {t('inv.stockIn')}
            </button>
            <button
              onClick={() => setModal({ type: 'out' })}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium text-foreground border border-border bg-transparent disabled:opacity-40"
            >
              <ArrowUp size={14} /> {t('inv.stockOut')}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg px-4 py-3 text-[0.8rem] text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-950/20">
          {error}
        </div>
      )}

      {reorderCount > 0 && (
        <section className="rounded-xl border border-amber-300/60 dark:border-amber-800/60 bg-amber-50/60 dark:bg-amber-950/10 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-300/40 dark:border-amber-800/40">
            <AlertTriangle size={15} className="text-amber-600" />
            <h2 className="text-[0.85rem] font-semibold text-foreground">{t('inv.reorder')}</h2>
            <span className="text-[0.72rem] text-muted-foreground">
              {t('inv.reorderCount', { count: reorderCount })}
            </span>
          </div>
          <div className="divide-y divide-amber-300/30 dark:divide-amber-800/30">
            {reorder.items.map((product) => (
              <div
                key={product.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <div>
                  <p className="text-[0.8rem] font-medium text-foreground">{product.name}</p>
                  <p className="text-[0.72rem] text-muted-foreground">
                    {t('inv.reorderDetail', {
                      onHand: fmt.number(product.currentStock),
                      reserved: fmt.number(product.reserved),
                      available: fmt.number(Math.max(0, product.available)),
                      min: fmt.number(product.minStock),
                    })}
                  </p>
                </div>
                <p className="text-[0.75rem] font-medium text-amber-700 dark:text-amber-400">
                  {t('inv.suggested', { count: fmt.number(product.suggestedQty) })}
                </p>
              </div>
            ))}
          </div>
          <Pagination {...reorder.props} />
        </section>
      )}

      <div className="rounded-xl border border-border overflow-x-auto bg-card">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[0.85rem] font-semibold text-card-foreground">
            {t('inv.currentStock')}
          </h2>
          <div className="relative w-full max-w-xs">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={stock.search}
              onChange={(e) => stock.setSearch(e.target.value)}
              placeholder={t('common.search')}
              aria-label={`${t('common.search')}: ${t('inv.currentStock')}`}
              className={searchCls}
            />
          </div>
        </div>

        {stock.loading && stock.items.length === 0 ? (
          <div className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground">
            {t('inv.loadingProducts')}
          </div>
        ) : stock.items.length === 0 ? (
          <div className="px-4 py-10 flex flex-col items-center gap-3 text-center">
            <Package size={32} className="text-muted-foreground opacity-40" />
            <p className="text-[0.8rem] text-muted-foreground">
              {stock.search.trim() ? t('picker.noMatches') : t('inv.noProducts')}
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {[
                  t('inv.product'),
                  t('prod.sku'),
                  t('inv.onHand'),
                  t('inv.reserved'),
                  t('inv.available'),
                  t('inv.minStock'),
                  t('inv.maxStock'),
                  t('inv.value'),
                  t('common.status'),
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
              {stock.items.map((p, i) => {
                const pct = p.maxStock > 0 ? (p.currentStock / p.maxStock) * 100 : 0;
                const status =
                  p.currentStock <= p.minStock
                    ? t('status.low')
                    : p.currentStock >= p.maxStock * 0.9
                      ? t('status.full')
                      : t('status.normal');
                return (
                  <tr
                    key={p.id}
                    className={`border-b border-border ${i === stock.items.length - 1 ? 'border-b-0' : ''}`}
                  >
                    <td className="px-4 py-3 text-[0.8rem] font-medium text-foreground">
                      {p.name}
                    </td>
                    <td className="px-4 py-3 text-[0.72rem] text-muted-foreground font-mono">
                      {p.sku}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[0.8rem] font-semibold text-foreground">
                          {fmt.number(p.currentStock)} {t(UNIT_LABEL[p.unit])}
                        </span>
                        <div className="flex-1 h-1.5 rounded-full max-w-[60px] bg-muted">
                          <div
                            className="h-full rounded-full bg-foreground/50"
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">
                      {fmt.number(p.reserved)}
                    </td>
                    <td
                      className={`px-4 py-3 text-[0.78rem] font-medium ${p.available < 0 ? 'text-red-600 dark:text-red-400' : 'text-foreground'}`}
                    >
                      {fmt.number(p.available)}
                    </td>
                    <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">
                      {fmt.number(p.minStock)}
                    </td>
                    <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">
                      {fmt.number(p.maxStock)}
                    </td>
                    <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">
                      {fmt.money(p.stockValue)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 rounded text-[0.68rem] font-medium bg-muted text-muted-foreground">
                        {status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination {...stock.props} />
      </div>

      <div className="rounded-xl border border-border overflow-hidden bg-card">
        <div className="px-4 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[0.85rem] font-semibold text-card-foreground">{t('inv.history')}</h2>
          <div className="relative w-full max-w-xs">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              value={history.search}
              onChange={(e) => history.setSearch(e.target.value)}
              placeholder={t('common.search')}
              aria-label={`${t('common.search')}: ${t('inv.history')}`}
              className={searchCls}
            />
          </div>
        </div>

        {history.focusId && (
          <div className="flex items-center justify-between gap-3 border-b border-border bg-[var(--surface-2)] px-4 py-2 text-[0.78rem] text-muted-foreground">
            <span>{t('common.focusOnly')}</span>
            <button
              type="button"
              onClick={history.showAll}
              className="font-medium text-foreground underline"
            >
              {t('common.showAll')}
            </button>
          </div>
        )}

        {history.loading && history.items.length === 0 ? (
          <div className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground">
            {t('inv.loadingHistory')}
          </div>
        ) : history.items.length === 0 ? (
          <div className="px-4 py-10 flex flex-col items-center gap-3 text-center">
            <Plus size={28} className="text-muted-foreground opacity-40" />
            <p className="text-[0.8rem] text-muted-foreground">
              {history.search.trim() ? t('picker.noMatches') : t('inv.noMovements')}
            </p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                {[
                  t('common.date'),
                  t('inv.product'),
                  t('common.type'),
                  t('common.quantity'),
                  t('common.reference'),
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
              {history.items.map((m, i) => (
                <tr
                  key={m.id}
                  {...history.focusAttrs(m.id)}
                  className={`border-b border-border ${i === history.items.length - 1 ? 'border-b-0' : ''}`}
                >
                  <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                    {fmt.date(m.date)}
                  </td>
                  <td className="px-4 py-3 text-[0.8rem] text-foreground">{m.productName}</td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                      {m.type === 'in' ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
                      {m.type === 'in' ? t('inv.stockIn') : t('inv.stockOut')}
                    </span>
                  </td>
                  <td
                    className={`px-4 py-3 text-[0.8rem] font-semibold ${m.type === 'in' ? 'text-foreground' : 'text-muted-foreground'}`}
                  >
                    {m.type === 'in' ? '+' : '−'}
                    {fmt.number(m.quantity)}
                  </td>
                  <td className="px-4 py-3 text-[0.75rem] text-muted-foreground">
                    {movementNoteLabel(m.note, t)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination {...history.props} />
      </div>

      <WarehousePanel products={stock.items} onChanged={reloadAll} />

      {modal && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[1rem] font-semibold text-foreground">
                {modal.type === 'in' ? t('inv.stockIn') : t('inv.stockOut')}
              </h2>
              <button
                onClick={() => setModal(null)}
                aria-label={t('common.close')}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1">
                  {t('inv.product')}
                </label>
                <RecordPicker
                  className={inputCls}
                  style={inputStyle}
                  ariaLabel={t('inv.product')}
                  placeholder={t('inv.selectProduct')}
                  value={form.productId}
                  valueLabel={form.productName}
                  required
                  search={(text) =>
                    pickers
                      .products(text)
                      .then((rows) =>
                        rows.map((p) =>
                          productOption(
                            p,
                            t('so.onHandCount', { count: fmt.number(p.currentStock) })
                          )
                        )
                      )
                  }
                  onChange={(p) =>
                    setForm((f) => ({ ...f, productId: p?.id ?? '', productName: p?.label ?? '' }))
                  }
                />
              </div>
              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1">
                  {t('common.quantity')}
                </label>
                <input
                  type="number"
                  min={0.001}
                  step="any"
                  inputMode="decimal"
                  className={inputCls}
                  style={inputStyle}
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-[0.7rem] text-muted-foreground mb-1">
                  {t('inv.referenceNote')}
                </label>
                <input
                  className={inputCls}
                  style={inputStyle}
                  value={form.note}
                  onChange={(e) => setForm({ ...form, note: e.target.value })}
                  placeholder={t('inv.referencePlaceholder')}
                />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setModal(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border bg-transparent"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !form.productId || form.quantity <= 0}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {submitting ? (
                  t('common.saving')
                ) : (
                  <>
                    <Check size={13} /> {t('common.confirm')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
