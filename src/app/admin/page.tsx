'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  ArrowRight,
  Building2,
  Database,
  FileText,
  KeyRound,
  Loader2,
  LogIn,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useAdmin, useAdminPath } from './components/AdminShell';
import { adminGet } from './components/api';
import { GrantAdminDialog, GrantWorkspaceDialog } from './components/GrantDialogs';
import { ROLE_LABEL } from './components/labels';
import { SecurityLogTable, type SecurityEvent } from './components/SecurityLogTable';
import { Badge, Section, buttonCls, rowCls, tableCls, theadCls } from './components/ui';

type Hours = 24 | 168 | 720;

const PERIODS: { hours: Hours; label: MessageKey }[] = [
  { hours: 24, label: 'padmin.dash.period.24h' },
  { hours: 168, label: 'padmin.dash.period.7d' },
  { hours: 720, label: 'padmin.dash.period.30d' },
];

interface Dashboard {
  hours: Hours;
  unit: 'hour' | 'day';
  accounts: {
    total: number;
    active: number;
    new: number;
    disabled: number;
    without_mfa: number;
    admins: number;
  };
  workspaces: { total: number; shared: number; new: number; suspended: number; active: number };
  sign_in: {
    succeeded: number;
    failed: number;
    rate_limited: number;
    mfa_failed: number;
    reset_failed: number;
    access_changes: number;
    admin_actions: number;
  };
  failing_accounts: { email: string; user_id: string | null; failures: number; last_at: string }[];
  failing_ips: { ip: string; failures: number; accounts: number; last_at: string }[];
  series: { t: string; sign_ins: number; failed: number; new_accounts: number }[];
  terms: {
    version_id: string;
    label: string;
    published_at: string;
    pending: number;
    pending_active: number;
  } | null;
  access_changes: SecurityEvent[];
  admin_actions: SecurityEvent[];
  database: {
    version: string;
    size_bytes: number;
    migrations: { applied: number; latest: string | null; pending: string[] | null };
    security_log: { events: number; oldest: string | null };
    retention_days: number | null;
  };
}

interface SystemStatus {
  database: { ok: boolean; ms: number | null };
  backups: { configured: boolean; count: number; latest: string | null } | null;
  app: { uptimeSeconds: number; node: string };
}

const browserTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

function Stat({
  icon: Icon,
  title,
  value,
  href,
  children,
}: {
  icon: React.ElementType;
  title: string;
  value: React.ReactNode;
  href?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex items-center gap-2 text-[0.75rem] text-muted-foreground">
        <Icon size={13} />
        {href ? (
          <Link href={href} className="hover:text-foreground hover:underline">
            {title}
          </Link>
        ) : (
          title
        )}
      </div>
      <p className="text-[1.5rem] font-semibold leading-none text-foreground tabular-nums">
        {value}
      </p>
      {children && <dl className="space-y-1 text-[0.75rem]">{children}</dl>}
    </section>
  );
}

function Line({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'warn' | 'bad';
  href?: string;
}) {
  const color =
    tone === 'bad'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-foreground';
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">
        {href ? (
          <Link href={href} className="hover:text-foreground hover:underline">
            {label}
          </Link>
        ) : (
          label
        )}
      </dt>
      <dd className={`tabular-nums ${color}`}>{value}</dd>
    </div>
  );
}

