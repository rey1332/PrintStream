'use client';

// Draws a Chart node's result (src/lib/workflow/chartData.ts): the data is
// already shaped on the server. Series take the categorical palette's slots
// in order (--series-1…8, validated light and dark); "Other" is neutral. A
// legend names every series when there are two or more, and the table view
// shows the same numbers (colour is never the only way to read a value).

import React, { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BarChart3, Maximize2, Table as TableIcon, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { DataTable } from '@/lib/workflow/types';
import { OTHER, TOTAL, type ChartFormat, type ChartMeta } from '@/lib/workflow/chartData';

const AXIS = { fill: 'var(--muted-foreground)', fontSize: 10.5 };
const GRID = 'var(--border)';
const NEUTRAL = 'var(--muted-foreground)';
// The sequential ramp (one hue, light → dark) for heatmap cells.
const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

const colorOf = (series: string, i: number) =>
  series === OTHER ? NEUTRAL : `var(--series-${(i % 8) + 1})`;

function useFormat(format: ChartFormat) {
  const { fmt } = useI18n();
  return useMemo(() => {
    const full = (v: unknown) => {
      if (v === null || v === undefined || v === '') return '—';
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      switch (format) {
        case 'currency':
          return fmt.money(n);
        case 'percent':
          return fmt.number(n, { style: 'percent', maximumFractionDigits: 1 });
        case 'compact':
          return fmt.number(n, { notation: 'compact', maximumFractionDigits: 1 });
        default:
          return fmt.number(n, { maximumFractionDigits: 2 });
      }
    };
    const axis = (v: unknown) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return String(v);
      if (format === 'percent')
        return fmt.number(n, { style: 'percent', maximumFractionDigits: 0 });
      if (format === 'currency') return fmt.moneyCompact(n);
      return fmt.number(n, { notation: 'compact', maximumFractionDigits: 1 });
    };
    return { full, axis };
  }, [format, fmt]);
}

