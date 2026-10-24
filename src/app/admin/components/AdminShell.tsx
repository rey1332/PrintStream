'use client';

// The admin panel's words: loaded here only, not sent to other pages.
import '@/lib/i18n/messages/admin';

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Eye,
  FileText,
  Landmark,
  LayoutDashboard,
  Megaphone,
  ScrollText,
  Server,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { ROLE_LABEL, type AdminRole } from './labels';
import { ReauthDialog } from './ReauthDialog';

interface AdminValue {
  email: string;
  role: AdminRole;
  /** Asks for a fresh two-factor code; resolves true once it was accepted. */
  confirmIdentity: () => Promise<boolean>;
  /** The panel's address ('/admin', or ETNA_ADMIN_PATH's; src/lib/adminPath.ts). */
  base: string;
}

const AdminCtx = createContext<AdminValue | null>(null);

export function useAdmin(): AdminValue {
  const value = useContext(AdminCtx);
  if (!value) throw new Error('useAdmin must be used within AdminShell');
  return value;
}

/** A page of the panel at its address: ap('/users') is '/admin/users' or '/<address>/users'. */
export function useAdminPath(): (path?: string) => string {
  const { base } = useAdmin();
  return useCallback((path = '') => base + path, [base]);
}

const NAV: { href: string; label: MessageKey; icon: React.ElementType }[] = [
  { href: '', label: 'padmin.nav.overview', icon: LayoutDashboard },
  { href: '/users', label: 'padmin.nav.users', icon: Users },
  { href: '/workspaces', label: 'padmin.nav.workspaces', icon: Building2 },
  { href: '/terms', label: 'padmin.nav.terms', icon: FileText },
  { href: '/security-log', label: 'padmin.nav.securityLog', icon: ScrollText },
  { href: '/access-log', label: 'padmin.nav.accessLog', icon: Eye },
  { href: '/governance', label: 'padmin.nav.governance', icon: Landmark },
  { href: '/admins', label: 'padmin.nav.admins', icon: UserCog },
  { href: '/announcements', label: 'padmin.nav.announcements', icon: Megaphone },
  { href: '/system', label: 'padmin.nav.system', icon: Server },
];

export function AdminShell({
  email,
  role,
  base,
  twoFactor,
  children,
}: {
  email: string;
  role: AdminRole;
  base: string;
  twoFactor: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  // The page within the panel ('' or '/users/…'): the server sees the
  // panel's own folder (/admin/…), the browser its address.
  const at = usePathname();
  const here = at.startsWith(base) ? at.slice(base.length) : at.replace(/^\/admin/, '');
  const [reauthOpen, setReauthOpen] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const confirmIdentity = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setReauthOpen(true);
      }),
    []
  );

  const closeReauth = (ok: boolean) => {
    setReauthOpen(false);
    pending.current?.(ok);
    pending.current = null;
  };

  return (
    <AdminCtx.Provider value={{ email, role, confirmIdentity, base }}>
      <div className="min-h-screen bg-background">
        <header className="border-b border-border bg-card">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-primary" />
              <span className="text-[0.9rem] font-semibold text-foreground">
                {t('padmin.title')}
              </span>
            </div>
            <nav className="flex flex-wrap items-center gap-1">
              {NAV.map(({ href: page, label, icon: Icon }) => {
                const href = base + page;
                const active = page === '' ? here === '' || here === '/' : here.startsWith(page);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[0.78rem] max-lg:min-h-11 ${
                      active
                        ? 'bg-[var(--surface-2)] font-medium text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Icon size={13} />
                    {t(label)}
                  </Link>
                );
              })}
            </nav>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-[0.75rem] text-muted-foreground sm:inline">{email}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[0.7rem] font-medium text-foreground">
                {t(ROLE_LABEL[role])}
              </span>
              <ThemeToggle />
              <Link
                href="/erp"
                className="flex items-center gap-1 text-[0.75rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
              >
                <ArrowLeft size={12} />
                {t('padmin.backToErp')}
              </Link>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6">
          {twoFactor ? (
            children
          ) : (
            <section className="flex items-start gap-3 rounded-xl border border-border bg-card px-5 py-4">
              <ShieldAlert size={16} className="mt-0.5 text-amber-600 dark:text-amber-400" />
              <div className="space-y-2">
                <p className="text-[0.82rem] text-foreground">{t('padmin.needsTwoFactor')}</p>
                <Link
                  href="/erp/settings"
                  className="inline-block rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground"
                >
                  {t('padmin.openSettings')}
                </Link>
              </div>
            </section>
          )}
        </main>
      </div>
      {reauthOpen && <ReauthDialog onDone={closeReauth} />}
    </AdminCtx.Provider>
  );
}
