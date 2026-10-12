'use client';

import React from 'react';
import Link from 'next/link';
import { Ban, ShieldAlert } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useWorkspace } from '../../lib/WorkspaceContext';

// ETNA suspended the active ERP: the database refuses its data, so say why
// instead of showing empty pages. Settings stays open for the account itself
// (password, two-factor) and the menu still switches to other ERPs.
export function SuspendedNotice({
  pathname,
  children,
}: {
  pathname: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const { active } = useWorkspace();
  if (pathname.startsWith('/erp/settings')) return <>{children}</>;
  if (active?.needsTwoFactor && !active.suspended) {
    // The database gives nothing in this ERP without a two-factor session.
    return (
      <div className="mx-auto max-w-xl p-6">
        <section className="flex items-start gap-3 rounded-xl border border-border bg-card px-5 py-4">
          <ShieldAlert size={16} className="mt-0.5 text-amber-600 dark:text-amber-400" />
          <div className="space-y-2">
            <h1 className="text-[0.9rem] font-semibold text-foreground">
              {t('erp.twoFactor.title', { name: active.name })}
            </h1>
            <p className="text-[0.8rem] text-muted-foreground">
              {t(active.needsTwoFactor === 'role' ? 'erp.twoFactor.role' : 'erp.twoFactor.erp')}
            </p>
            <Link
              href="/erp/settings"
              className="inline-block rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground"
            >
              {t('erp.twoFactor.open')}
            </Link>
          </div>
        </section>
      </div>
    );
  }
  if (!active?.suspended) return <>{children}</>;
  return (
    <div className="mx-auto max-w-xl p-6">
      <section className="flex items-start gap-3 rounded-xl border border-border bg-card px-5 py-4">
        <Ban size={16} className="mt-0.5 text-red-600 dark:text-red-400" />
        <div className="space-y-1">
          <h1 className="text-[0.9rem] font-semibold text-foreground">
            {t('erp.suspended.title', { name: active.name })}
          </h1>
          <p className="text-[0.8rem] text-muted-foreground">{t('erp.suspended.body')}</p>
        </div>
      </section>
    </div>
  );
}
