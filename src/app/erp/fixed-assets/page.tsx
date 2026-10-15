'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CircleSlash, HandCoins, ListOrdered, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../lib/WorkspaceContext';
import { errorKey } from '../components/moduleUi';
import { ReasonDialog } from '../components/ReasonDialog';
import { financeService, type FixedAsset } from '../lib/financeService';
import { AssetDialog, DepreciateDialog, DisposeDialog, ScheduleDialog } from './dialogs';

const thCls = 'px-3 py-2 text-left font-medium';
const tdCls = 'px-3 py-2';
const iconBtn = 'p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40';

type Filter = 'active' | 'all';

export default function FixedAssetsPage() {
  const { t, fmt } = useI18n();
  const { can } = useWorkspace();
  const canManage = can('payments');
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('active');
  const [adding, setAdding] = useState(false);
  const [depreciating, setDepreciating] = useState(false);
  const [disposing, setDisposing] = useState<FixedAsset | null>(null);
  const [voiding, setVoiding] = useState<FixedAsset | null>(null);
  const [schedule, setSchedule] = useState<FixedAsset | null>(null);

  const load = useCallback(async () => {
    try {
      setAssets(await financeService.assets());
    } catch (err) {
      toast.error(t(errorKey(err, 'fin.err.failed')));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    load();
  }, [load]);

  const shown = assets.filter((a) => (filter === 'active' ? a.status === 'active' : true));
  const totals = useMemo(() => {
    const active = assets.filter((a) => a.status === 'active');
    return {
      cost: active.reduce((s, a) => s + a.cost, 0),
      accumulated: active.reduce((s, a) => s + a.accumulated, 0),
      book: active.reduce((s, a) => s + a.bookValue, 0),
    };
  }, [assets]);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-semibold text-foreground">{t('fa.title')}</h1>
          <p className="text-[0.8rem] text-muted-foreground">{t('fa.subtitle')}</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button
              onClick={() => setDepreciating(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[0.78rem] text-foreground hover:bg-muted max-lg:min-h-10"
            >
              <CalendarClock size={14} /> {t('fa.depreciate')}
            </button>
            <button
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground max-lg:min-h-10"
            >
              <Plus size={14} /> {t('fa.new')}
            </button>
          </div>
        )}
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ['fa.total.cost', totals.cost],
            ['fa.total.accumulated', totals.accumulated],
            ['fa.total.book', totals.book],
          ] as [MessageKey, number][]
        ).map(([label, value]) => (
          <div key={label} className="rounded-xl border border-border bg-card p-3">
            <div className="text-[0.7rem] text-muted-foreground">{t(label)}</div>
            <div className="mt-1 text-[1.05rem] font-semibold tabular-nums text-foreground">
              {fmt.money(value)}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-1" role="radiogroup" aria-label={t('fin.rec.filter')}>
        {(['active', 'all'] as Filter[]).map((f) => (
          <button
            key={f}
            role="radio"
            aria-checked={filter === f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-3 py-1 text-[0.72rem] ${
              filter === f
                ? 'border-foreground text-foreground'
                : 'border-border text-muted-foreground'
            }`}
          >
            {t(f === 'active' ? 'fa.filter.active' : 'fa.filter.all')}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-[0.8rem]">
          <thead className="bg-muted/40 text-[0.72rem] text-muted-foreground">
            <tr>
              <th className={thCls}>{t('fa.col.asset')}</th>
              <th className={thCls}>{t('fa.col.acquired')}</th>
              <th className={thCls}>{t('fa.col.method')}</th>
              <th className={`${thCls} text-right`}>{t('fa.col.cost')}</th>
              <th className={`${thCls} text-right`}>{t('fa.col.accumulated')}</th>
              <th className={`${thCls} text-right`}>{t('fa.col.book')}</th>
              <th className={thCls}>{t('fa.col.through')}</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className={`${tdCls} text-muted-foreground`}>
                  {t('common.loading')}
                </td>
              </tr>
            )}
            {!loading && !shown.length && (
              <tr>
                <td colSpan={8} className={`${tdCls} text-muted-foreground`}>
                  {t('fa.none')}
                </td>
              </tr>
            )}
            {shown.map((a) => (
              <tr
                key={a.id}
                className={`border-t border-border ${a.status === 'active' ? '' : 'opacity-60'}`}
              >
                <td className={tdCls}>
                  <div className="font-medium text-foreground">
                    {a.assetNo && <span className="text-muted-foreground">{a.assetNo} · </span>}
                    {a.name}
                  </div>
                  <div className="text-[0.7rem] text-muted-foreground">
                    {t(`fa.cat.${a.category}` as MessageKey)}
                    {a.status !== 'active' && ` · ${t(`fa.status.${a.status}` as MessageKey)}`}
                    {a.status === 'disposed' && a.disposedOn && ` ${fmt.date(a.disposedOn)}`}
                  </div>
                </td>
                <td className={`${tdCls} whitespace-nowrap`}>{fmt.date(a.acquisitionDate)}</td>
                <td className={tdCls}>
                  {t(`fa.method.${a.method}` as MessageKey)}
                  {a.method !== 'none' && (
                    <div className="text-[0.7rem] text-muted-foreground">
                      {t('fa.lifeShort', { n: a.lifeMonths })}
                      {a.decliningRate !== null && ` · ${fmt.number(a.decliningRate)}%`}
                    </div>
                  )}
                </td>
                <td className={`${tdCls} text-right tabular-nums`}>{fmt.money(a.cost)}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{fmt.money(a.accumulated)}</td>
                <td className={`${tdCls} text-right font-medium tabular-nums`}>
                  {fmt.money(a.bookValue)}
                </td>
                <td className={`${tdCls} whitespace-nowrap`}>
                  {a.depreciatedThrough ? fmt.month(a.depreciatedThrough, true) : '—'}
                </td>
                <td className={`${tdCls} whitespace-nowrap text-right`}>
                  <button
                    className={iconBtn}
                    title={t('fa.schedule')}
                    aria-label={t('fa.schedule')}
                    onClick={() => setSchedule(a)}
                  >
                    <ListOrdered size={15} />
                  </button>
                  {canManage && a.status === 'active' && (
                    <>
                      <button
                        className={iconBtn}
                        title={t('fa.dispose')}
                        aria-label={t('fa.dispose')}
                        onClick={() => setDisposing(a)}
                      >
                        <HandCoins size={15} />
                      </button>
                      {!a.depreciatedThrough && (
                        <button
                          className={iconBtn}
                          title={t('fa.void')}
                          aria-label={t('fa.void')}
                          onClick={() => setVoiding(a)}
                        >
                          <CircleSlash size={15} />
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[0.72rem] text-muted-foreground">{t('fa.help')}</p>

      {adding && (
        <AssetDialog
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            toast.success(t('fa.saved'));
            await load();
          }}
        />
      )}
      {depreciating && (
        <DepreciateDialog
          onClose={() => setDepreciating(false)}
          onDone={async (r) => {
            setDepreciating(false);
            toast.success(
              r.months
                ? t('fa.depreciated', {
                    months: r.months,
                    assets: r.assets,
                    amount: fmt.money(r.amount),
                  })
                : t('fa.nothingToPost')
            );
            await load();
          }}
        />
      )}
      {disposing && (
        <DisposeDialog
          asset={disposing}
          onClose={() => setDisposing(null)}
          onDone={async () => {
            setDisposing(null);
            toast.success(t('fa.disposed'));
            await load();
          }}
        />
      )}
      {schedule && <ScheduleDialog asset={schedule} onClose={() => setSchedule(null)} />}
      {voiding && (
        <ReasonDialog
          title={t('fa.void')}
          description={t('fa.voidHint')}
          confirmLabel={t('fa.void')}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            try {
              await financeService.voidAsset(voiding.id, reason);
            } catch (err) {
              throw new Error(t(errorKey(err, 'fin.err.failed')));
            }
            setVoiding(null);
            await load();
          }}
        />
      )}
    </div>
  );
}