function bytes(n: number, number: (v: number, o?: Intl.NumberFormatOptions) => string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${number(value, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

export default function AdminDashboardPage() {
  const ap = useAdminPath();
  const { t, fmt } = useI18n();
  const { role } = useAdmin();
  const [hours, setHours] = useState<Hours>(24);
  const [data, setData] = useState<Dashboard | null>(null);
  const [failed, setFailed] = useState(false);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [dialog, setDialog] = useState<'admin' | 'workspace' | null>(null);

  const load = useCallback(async (period: Hours) => {
    const params = new URLSearchParams({ hours: String(period), tz: browserTimeZone() });
    const result = await adminGet<Dashboard>(`/api/admin/platform/dashboard?${params}`);
    if (result.ok) {
      setData(result.data);
      setFailed(false);
    } else setFailed(true);
  }, []);

  useEffect(() => {
    void load(hours);
  }, [hours, load]);

  useEffect(() => {
    void (async () => {
      const result = await adminGet<SystemStatus>('/api/admin/platform/system');
      if (result.ok) setSystem(result.data);
    })();
  }, []);

  const n = (value: number) => fmt.number(value);
  const when = (value: string | null) =>
    fmt.date(value, { dateStyle: 'medium', timeStyle: 'short' });
  const tick = (value: string) => {
    const date = new Date(value);
    return data?.unit === 'hour'
      ? fmt.date(date, { hour: '2-digit', minute: '2-digit' })
      : fmt.date(date, { day: 'numeric', month: 'short' });
  };

  const header = (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-5 py-4">
      <ShieldCheck size={16} className="text-primary" />
      <div className="min-w-0">
        <h1 className="text-[0.95rem] font-semibold text-foreground">{t('padmin.dash.title')}</h1>
        <p className="text-[0.72rem] text-muted-foreground">
          {t('padmin.dash.subtitle', { role: t(ROLE_LABEL[role]) })}
        </p>
      </div>
      <div
        role="group"
        aria-label={t('padmin.dash.period')}
        className="ml-auto flex overflow-hidden rounded-lg border border-border"
      >
        {PERIODS.map((p) => (
          <button
            key={p.hours}
            type="button"
            aria-pressed={hours === p.hours}
            onClick={() => setHours(p.hours)}
            className={`px-3 py-1.5 text-[0.75rem] max-lg:min-h-11 ${
              hours === p.hours
                ? 'bg-[var(--surface-2)] font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(p.label)}
          </button>
        ))}
      </div>
      {role === 'super_admin' && (
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <button type="button" className={buttonCls} onClick={() => setDialog('admin')}>
            <UserCog size={13} />
            {t('padmin.dash.grantAdmin')}
          </button>
          <button type="button" className={buttonCls} onClick={() => setDialog('workspace')}>
            <UserPlus size={13} />
            {t('padmin.access.grant')}
          </button>
        </div>
      )}
    </section>
  );

  const dialogs = (
    <>
      {dialog === 'admin' && (
        <GrantAdminDialog onDone={() => void load(hours)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'workspace' && (
        <GrantWorkspaceDialog onDone={() => void load(hours)} onClose={() => setDialog(null)} />
      )}
    </>
  );

  if (failed && !data)
    return (
      <div className="space-y-5">
        {header}
        <p role="alert" className="text-[0.8rem] text-red-600 dark:text-red-400">
          {t('padmin.err.failed')}
        </p>
        {dialogs}
      </div>
    );
  if (!data)
    return (
      <div className="space-y-5">
        {header}
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
      </div>
    );

  const { accounts, workspaces, sign_in: signIn, terms, database } = data;
  const pendingMigrations = database.migrations.pending;
  const chartTooltip = {
    contentStyle: {
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      fontSize: 12,
    },
    labelFormatter: (value: string) => tick(value),
  };

  return (
    <div className="space-y-5">
      {header}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={Users}
          title={t('padmin.dash.accounts')}
          value={n(accounts.total)}
          href={ap('/users')}
        >
          <Line label={t('padmin.dash.activeAccounts')} value={n(accounts.active)} />
          <Line label={t('padmin.dash.new')} value={n(accounts.new)} />
          <Line
            label={t('padmin.users.filter.disabled')}
            value={n(accounts.disabled)}
            tone={accounts.disabled ? 'bad' : undefined}
          />
          <Line
            label={t('padmin.users.filter.noMfa')}
            value={n(accounts.without_mfa)}
            tone={accounts.without_mfa ? 'warn' : undefined}
          />
          <Line label={t('padmin.nav.admins')} value={n(accounts.admins)} href={ap('/admins')} />
        </Stat>

        <Stat
          icon={Building2}
          title={t('padmin.nav.workspaces')}
          value={n(workspaces.total)}
          href={ap('/workspaces')}
        >
          <Line label={t('padmin.dash.activeWorkspaces')} value={n(workspaces.active)} />
          <Line label={t('padmin.dash.new')} value={n(workspaces.new)} />
          <Line label={t('padmin.ws.shared')} value={n(workspaces.shared)} />
          <Line
            label={t('padmin.ws.suspended')}
            value={n(workspaces.suspended)}
            tone={workspaces.suspended ? 'bad' : undefined}
          />
        </Stat>

        <Stat icon={LogIn} title={t('padmin.dash.signIns')} value={n(signIn.succeeded)}>
          <Line
            label={t('padmin.dash.failedSignIns')}
            value={n(signIn.failed)}
            tone={signIn.failed ? 'warn' : undefined}
            href={ap('/security-log?type=LOGIN_FAILED')}
          />
          <Line
            label={t('padmin.dash.failedCodes')}
            value={n(signIn.mfa_failed)}
            tone={signIn.mfa_failed ? 'warn' : undefined}
            href={ap('/security-log?type=MFA_CHALLENGE_FAILED')}
          />
          <Line
            label={t('padmin.dash.rateLimited')}
            value={n(signIn.rate_limited)}
            tone={signIn.rate_limited ? 'bad' : undefined}
            href={ap('/security-log?type=LOGIN_RATE_LIMITED')}
          />
          <Line
            label={t('padmin.dash.failedLinks')}
            value={n(signIn.reset_failed)}
            href={ap('/security-log?type=PASSWORD_RESET_FAILED')}
          />
        </Stat>

        <Stat
          icon={FileText}
          title={t('padmin.dash.termsPending')}
          value={terms ? n(terms.pending) : '—'}
          href={ap('/terms')}
        >
          {terms ? (
            <>
              <Line label={t('padmin.dash.termsCurrent')} value={terms.label} />
              <Line
                label={t('padmin.dash.termsPendingActive')}
                value={n(terms.pending_active)}
                tone={terms.pending_active ? 'warn' : undefined}
              />
              <Line
                label={t('padmin.terms.col.published')}
                value={fmt.date(terms.published_at, { dateStyle: 'medium' })}
              />
            </>
          ) : (
            <p className="text-muted-foreground">{t('padmin.dash.termsNone')}</p>
          )}
        </Stat>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('padmin.dash.chartSignIns')} icon={Activity}>
          <div className="px-3 py-4">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.series} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={tick}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={16}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <Tooltip {...chartTooltip} cursor={{ fill: 'var(--surface-2)' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar
                  dataKey="sign_ins"
                  name={t('padmin.dash.seriesSignIns')}
                  fill="var(--foreground)"
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="failed"
                  name={t('padmin.dash.seriesFailed')}
                  fill="#dc2626"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
        <Section title={t('padmin.dash.chartNewAccounts')} icon={UserPlus}>
          <div className="px-3 py-4">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data.series}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="t"
                  tickFormatter={tick}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={16}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <Tooltip {...chartTooltip} cursor={{ fill: 'var(--surface-2)' }} />
                <Bar
                  dataKey="new_accounts"
                  name={t('padmin.dash.seriesNewAccounts')}
                  fill="var(--muted-foreground)"
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('padmin.dash.failingAccounts')} icon={ShieldAlert}>
          {data.failing_accounts.length === 0 ? (
            <p className="px-5 py-4 text-[0.78rem] text-muted-foreground">
              {t('padmin.dash.noFailures')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls}>
                <thead className={theadCls}>
                  <tr>
                    <th className="px-5 py-2 font-medium">{t('padmin.admins.col.account')}</th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t('padmin.dash.failures')}
                    </th>
                    <th className="px-3 py-2 font-medium">{t('padmin.dash.lastAttempt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.failing_accounts.map((a) => (
                    <tr key={a.email} className={rowCls}>
                      <td className="max-w-[240px] truncate px-5 py-2">
                        <Link
                          href={ap(`/security-log?q=${encodeURIComponent(a.email)}`)}
                          className="text-foreground underline-offset-2 hover:underline"
                        >
                          {a.email}
                        </Link>
                        {!a.user_id && (
                          <span className="ml-1 text-[0.7rem] text-muted-foreground">
                            ({t('padmin.dash.unknownAccount')})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">
                        {n(a.failures)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {when(a.last_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title={t('padmin.dash.failingIps')} icon={ShieldAlert}>
          {data.failing_ips.length === 0 ? (
            <p className="px-5 py-4 text-[0.78rem] text-muted-foreground">
              {t(data.failing_accounts.length ? 'padmin.dash.noIps' : 'padmin.dash.noFailures')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls}>
                <thead className={theadCls}>
                  <tr>
                    <th className="px-5 py-2 font-medium">{t('padmin.log.col.ip')}</th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t('padmin.dash.failures')}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">{t('padmin.nav.users')}</th>
                    <th className="px-3 py-2 font-medium">{t('padmin.dash.lastAttempt')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.failing_ips.map((a) => (
                    <tr key={a.ip} className={rowCls}>
                      <td className="px-5 py-2 font-mono text-[0.72rem]">
                        <Link
                          href={ap(`/security-log?q=${encodeURIComponent(a.ip)}`)}
                          className="text-foreground underline-offset-2 hover:underline"
                        >
                          {a.ip}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">
                        {n(a.failures)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {n(a.accounts)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {when(a.last_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <Section
        title={t('padmin.dash.accessChanges')}
        icon={KeyRound}
        actions={<Badge>{t('padmin.dash.inPeriod', { count: n(signIn.access_changes) })}</Badge>}
      >
        <SecurityLogTable events={data.access_changes} />
      </Section>

      <Section
        title={t('padmin.dash.adminActions')}
        icon={UserCog}
        actions={
          <>
            <Badge>{t('padmin.dash.inPeriod', { count: n(signIn.admin_actions) })}</Badge>
            <Link
              href={ap('/security-log')}
              className="flex items-center gap-1 text-[0.75rem] text-muted-foreground hover:text-foreground"
            >
              {t('padmin.overview.viewAll')}
              <ArrowRight size={12} />
            </Link>
          </>
        }
      >
        <SecurityLogTable events={data.admin_actions} />
      </Section>

      <Section title={t('padmin.dash.system')} icon={Database}>
        <dl className="grid gap-x-8 gap-y-2 px-5 py-4 text-[0.78rem] sm:grid-cols-2">
          <Line
            label={t('padmin.dash.database')}
            value={
              system ? (
                system.database.ok ? (
                  t('padmin.dash.databaseOk', { ms: n(system.database.ms ?? 0) })
                ) : (
                  t('padmin.dash.databaseDown')
                )
              ) : (
                <Loader2 size={12} className="animate-spin" />
              )
            }
            tone={system && !system.database.ok ? 'bad' : undefined}
          />
          <Line
            label={t('padmin.dash.databaseVersion')}
            value={`PostgreSQL ${database.version} · ${bytes(database.size_bytes, fmt.number)}`}
          />
          <Line
            label={t('padmin.dash.migrations')}
            value={
              pendingMigrations === null
                ? t('padmin.dash.migrationsApplied', { count: n(database.migrations.applied) })
                : pendingMigrations.length === 0
                  ? t('padmin.dash.migrationsCurrent', { count: n(database.migrations.applied) })
                  : t('padmin.dash.migrationsPending', { count: n(pendingMigrations.length) })
            }
            tone={pendingMigrations?.length ? 'bad' : undefined}
          />
          <Line
            label={t('padmin.dash.backups')}
            value={
              !system ? (
                <Loader2 size={12} className="animate-spin" />
              ) : !system.backups ? (
                t('padmin.dash.backupsUnknown')
              ) : !system.backups.configured ? (
                t('padmin.dash.backupsOff')
              ) : system.backups.latest ? (
                t('padmin.dash.backupLatest', {
                  when: when(system.backups.latest),
                  count: n(system.backups.count),
                })
              ) : (
                t('padmin.dash.backupsNone')
              )
            }
            tone={
              system?.backups && (!system.backups.configured || !system.backups.latest)
                ? 'warn'
                : system?.backups?.latest &&
                    Date.now() - new Date(system.backups.latest).getTime() > 2 * 86_400_000
                  ? 'warn'
                  : undefined
            }
          />
          <Line
            label={t('padmin.nav.securityLog')}
            value={t('padmin.dash.logSize', {
              count: n(database.security_log.events),
              since: fmt.date(database.security_log.oldest, { dateStyle: 'medium' }),
            })}
          />
          <Line
            label={t('padmin.dash.retention')}
            value={
              database.retention_days === null
                ? t('padmin.dash.retentionForever')
                : t('padmin.dash.retentionDays', { count: n(database.retention_days) })
            }
          />
          <Line
            label={t('padmin.dash.app')}
            value={
              system
                ? t('padmin.dash.uptime', {
                    hours: n(Math.floor(system.app.uptimeSeconds / 3600)),
                    node: system.app.node,
                  })
                : '—'
            }
          />
        </dl>
        {pendingMigrations && pendingMigrations.length > 0 && (
          <div className="border-t border-border px-5 py-3 text-[0.75rem]">
            <p className="text-red-600 dark:text-red-400">{t('padmin.dash.migrationsHelp')}</p>
            <ul className="mt-1 list-inside list-disc font-mono text-[0.7rem] text-muted-foreground">
              {pendingMigrations.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="border-t border-border px-5 py-3 text-[0.72rem] text-muted-foreground">
          {t('padmin.dash.noErrorLog')}
        </p>
      </Section>

      {dialogs}
    </div>
  );
}