function ChartTooltip({
  active,
  payload,
  label,
  format,
  name,
}: {
  active?: boolean;
  payload?: {
    dataKey?: string | number;
    name?: string;
    value?: unknown;
    color?: string;
    payload?: Record<string, unknown>;
  }[];
  label?: unknown;
  format: (v: unknown) => string;
  name: (s: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[0.7rem] shadow-sm">
      {label !== undefined && label !== '' && (
        <p className="mb-0.5 text-muted-foreground">{name(String(label))}</p>
      )}
      {payload.map((p, i) => (
        <p key={`${p.dataKey}-${i}`} className="flex items-center gap-1.5 tabular-nums">
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} />
          <span className="text-muted-foreground">{name(String(p.name ?? p.dataKey))}:</span>
          <span className="font-medium text-foreground">{format(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

function DataView({
  data,
  name,
  format,
}: {
  data: DataTable;
  name: (s: string) => string;
  format: (v: unknown) => string;
}) {
  const chart = data.meta?.chart;
  return (
    <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
      <table className="w-full text-[0.68rem]">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border">
            {data.columns.map((c) => (
              <th
                key={c}
                className="px-2 py-1 text-left font-semibold text-muted-foreground whitespace-nowrap"
              >
                {name(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60">
              {data.columns.map((c) => {
                const v = r[c];
                const numeric = typeof v === 'number' && c !== chart?.x;
                return (
                  <td
                    key={c}
                    className={`px-2 py-1 whitespace-nowrap ${numeric ? 'text-right tabular-nums' : ''} ${
                      r[chart?.x ?? ''] === TOTAL || c === TOTAL ? 'font-semibold' : ''
                    }`}
                  >
                    {numeric ? format(v) : name(String(v ?? '—'))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Heatmap({
  data,
  chart,
  format,
  name,
}: {
  data: DataTable;
  chart: ChartMeta;
  format: (v: unknown) => string;
  name: (s: string) => string;
}) {
  const { t } = useI18n();
  const y = chart.y ?? '';
  const xs = [...new Set(data.rows.map((r) => String(r[chart.x])))];
  const ys = [...new Set(data.rows.map((r) => String(r[y])))];
  const values = data.rows.map((r) => Number(r.value)).filter(Number.isFinite);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const cell = new Map(data.rows.map((r) => [`${r[chart.x]}\u0000${r[y]}`, r.value]));
  const shade = (v: unknown) => {
    const n = Number(v);
    if (!Number.isFinite(n) || v === null) return 'transparent';
    const i = hi === lo ? RAMP.length - 1 : Math.round(((n - lo) / (hi - lo)) * (RAMP.length - 1));
    return RAMP[i];
  };
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th />
              {xs.map((x) => (
                <th
                  key={x}
                  className="px-1 text-[0.6rem] font-normal text-muted-foreground whitespace-nowrap"
                >
                  {name(x)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ys.map((yv) => (
              <tr key={yv}>
                <th className="pr-1 text-right text-[0.6rem] font-normal text-muted-foreground whitespace-nowrap">
                  {name(yv)}
                </th>
                {xs.map((x) => {
                  const v = cell.get(`${x}\u0000${yv}`);
                  const bg = shade(v);
                  const dark = RAMP.indexOf(bg) >= 4;
                  return (
                    <td
                      key={x}
                      title={`${name(x)} · ${name(yv)}: ${format(v)}`}
                      className="h-7 min-w-9 rounded-[3px] px-1 text-center text-[0.58rem] tabular-nums"
                      style={{ background: bg, color: dark ? '#ffffff' : '#0d366b' }}
                    >
                      {v === null || v === undefined ? '' : format(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-1.5 text-[0.6rem] text-muted-foreground">
        <span className="tabular-nums">{format(lo)}</span>
        <span className="flex h-2 w-24 overflow-hidden rounded-sm">
          {RAMP.map((c) => (
            <span key={c} className="flex-1" style={{ background: c }} />
          ))}
        </span>
        <span className="tabular-nums">{format(hi)}</span>
        <span className="ml-1">{t('wf.chart.heatLegend')}</span>
      </div>
    </div>
  );
}

export function ChartOutput({ data, large = false }: { data: DataTable; large?: boolean }) {
  const { t, fmt } = useI18n();
  const chart = data.meta?.chart;
  const [view, setView] = useState<'chart' | 'table'>(chart?.kind === 'pivot' ? 'table' : 'chart');
  const [open, setOpen] = useState(false);
  const { full, axis } = useFormat(chart?.format ?? 'plain');
  if (!chart) return null;
  const name = (s: string) =>
    s === OTHER
      ? t('wf.chart.other')
      : s === TOTAL
        ? t('wf.chart.total')
        : s === ''
          ? t('wf.chart.blank')
          : s;
  const tooltip = (
    <Tooltip
      content={<ChartTooltip format={full} name={name} />}
      cursor={{ fill: 'var(--surface-3)' }}
    />
  );
  const legend =
    chart.series.length >= 2 ? (
      <Legend
        formatter={(v: string) => (
          <span className="text-[0.68rem] text-muted-foreground">{name(v)}</span>
        )}
        iconSize={9}
        wrapperStyle={{ paddingTop: 4 }}
      />
    ) : null;
  const rows = data.rows;
  const xAxis = (
    <XAxis
      key="x"
      dataKey={chart.x}
      tick={AXIS}
      tickLine={false}
      axisLine={{ stroke: GRID }}
      tickFormatter={(v) => name(String(v))}
      interval="preserveStartEnd"
      minTickGap={8}
    />
  );
  const yAxis = (
    <YAxis key="y" tick={AXIS} tickLine={false} axisLine={false} width={52} tickFormatter={axis} />
  );
  const grid = <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />;
  const stacked = chart.kind === 'stackedBar' || chart.kind === 'stackedArea';
  // Past six categories the names no longer fit under the bars: they lie down.
  const manyCategories = rows.length > 6;
  const H = large ? 420 : 240;

  let body: React.ReactNode = null;
  if (!rows.length)
    body = (
      <p className="py-6 text-center text-[0.72rem] text-muted-foreground">{t('wf.chart.empty')}</p>
    );
  else if (chart.kind === 'pivot') body = <DataView data={data} name={name} format={full} />;
  else if (chart.kind === 'heatmap')
    body = <Heatmap data={data} chart={chart} format={full} name={name} />;
  else if (chart.kind === 'pie' || chart.kind === 'donut') {
    const value = chart.series[0];
    const total = rows.reduce((n, r) => n + (Number(r[value]) || 0), 0);
    body = (
      <div className="flex flex-col items-center gap-2">
        <div className={large ? 'h-72 w-72' : 'h-44 w-44'}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={rows}
                dataKey={value}
                nameKey={chart.x}
                innerRadius={chart.kind === 'donut' ? (large ? 76 : 46) : 0}
                outerRadius={large ? 130 : 80}
                stroke="var(--card)"
                strokeWidth={2}
                isAnimationActive={false}
              >
                {rows.map((r, i) => (
                  <Cell key={i} fill={colorOf(String(r[chart.x]), i)} />
                ))}
              </Pie>
              {tooltip}
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="w-full space-y-0.5">
          {rows.map((r, i) => (
            <li key={i} className="flex items-center gap-1.5 text-[0.68rem]">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ background: colorOf(String(r[chart.x]), i) }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {name(String(r[chart.x]))}
              </span>
              <span className="tabular-nums text-foreground">{full(r[value])}</span>
              <span className="w-9 text-right tabular-nums text-muted-foreground">
                {total
                  ? fmt.number(Number(r[value]) / total, {
                      style: 'percent',
                      maximumFractionDigits: 0,
                    })
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (chart.kind === 'scatter') {
    const yKey = data.columns[1];
    body = (
      <ResponsiveContainer width="100%" height={H}>
        <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
          <XAxis
            type="number"
            dataKey={chart.x}
            name={chart.x}
            tick={AXIS}
            tickLine={false}
            tickFormatter={axis}
          />
          <YAxis
            type="number"
            dataKey={yKey}
            name={yKey}
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={axis}
          />
          <Tooltip
            cursor={{ strokeDasharray: '3 3' }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-[0.7rem] shadow-sm tabular-nums">
                  {chart.y && (
                    <p className="text-muted-foreground">
                      {name(String(payload[0].payload.series))}
                    </p>
                  )}
                  <p>
                    {chart.x}: {full(payload[0].payload[chart.x])}
                  </p>
                  <p>
                    {yKey}: {full(payload[0].payload[yKey])}
                  </p>
                </div>
              ) : null
            }
          />
          {legend}
          {chart.series.map((s, i) => (
            <Scatter
              key={s}
              name={s}
              data={rows.filter((r) => String(r.series) === s)}
              fill={colorOf(s, i)}
              fillOpacity={0.75}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    );
  } else if (chart.kind === 'line') {
    body = (
      <ResponsiveContainer width="100%" height={H}>
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {chart.series.map((s, i) => (
            <Line
              key={s}
              type="monotone"
              dataKey={s}
              name={s}
              stroke={colorOf(s, i)}
              strokeWidth={2}
              dot={rows.length <= 40 ? { r: 3 } : false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  } else if (chart.kind === 'area' || chart.kind === 'stackedArea') {
    body = (
      <ResponsiveContainer width="100%" height={H}>
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {chart.series.map((s, i) => (
            <Area
              key={s}
              type="monotone"
              dataKey={s}
              name={s}
              stackId={stacked ? 'stack' : undefined}
              stroke={colorOf(s, i)}
              strokeWidth={2}
              fill={colorOf(s, i)}
              fillOpacity={stacked ? 0.55 : 0.18}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  } else if (chart.kind === 'combo') {
    // One y axis for all (never two scales): the first value as bars, the others as lines.
    body = (
      <ResponsiveContainer width="100%" height={H}>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {chart.series.map((s, i) =>
            i === 0 ? (
              <Bar
                key={s}
                dataKey={s}
                name={s}
                fill={colorOf(s, i)}
                radius={[4, 4, 0, 0]}
                maxBarSize={36}
                isAnimationActive={false}
              />
            ) : (
              <Line
                key={s}
                type="monotone"
                dataKey={s}
                name={s}
                stroke={colorOf(s, i)}
                strokeWidth={2}
                dot={rows.length <= 40 ? { r: 3 } : false}
                isAnimationActive={false}
              />
            )
          )}
        </ComposedChart>
      </ResponsiveContainer>
    );
  } else {
    // bar, stackedBar, histogram. Many categories: horizontal, so the names stay readable.
    const horizontal = manyCategories && chart.kind !== 'histogram';
    const height = horizontal ? Math.max(large ? 320 : 200, rows.length * 22 + 40) : H;
    body = (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={rows}
          layout={horizontal ? 'vertical' : 'horizontal'}
          margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
          barCategoryGap={chart.kind === 'histogram' ? 1 : '18%'}
          barGap={2}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={GRID}
            vertical={horizontal}
            horizontal={!horizontal}
          />
          {/* Recharts finds its axes among the direct children: no fragments here. */}
          {horizontal
            ? [
                <XAxis
                  key="x"
                  type="number"
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={axis}
                />,
                <YAxis
                  key="y"
                  type="category"
                  dataKey={chart.x}
                  tick={AXIS}
                  tickLine={false}
                  axisLine={false}
                  width={110}
                  tickFormatter={(v) => {
                    const s = name(String(v));
                    return s.length > 18 ? `${s.slice(0, 17)}…` : s;
                  }}
                />,
              ]
            : [xAxis, yAxis]}
          {tooltip}
          {legend}
          {chart.series.map((s, i) => (
            <Bar
              key={s}
              dataKey={s}
              name={s}
              stackId={stacked ? 'stack' : undefined}
              fill={colorOf(s, i)}
              stroke={stacked ? 'var(--card)' : undefined}
              strokeWidth={stacked ? 1 : 0}
              radius={stacked ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
              maxBarSize={40}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-[0.75rem] font-semibold text-foreground">
          {chart.title ?? ''}
        </p>
        {!large && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            title={t('wf.chart.expand')}
            aria-label={t('wf.chart.expand')}
            className="ml-auto shrink-0 rounded-md border border-border p-1 text-muted-foreground hover:text-foreground"
          >
            <Maximize2 size={12} />
          </button>
        )}
        {chart.kind !== 'pivot' && (
          <div className="flex shrink-0 rounded-md border border-border p-0.5" role="group">
            {(['chart', 'table'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                title={t(v === 'chart' ? 'wf.chart.viewChart' : 'wf.chart.viewTable')}
                className={`rounded px-1.5 py-0.5 ${view === v ? 'bg-[var(--surface-3)] text-foreground' : 'text-muted-foreground'}`}
              >
                {v === 'chart' ? <BarChart3 size={12} /> : <TableIcon size={12} />}
              </button>
            ))}
          </div>
        )}
      </div>
      {view === 'table' && chart.kind !== 'pivot' ? (
        <DataView data={data} name={name} format={full} />
      ) : (
        body
      )}
      {(chart.omitted || data.meta?.sourceRows !== undefined) && (
        <p className="text-[0.62rem] text-muted-foreground">
          {data.meta?.sourceRows !== undefined &&
            t('wf.chart.fromRows', { n: fmt.number(data.meta.sourceRows) })}
          {chart.omitted
            ? ` · ${t(chart.kind === 'scatter' ? 'wf.chart.sampled' : 'wf.chart.omitted', { n: fmt.number(chart.omitted) })}`
            : ''}
        </p>
      )}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={chart.title ?? t('wf.chart.expand')}
          onClick={() => setOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        >
          <div
            className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-border bg-card p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                autoFocus
                onClick={() => setOpen(false)}
                aria-label={t('wf.close')}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <ChartOutput data={data} large />
          </div>
        </div>
      )}
    </div>
  );
}
