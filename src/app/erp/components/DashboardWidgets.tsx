'use client';

// The ERP dashboard's dense widgets: KPI tiles, ranked revenue bars, the aged
// receivables donut, balances by account and the 12-month trend. Data comes
// from erp_dashboard_insights and erp_cash_account_list; every amount is in
// the base currency. Colors are the app's own tokens (monochrome series,
// positive / warning / negative for states), never a fixed palette.

import React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import type { CashAccount } from '../lib/financeService';
import {
  AGING_KEYS,
  monthsEmpty,
  type AgingBuckets,
  type MonthFigures,
  type RankedItem,
} from '../lib/dashboardInsights';

const AXIS_TICK = { fill: 'var(--muted-foreground)', fontSize: 10.5 };
const WARNING = 'var(--warning, #f59e0b)';

// Older debt reads warmer: not yet due → over 90 days.
const AGING_COLORS: Record<keyof AgingBuckets, string> = {
  current: 'var(--positive)',
  days30: `color-mix(in srgb, var(--positive) 35%, ${WARNING})`,
  days60: WARNING,
  days90: `color-mix(in srgb, ${WARNING} 45%, var(--negative))`,
  over90: 'var(--negative)',
};

// ─── Frame ──────────────────────────────────────────────────────────────────

export function Widget({
  title,
  subtitle,
  href,
  className = '',
  children,
}: {
  title: string;
  subtitle?: string;
  href?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section
      className={`rounded-xl border border-border bg-card flex flex-col min-w-0 ${className}`}
    >
      <header className="px-4 pt-3 pb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[0.8125rem] font-semibold text-foreground truncate">{title}</h2>
          {subtitle && (
            <p className="text-[0.65rem] text-muted-foreground mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
        {href && (
          <Link
            href={href}
            className="flex items-center gap-0.5 text-[0.68rem] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            {t('dash.more')} <ChevronRight size={11} />
          </Link>
        )}
      </header>
      <div className="px-4 pb-3 flex-1 min-h-0">{children}</div>
    </section>
  );
}

export function WidgetState({
  loading,
  empty,
  height = 180,
}: {
  loading?: boolean;
  empty?: string | null;
  height?: number;
}) {
  if (loading)
    return (
      <div
        className="rounded-lg animate-pulse bg-[var(--surface-3)]"
        style={{ height }}
        aria-busy="true"
      />
    );
  return (
    <div
      className="flex items-center justify-center text-center text-[0.75rem] text-muted-foreground px-4"
      style={{ height }}
    >
      {empty}
    </div>
  );
}

// ─── KPI tile ───────────────────────────────────────────────────────────────

export function KpiTile({
  label,
  value,
  hint,
  tone = null,
  loading,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'critical' | 'warning' | null;
  loading: boolean;
}) {
  const color =
    tone === 'critical' ? 'var(--negative)' : tone === 'warning' ? WARNING : 'var(--foreground)';
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 flex flex-col gap-1.5 min-w-0">
      <p className="text-[0.66rem] uppercase tracking-wider font-medium text-muted-foreground leading-snug">
        {label}
      </p>
      {loading ? (
        <span className="inline-block w-24 h-7 rounded animate-pulse bg-[var(--surface-3)]" />
      ) : (
        <p
          className="text-[1.6rem] font-bold leading-none tracking-tight tabular-nums [overflow-wrap:anywhere]"
          style={{ color }}
          title={value}
        >
          {value}
        </p>
      )}
      {!loading && hint && (
        <p className="text-[0.66rem] text-muted-foreground truncate" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

// ─── Tooltip ────────────────────────────────────────────────────────────────

interface TooltipEntry {
  dataKey?: string | number;
  name?: string;
  value?: number;
  color?: string;
  payload?: { fill?: string };
}

function MoneyTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
}) {
  const { fmt } = useI18n();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-[0.72rem] shadow-sm">
      {label != null && <p className="text-muted-foreground mb-1">{label}</p>}
      {payload.map((p) => (
        <p key={p.dataKey ?? p.name} className="tabular-nums flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-sm shrink-0"
            style={{ background: p.payload?.fill ?? p.color }}
          />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="text-foreground font-medium">{fmt.money(p.value ?? 0)}</span>
        </p>
      ))}
    </div>
  );
}

// ─── Ranked revenue (top products / customers) ──────────────────────────────

export function RankedBars({ items }: { items: RankedItem[] }) {
  const { t, fmt } = useI18n();
  // One height for both lists, so the two cards line up beside the aging donut.
  const height = Math.max(250, items.length * 24 + 16);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={items} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
        <XAxis
          type="number"
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => fmt.moneyCompact(v)}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={124}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
        />
        <Tooltip content={<MoneyTooltip />} cursor={{ fill: 'var(--surface-3)' }} />
        <Bar
          dataKey="revenue"
          name={t('dash.series.revenue')}
          fill="var(--foreground)"
          radius={[0, 3, 3, 0]}
          barSize={14}
          label={{
            position: 'right',
            fill: 'var(--muted-foreground)',
            fontSize: 10,
            formatter: (v: number) => fmt.moneyCompact(v),
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ─── Aged receivables donut ─────────────────────────────────────────────────

export function AgingDonut({ aging }: { aging: AgingBuckets }) {
  const { t, fmt } = useI18n();
  const total = AGING_KEYS.reduce((n, k) => n + aging[k], 0);
  const slices = AGING_KEYS.map((k) => ({
    key: k,
    name: t(`dash.aging.${k}` as MessageKey),
    value: aging[k],
    fill: AGING_COLORS[k],
  }));
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-[150px] h-[150px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices.filter((s) => s.value > 0)}
              dataKey="value"
              nameKey="name"
              innerRadius={46}
              outerRadius={70}
              paddingAngle={1}
              stroke="var(--card)"
              isAnimationActive={false}
            >
              {slices
                .filter((s) => s.value > 0)
                .map((s) => (
                  <Cell key={s.key} fill={s.fill} />
                ))}
            </Pie>
            <Tooltip content={<MoneyTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[0.6rem] uppercase tracking-wider text-muted-foreground">
            {t('dash.aging.total')}
          </span>
          <span className="text-[0.85rem] font-bold text-foreground tabular-nums">
            {fmt.moneyCompact(total)}
          </span>
        </div>
      </div>
      <ul className="w-full space-y-1">
        {slices.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-[0.72rem]">
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.fill }} />
            <span className="text-muted-foreground flex-1 min-w-0 truncate" title={s.name}>
              {s.name}
            </span>
            <span className="tabular-nums text-foreground font-medium" title={fmt.money(s.value)}>
              {fmt.moneyCompact(s.value)}
            </span>
            <span className="tabular-nums text-muted-foreground w-9 text-right">
              {total > 0 ? `${Math.round((s.value / total) * 100)}%` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Balances by account ────────────────────────────────────────────────────

export function BankBalances({
  accounts,
  currency,
}: {
  accounts: CashAccount[];
  currency: string;
}) {
  const { t, fmt } = useI18n();
  const groups = (['bank', 'cash'] as const)
    .map((kind) => ({ kind, rows: accounts.filter((a) => a.kind === kind) }))
    .filter((g) => g.rows.length > 0);
  const total = accounts.reduce((n, a) => n + a.balance, 0);
  const th =
    'py-1.5 px-2 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground';
  const money = (v: number) => (
    <span style={{ color: v < 0 ? 'var(--negative)' : undefined }}>{fmt.money(v)}</span>
  );
  return (
    <div className="max-h-[280px] overflow-y-auto -mx-1">
      <table className="w-full text-[0.72rem] table-fixed">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border">
            <th className={`${th} text-left`}>{t('dash.bank.account')}</th>
            <th className={`${th} text-right w-[46%]`}>
              {t('dash.bank.balance')} {currency && `(${currency})`}
            </th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.kind}>
            <tr>
              <td
                colSpan={2}
                className="pt-2 pb-1 px-2 text-[0.62rem] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {t(`fin.kind.${g.kind}` as MessageKey)}
              </td>
            </tr>
            {g.rows.map((a) => (
              <tr key={a.id} className="border-b border-border/60 align-top">
                <td className="py-1.5 px-2 min-w-0">
                  <p className="text-foreground truncate" title={a.name}>
                    {a.name}
                    {!a.active && (
                      <span className="ml-1 text-[0.6rem] text-muted-foreground">
                        ({t('dash.bank.inactive')})
                      </span>
                    )}
                  </p>
                  {(a.bankName || a.accountNo) && (
                    <p className="text-[0.64rem] text-muted-foreground font-mono truncate">
                      {[a.bankName, a.accountNo].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-foreground [overflow-wrap:anywhere]">
                  {money(a.balance)}
                </td>
              </tr>
            ))}
            {g.rows.length > 1 && (
              <tr className="border-b border-border">
                <td className="py-1.5 px-2 font-semibold text-foreground">
                  {t('dash.bank.subtotal')}
                </td>
                <td className="py-1.5 px-2 text-right font-semibold tabular-nums text-foreground [overflow-wrap:anywhere]">
                  {money(g.rows.reduce((n, a) => n + a.balance, 0))}
                </td>
              </tr>
            )}
          </tbody>
        ))}
        <tfoot>
          <tr>
            <td className="pt-2 px-2 font-bold text-foreground">{t('dash.bank.total')}</td>
            <td className="pt-2 px-2 text-right font-bold tabular-nums text-foreground [overflow-wrap:anywhere]">
              {money(total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── 12-month trend ─────────────────────────────────────────────────────────

export function MonthlyTrend({ months }: { months: MonthFigures[] }) {
  const { t, fmt } = useI18n();
  if (monthsEmpty(months)) return <WidgetState empty={t('dash.empty.trend')} height={220} />;
  // A local date (not an ISO string, which parses as UTC midnight).
  const data = months.map((m) => {
    const [y, mo] = m.month.split('-').map(Number);
    return { ...m, label: fmt.month(new Date(y, mo - 1, 1), true) };
  });
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          width={64}
          tickFormatter={(v) => fmt.moneyCompact(v)}
        />
        <Tooltip content={<MoneyTooltip />} />
        <Legend
          iconType="plainline"
          iconSize={14}
          wrapperStyle={{ fontSize: 11, color: 'var(--muted-foreground)', paddingTop: 4 }}
        />
        <Line
          type="monotone"
          dataKey="revenue"
          name={t('dash.series.revenue')}
          stroke="var(--foreground)"
          strokeWidth={2}
          dot={{ r: 2.5 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="cashIn"
          name={t('dash.series.cashIn')}
          stroke="var(--positive)"
          strokeWidth={1.75}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="cashOut"
          name={t('dash.series.cashOut')}
          stroke="var(--negative)"
          strokeWidth={1.75}
          strokeDasharray="4 3"
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
