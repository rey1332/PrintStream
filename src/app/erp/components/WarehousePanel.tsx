'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Plus, Warehouse } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { translateServerMessage } from '@/lib/i18n/translate';
import { useWorkspace } from '../lib/WorkspaceContext';
import { rpcWorkspaceId } from '../lib/workspace';
import { productOption, useRecordSearch } from '../lib/pickers';
import { RecordPicker } from './RecordPicker';

interface Product {
  id: string;
  name: string;
  currentStock: number;
}
interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  is_default: boolean;
}

const inputCls =
  'rounded-lg border border-border bg-input px-2.5 py-1.5 text-[0.78rem] text-foreground outline-none focus:border-foreground/40';

export function WarehousePanel({
  products,
  onChanged,
}: {
  products: Product[];
  onChanged: () => void;
}) {
  const { t, fmt } = useI18n();
  const { can } = useWorkspace();
  const canEdit = can('inventory');
  const [warehouses, setWarehouses] = useState<WarehouseRow[] | null>(null);
  const [stock, setStock] = useState<Record<string, Record<string, number>>>({});
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [transfer, setTransfer] = useState({
    productId: '',
    productName: '',
    from: '',
    to: '',
    qty: 1,
    note: '',
  });
  const pickers = useRecordSearch();
  const [busy, setBusy] = useState(false);
  const transferProductId = transfer.productId;

  const load = useCallback(async () => {
    const db = createClient();
    try {
      const scope = rpcWorkspaceId();
      const { data: auth } = await db.auth.getUser();
      let query = db
        .from('erp_warehouses')
        .select('id, code, name, is_default')
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .order('code');
      query = scope ? query.eq('workspace_id', scope) : query.eq('user_id', auth.user?.id ?? '');
      const { data, error: whError } = await query;
      if (whError) throw whError;
      const rows = (data ?? []) as WarehouseRow[];
      setWarehouses(rows);
      const ids = rows.map((w) => w.id);
      // Only the products shown and the one picked for a transfer.
      const productIds = [...new Set([...products.map((p) => p.id), transferProductId])].filter(
        Boolean
      );
      const { data: cells, error: stockError } =
        ids.length && productIds.length
          ? await db
              .from('erp_warehouse_stock')
              .select('warehouse_id, product_id, quantity')
              .in('warehouse_id', ids)
              .in('product_id', productIds)
          : { data: [], error: null };
      if (stockError) throw stockError;
      const map: Record<string, Record<string, number>> = {};
      for (const c of (cells ?? []) as {
        warehouse_id: string;
        product_id: string;
        quantity: number;
      }[])
        (map[c.product_id] ??= {})[c.warehouse_id] = c.quantity;
      setStock(map);
      setError('');
    } catch (e: any) {
      // Database without warehouses yet: the panel stays hidden.
      if (e?.code === '42P01' || e?.code === 'PGRST205') setWarehouses([]);
      else setError(e?.message ? translateServerMessage(e.message) : t('erp.error.generic'));
    }
  }, [t, products, transferProductId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stocked = useMemo(() => products.filter((p) => p.currentStock > 0), [products]);

  if (!warehouses || warehouses.length === 0) return null;

  const addWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error: rpcError } = await createClient().rpc('erp_create_warehouse', {
      p_workspace_id: rpcWorkspaceId(),
      p_code: code.trim(),
      p_name: name.trim(),
    });
    setBusy(false);
    if (rpcError) {
      toast.error(translateServerMessage(rpcError.message));
      return;
    }
    toast.success(t('wh.created'));
    setCode('');
    setName('');
    await load();
  };

  const doTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const { error: rpcError } = await createClient().rpc('erp_transfer_stock', {
      p_product_id: transfer.productId,
      p_from_warehouse: transfer.from,
      p_to_warehouse: transfer.to,
      p_quantity: transfer.qty,
      p_note: transfer.note,
    });
    setBusy(false);
    if (rpcError) {
      toast.error(translateServerMessage(rpcError.message));
      return;
    }
    toast.success(t('wh.transferred'));
    setTransfer((s) => ({ ...s, qty: 1, note: '' }));
    await load();
    onChanged();
  };

  const available =
    transfer.productId && transfer.from ? (stock[transfer.productId]?.[transfer.from] ?? 0) : 0;

  return (
    <section
      className="rounded-xl border border-border bg-card overflow-hidden"
      aria-labelledby="wh-title"
    >
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Warehouse size={14} className="text-muted-foreground" />
        <h2 id="wh-title" className="text-[0.85rem] font-semibold text-foreground">
          {t('wh.title')}
        </h2>
      </div>
      {error && <p className="px-4 pt-3 text-[0.78rem] text-red-600 dark:text-red-400">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="border-b border-border">
            <tr>
              <th className="px-4 py-2 text-left text-[0.7rem] font-medium text-muted-foreground">
                {t('inv.product')}
              </th>
              {warehouses.map((w) => (
                <th
                  key={w.id}
                  className="px-4 py-2 text-right text-[0.7rem] font-medium text-muted-foreground whitespace-nowrap"
                >
                  {w.code}
                  {w.is_default ? ` · ${t('wh.default')}` : ''}
                </th>
              ))}
              <th className="px-4 py-2 text-right text-[0.7rem] font-medium text-muted-foreground">
                {t('inv.onHand')}
              </th>
            </tr>
          </thead>
          <tbody>
            {stocked.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-b-0">
                <td className="px-4 py-2 text-[0.78rem] text-foreground">{p.name}</td>
                {warehouses.map((w) => (
                  <td key={w.id} className="px-4 py-2 text-right text-[0.78rem] tabular-nums">
                    {fmt.number(stock[p.id]?.[w.id] ?? 0)}
                  </td>
                ))}
                <td className="px-4 py-2 text-right text-[0.78rem] font-semibold tabular-nums">
                  {fmt.number(p.currentStock)}
                </td>
              </tr>
            ))}
            {stocked.length === 0 && (
              <tr>
                <td
                  colSpan={warehouses.length + 2}
                  className="px-4 py-4 text-center text-[0.78rem] text-muted-foreground"
                >
                  {t('wh.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-2 text-[0.7rem] text-muted-foreground">{t('wh.pageHint')}</p>

      {canEdit && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 border-t border-border">
          <form onSubmit={doTransfer} className="space-y-2">
            <p className="text-[0.75rem] font-semibold text-foreground flex items-center gap-1.5">
              <ArrowRightLeft size={12} /> {t('wh.transfer')}
            </p>
            <RecordPicker
              required
              ariaLabel={t('inv.product')}
              placeholder={t('inv.selectProduct')}
              className={`${inputCls} w-full`}
              value={transfer.productId}
              valueLabel={transfer.productName}
              search={(text) =>
                pickers
                  .products(text, { inStock: true })
                  .then((rows) =>
                    rows.map((p) =>
                      productOption(p, t('so.onHandCount', { count: fmt.number(p.currentStock) }))
                    )
                  )
              }
              onChange={(p) =>
                setTransfer((s) => ({ ...s, productId: p?.id ?? '', productName: p?.label ?? '' }))
              }
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                required
                aria-label={t('wh.from')}
                className={inputCls}
                value={transfer.from}
                onChange={(e) => setTransfer((s) => ({ ...s, from: e.target.value }))}
              >
                <option value="">{t('wh.from')}</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} · {w.name}
                  </option>
                ))}
              </select>
              <select
                required
                aria-label={t('wh.to')}
                className={inputCls}
                value={transfer.to}
                onChange={(e) => setTransfer((s) => ({ ...s, to: e.target.value }))}
              >
                <option value="">{t('wh.to')}</option>
                {warehouses
                  .filter((w) => w.id !== transfer.from)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.code} · {w.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input
                required
                type="number"
                min={0.001}
                step="any"
                inputMode="decimal"
                max={available || undefined}
                aria-label={t('common.quantity')}
                className={inputCls}
                value={transfer.qty}
                onChange={(e) => setTransfer((s) => ({ ...s, qty: Number(e.target.value) }))}
              />
              <input
                aria-label={t('wh.note')}
                placeholder={t('wh.note')}
                maxLength={500}
                className={`${inputCls} col-span-2`}
                value={transfer.note}
                onChange={(e) => setTransfer((s) => ({ ...s, note: e.target.value }))}
              />
            </div>
            {transfer.productId && transfer.from && (
              <p className="text-[0.7rem] text-muted-foreground">
                {t('wh.available', { count: fmt.number(available) })}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !transfer.productId || !transfer.from || !transfer.to}
              className="px-3 py-1.5 rounded-lg text-[0.78rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
            >
              {t('wh.transferSubmit')}
            </button>
          </form>
          <form onSubmit={addWarehouse} className="space-y-2">
            <p className="text-[0.75rem] font-semibold text-foreground flex items-center gap-1.5">
              <Plus size={12} /> {t('wh.add')}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <input
                required
                maxLength={20}
                pattern="[0-9A-Za-z._\-]{1,20}"
                aria-label={t('wh.code')}
                placeholder={t('wh.code')}
                className={inputCls}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <input
                required
                maxLength={120}
                aria-label={t('wh.name')}
                placeholder={t('wh.name')}
                className={`${inputCls} col-span-2`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-[0.78rem] border border-border text-foreground hover:bg-[var(--surface-3)] disabled:opacity-50"
            >
              {t('wh.addSubmit')}
            </button>
            <p className="text-[0.68rem] text-muted-foreground">{t('wh.hint')}</p>
          </form>
        </div>
      )}
    </section>
  );
}
