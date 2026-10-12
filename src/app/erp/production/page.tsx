'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Factory, Plus, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { UNIT_LABEL, isUnit } from '@/lib/units';
import { useWorkspace } from '../lib/WorkspaceContext';
import { rpcWorkspaceId } from '../lib/workspace';
import {
  productionService,
  type ProductionRun,
  type ProductionSummary,
  type Stockpile,
} from '../lib/productionService';
import { errorKey, inputCls, todayIso } from '../components/moduleUi';
import { RecordDialog, toProductOption, type ProductOption } from './RecordDialog';

const EMPTY: ProductionSummary = {
  runs: 0,
  hours: 0,
  downtimeHours: 0,
  outputs: [],
  inputs: [],
  days: [],
};

export default function ProductionPage() {
  const { t, fmt } = useI18n();
  const { active, can, role } = useWorkspace();
  const [from, setFrom] = useState(() => todayIso().slice(0, 8) + '01');
  const [to, setTo] = useState(() => todayIso());
  const [summary, setSummary] = useState<ProductionSummary>(EMPTY);
  const [runs, setRuns] = useState<ProductionRun[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [stockpiles, setStockpiles] = useState<Stockpile[]>([]);
  const [loading, setLoading] = useState(true);
  const [recording, setRecording] = useState(false);
  const canRecord = can('inventory');
  const canReverse = role === 'owner' || role === 'admin';

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      productionService.summary(from, to),
      productionService.runs(from, to),
    ]);
    setSummary(s);
    setRuns(r);
  }, [from, to]);

  useEffect(() => {
    setLoading(true);
    load()
      .catch((err) => toast.error(t(errorKey(err, 'prd.err.failed'))))
      .finally(() => setLoading(false));
  }, [active?.id, load, t]);

  useEffect(() => {
    if (!canRecord) return;
    Promise.all([
      createClient()
        .from('erp_products')
        .select('id, name, unit, density, current_stock')
        .eq('workspace_id', rpcWorkspaceId())
        .order('name', { ascending: true })
        .limit(2000),
      productionService.stockpiles(),
    ])
      .then(([p, s]) => {
        setProducts((p.data ?? []).map(toProductOption));
        setStockpiles(s);
      })
      .catch(() => undefined);
  }, [active?.id, canRecord, recording]);

  const unitText = (unit: string | null) =>
    unit && isUnit(unit) ? t(UNIT_LABEL[unit]) : (unit ?? '');
  const qtyText = (qty: number, unit: string | null) => `${fmt.number(qty)} ${unitText(unit)}`;

  async function reverse(run: ProductionRun) {
    const reason = window.prompt(t('prd.reversePrompt', { run: run.docNo }));
    if (reason === null) return;
    try {
      await productionService.reverse(run.id, reason);
      toast.success(t('prd.reversedToast'));
      await load();
    } catch (err) {
      toast.error(t(errorKey(err, 'prd.err.failed')));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.production')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('prd.subtitle')}</p>
        </div>
        {canRecord && (
          <button
            type="button"
            onClick={() => setRecording(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground max-lg:min-h-11"
          >
            <Plus size={14} /> {t('prd.record')}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-[0.7rem] text-muted-foreground">{t('prd.from')}</span>
          <input
            type="date"
            value={from}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
            className={`${inputCls} w-auto`}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[0.7rem] text-muted-foreground">{t('prd.to')}</span>
          <input
            type="date"
            value={to}
            onChange={(e) => e.target.value && setTo(e.target.value)}
            className={`${inputCls} w-auto`}
          />
        </label>
        <dl className="flex flex-wrap gap-2">
          {[
            [t('prd.runs'), fmt.number(summary.runs)],
            [t('prd.hours'), t('prd.hoursValue', { value: fmt.number(summary.hours) })],
            [t('prd.downtime'), t('prd.hoursValue', { value: fmt.number(summary.downtimeHours) })],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-card px-3 py-1.5">
              <dt className="text-[0.66rem] text-muted-foreground">{label}</dt>
              <dd className="text-[0.9rem] font-semibold tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {(summary.outputs.length > 0 || summary.inputs.length > 0) && (
        <div className="grid gap-3 md:grid-cols-2">
          {(
            [
              ['prd.made', summary.outputs],
              ['prd.used', summary.inputs],
            ] as const
          ).map(([label, rows]) =>
            rows.length === 0 ? null : (
              <section key={label} className="rounded-xl border border-border bg-card">
                <h2 className="px-4 pt-3 text-[0.8rem] font-semibold text-foreground">
                  {t(label)}
                </h2>
                <table className="w-full text-[0.78rem]">
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={`${r.productId}-${r.unit}`}
                        className="border-t border-border first:border-t-0"
                      >
                        <td className="px-4 py-2 text-foreground">{r.productName}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {qtyText(r.qty, r.unit)}
                        </td>
                        {label === 'prd.made' && (
                          <td className="px-4 py-2 text-right text-[0.7rem] tabular-nums text-muted-foreground">
                            {summary.hours > 0 &&
                              t('prd.perHour', { value: qtyText(r.qty / summary.hours, r.unit) })}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )
          )}
        </div>
      )}

      {summary.days.length > 1 && (
        <section className="overflow-x-auto rounded-xl border border-border bg-card">
          <h2 className="px-4 pt-3 text-[0.8rem] font-semibold text-foreground">
            {t('prd.byDay')}
          </h2>
          <table className="w-full text-[0.78rem]">
            <tbody>
              {summary.days.map((d) => (
                <tr key={d.date} className="border-t border-border first:border-t-0">
                  <td className="px-4 py-2 whitespace-nowrap text-foreground">
                    {fmt.date(d.date)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
                    {t('prd.hoursValue', { value: fmt.number(d.hours) })}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {d.outputs.map((o) => `${o.productName} ${qtyText(o.qty, o.unit)}`).join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-[0.85rem] font-semibold text-foreground">{t('prd.list')}</h2>
        {loading ? (
          <div className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
        ) : runs.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-10 text-center">
            <Factory size={30} className="mx-auto mb-3 text-muted-foreground opacity-40" />
            <p className="text-[0.8rem] text-muted-foreground">{t('prd.empty')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-[0.78rem]">
              <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('prd.col.run')}</th>
                  <th className="px-3 py-2 font-medium">{t('prd.col.date')}</th>
                  <th className="px-3 py-2 font-medium max-md:hidden">{t('prd.col.plant')}</th>
                  <th className="px-3 py-2 font-medium">{t('prd.col.outputs')}</th>
                  <th className="px-3 py-2 font-medium max-md:hidden">{t('prd.col.input')}</th>
                  <th className="px-3 py-2 font-medium text-right">{t('prd.hours')}</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-t border-border align-top ${r.status === 'reversed' ? 'text-muted-foreground' : ''}`}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.docNo}
                      {r.status === 'reversed' && (
                        <span className="block text-[0.68rem]" title={r.reverseReason}>
                          {t('prd.reversed')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmt.date(r.runDate)}</td>
                    <td className="px-3 py-2 max-md:hidden">
                      {[r.plant, r.shift].filter(Boolean).join(' · ') || '—'}
                    </td>
                    <td className="px-3 py-2">
                      {r.outputs.map((o) => (
                        <span key={`${o.productId}-${o.unit}`} className="block">
                          {o.productName} {qtyText(o.qty, o.unit)}
                        </span>
                      ))}
                    </td>
                    <td className="px-3 py-2 max-md:hidden">
                      {r.inputQty === null
                        ? '—'
                        : `${r.inputProductName} ${qtyText(r.inputQty, r.inputUnit)}`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {fmt.number(r.hours)}
                      {r.downtimeHours > 0 && (
                        <span className="block text-[0.68rem] text-muted-foreground">
                          −{fmt.number(r.downtimeHours)}
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-1 text-right">
                      {canReverse && r.status === 'posted' && (
                        <button
                          type="button"
                          onClick={() => void reverse(r)}
                          title={t('prd.reverse')}
                          aria-label={`${t('prd.reverse')}: ${r.docNo}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                        >
                          <Undo2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {recording && (
        <RecordDialog
          products={products}
          stockpiles={stockpiles}
          onClose={() => setRecording(false)}
          onSaved={() => {
            setRecording(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
