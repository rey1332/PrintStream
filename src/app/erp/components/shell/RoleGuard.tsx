'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useWorkspace } from '../../lib/WorkspaceContext';
import { currentNavItem, firstAllowedHref, navItemAllowed } from './nav';

export function RoleGuard({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const { can, hasModule, hrReady } = useWorkspace();
  const { t } = useI18n();
  const router = useRouter();
  const current = currentNavItem(pathname);
  const allowed = !current || navItemAllowed(current, can, hasModule);
  const moduleOff = !!current?.module && !hasModule(current.module);
  const home = firstAllowedHref(can, hasModule);
  const redirect = !allowed && pathname === '/erp';
  // HR pages depend on the workspace's HR settings, loaded after the role.
  const waitingForHr =
    !allowed && !hrReady && !!current?.requires?.some((c) => c.startsWith('hr.'));

  useEffect(() => {
    if (redirect) router.replace(home);
  }, [redirect, home, router]);

  if (allowed) return <>{children}</>;
  if (waitingForHr)
    return (
      <p className="text-[0.8125rem] text-muted-foreground" role="status">
        {t('common.loading')}
      </p>
    );
  if (redirect)
    return (
      <p className="text-[0.8125rem] text-muted-foreground" role="status">
        {t('common.loading')}
      </p>
    );
  return (
    <div
      className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-card p-6 text-center"
      role="alert"
    >
      <Lock size={20} className="mx-auto text-muted-foreground" aria-hidden />
      <h1 className="mt-3 text-[1rem] font-semibold text-foreground">{t('erp.noAccess.title')}</h1>
      <p className="mt-1 text-[0.8125rem] text-muted-foreground">
        {t(moduleOff ? 'industry.moduleOff' : 'erp.noAccess.body')}
      </p>
      <Link
        href={home}
        className="mt-4 inline-flex rounded-lg bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground"
      >
        {t('erp.noAccess.go')}
      </Link>
    </div>
  );
}
