'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, LogOut, Menu, UsersRound } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '../../lib/WorkspaceContext';
import { WorkspacePanel } from '../WorkspacePanel';
import { capturePendingJoin } from '../../lib/pendingJoin';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import SidebarLogo from '@/components/ui/SidebarLogo';
import {
  RefinedSidebar,
  SidebarButtonRow,
  SidebarLinkRow,
  SidebarThemeRow,
  cx,
} from '@/components/refined/RefinedSidebar';
import { currentNavItem, isNavActive, navFor } from './nav';
import { RoleGuard } from './RoleGuard';
import { useErpSignOut } from './useErpSignOut';
import { ConsoleButton } from '@/components/console/ConsoleHost';

export function RefinedShell({
  children,
  pathname,
}: {
  children: React.ReactNode;
  pathname: string;
}) {
  const { user } = useAuth();
  const handleSignOut = useErpSignOut();
  const { ready, active, enabled, can, hasModule } = useWorkspace();
  const { isDesktop } = useUiMode();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // An invitation link (/erp#join=…) opens the workspace panel with the code filled in.
  useEffect(() => {
    if (capturePendingJoin()) setWorkspaceOpen(true);
  }, []);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // The drawer closes after navigating, and when the screen becomes desktop-wide.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (isDesktop) setMobileOpen(false);
  }, [isDesktop]);

  // Escape closes the workspace panel.
  useEffect(() => {
    if (!workspaceOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWorkspaceOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workspaceOpen]);

  const current = currentNavItem(pathname);

  return (
    <div className="ui-refined erp-workbench flex h-[100dvh] w-full overflow-hidden bg-background text-foreground">
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={closeMobile}
          aria-hidden
        />
      )}

      <RefinedSidebar
        id="erp-navigation"
        label={t('shell.navigation')}
        groups={navFor(can, hasModule)}
        isActive={(href) => isNavActive(href, pathname)}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobile}
        restoreFocusTo={menuButtonRef}
        brand={(iconOnly) => (
          <Link
            href="/erp"
            className={cx('flex min-w-0 items-center gap-2', iconOnly && 'w-full justify-center')}
            aria-label={t('shell.erpHome')}
          >
            <SidebarLogo height={22} />
            {!iconOnly && (
              <>
                <span className="text-[0.75rem] text-surface-5" aria-hidden>
                  /
                </span>
                <span className="text-[0.8125rem] font-semibold text-foreground">ERP</span>
              </>
            )}
          </Link>
        )}
        footer={(iconOnly) => (
          <>
            <SidebarLinkRow
              href="/"
              icon={ChevronLeft}
              label={t('shell.backToEtna')}
              iconOnly={iconOnly}
            />
            <SidebarThemeRow iconOnly={iconOnly} />
            {user && (
              <SidebarButtonRow
                onClick={handleSignOut}
                icon={LogOut}
                label={t('shell.signOut')}
                iconOnly={iconOnly}
              />
            )}
          </>
        )}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header
          className="shrink-0 border-b border-border bg-card"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div
            className="flex h-12 items-center gap-1 px-1.5 lg:gap-3 lg:px-4"
            style={{ paddingRight: 'max(0.375rem, env(safe-area-inset-right))' }}
          >
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label={t('shell.openMenu')}
              aria-expanded={mobileOpen}
              aria-controls="erp-navigation"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-surface-3 hover:text-foreground lg:hidden"
            >
              <Menu size={18} />
            </button>
            <p className="min-w-0 flex-1 truncate text-[0.875rem] font-semibold text-foreground">
              {current ? t(current.label) : 'ERP'}
            </p>
            {user && (
              <span className="hidden max-w-[200px] truncate text-[0.75rem] text-muted-foreground md:block">
                {user.email}
              </span>
            )}
            <ConsoleButton />
            <button
              type="button"
              onClick={() => setWorkspaceOpen((open) => !open)}
              aria-expanded={workspaceOpen}
              aria-label={t('erp.workspaceAndMembers')}
              title={t('erp.workspaceAndMembers')}
              className={cx(
                'inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius)] border px-2.5 text-[0.75rem] transition-colors lg:h-8',
                workspaceOpen
                  ? 'border-[var(--primary)] bg-[var(--nav-active-bg)] text-[var(--nav-active-fg)]'
                  : 'border-border text-muted-foreground hover:bg-surface-3 hover:text-foreground'
              )}
            >
              <UsersRound size={15} aria-hidden />
              <span className="hidden max-w-[160px] truncate md:inline">
                {enabled && active
                  ? `${active.name} · ${active.customRoleName ?? t(`role.${active.role}`)}`
                  : t('erp.workspaceButton')}
              </span>
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-auto overscroll-contain bg-background">
          <div
            className="mx-auto max-w-screen-2xl px-3 py-4 sm:px-4 lg:px-6 lg:py-6"
            style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
          >
            {ready ? (
              // Remount the page when the workspace changes so it reloads in the new scope.
              <React.Fragment key={active?.id ?? 'personal'}>
                <RoleGuard pathname={pathname}>{children}</RoleGuard>
              </React.Fragment>
            ) : (
              <p className="text-[0.8125rem] text-muted-foreground" role="status">
                {t('erp.loadingWorkspace')}
              </p>
            )}
          </div>
        </main>
      </div>

      {workspaceOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setWorkspaceOpen(false)}
            aria-hidden
          />
          <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
        </>
      )}
    </div>
  );
}
