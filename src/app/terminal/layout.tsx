'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, TerminalSquare } from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import { useErpDirectory } from '@/lib/workspaces/directory';
import { useTerminalSpaces } from '@/lib/workspaces/terminalSpaces';
import { NewTerminalButton } from '@/components/sidebar/NewTerminal';
import { SpaceBar } from './components/SpaceBar';
import { WorkbenchChrome } from './components/WorkbenchChrome';
import { WorkspaceProvider } from '@/app/erp/lib/WorkspaceContext';
import { SuspendedNotice } from '@/app/erp/components/shell/SuspendedNotice';
import { GovernanceBanner } from '@/app/erp/components/shell/GovernanceBanner';

/**
 * PrintStream Terminal on its own screen (Dashboard → Terminal): the
 * Dashboard's sidebar and the Terminal chosen there — a Terminal on its own,
 * or an ERP with Terminal added. No ERP is opened; an ERP's Terminal only
 * offers a link to it.
 */
export default function TerminalLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const refined = useUiMode().effective === 'refined';
  const directory = useErpDirectory();
  const terminals = useTerminalSpaces();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const space = terminals.spaces.find((s) => s.id === terminals.activeId) ?? null;
  // The Terminal's own screen is a workbench that fills the window (no page scroll).
  const workbench = pathname === '/terminal';
  // The workbench uses the whole window: the sidebar folds to its icons (it
  // can still be opened) and the header bar is left out (except on phones,
  // where it holds the menu button).
  useEffect(() => {
    if (workbench) setCollapsed(true);
  }, [workbench]);

  let body: React.ReactNode;
  if (!terminals.ready) {
    body = <div className="h-32 rounded-xl animate-pulse bg-[var(--surface-3)]" />;
  } else if (!space) {
    body = (
      <div className="rounded-xl border border-border bg-card p-10 text-center max-w-xl mx-auto mt-6">
        <TerminalSquare size={30} className="mx-auto text-muted-foreground mb-3 opacity-40" />
        <p className="text-[0.9rem] font-medium text-foreground mb-1">{t('terminal.none')}</p>
        <p className="text-[0.75rem] text-muted-foreground mb-4">{t('terminal.noneHint')}</p>
        <div className="flex justify-center gap-2">
          <NewTerminalButton
            onCreated={async (id) => {
              await terminals.refresh();
              terminals.select(id);
            }}
          />
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[0.78rem] font-medium border border-border hover:bg-[var(--surface-3)]"
          >
            {t('terminal.backToDashboard')}
          </Link>
        </div>
      </div>
    );
  } else {
    // A new provider per Terminal: choosing another one in the sidebar loads it.
    body = (
      <WorkspaceProvider key={space.id} workspaceId={space.id}>
        {workbench ? (
          // The Terminal's actions go in the workbench's tab strip.
          <WorkbenchChrome.Provider
            value={
              <>
                <SpaceBar space={space} onGone={() => void terminals.refresh()} compact />
                {space.kind === 'erp' && (
                  <Link
                    href="/erp"
                    onClick={() => directory.select(space.id)}
                    title={t('terminal.openErp')}
                    className="inline-flex h-6 items-center gap-1 rounded-[2px] px-1.5 text-[11px] text-[var(--wb-text-2)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)]"
                  >
                    <Building2 size={12} aria-hidden /> {t('terminal.openErp')}
                  </Link>
                )}
              </>
            }
          >
            <GovernanceBanner />
            <div className="min-h-0 flex-1">
              <SuspendedNotice pathname={pathname}>{children}</SuspendedNotice>
            </div>
          </WorkbenchChrome.Provider>
        ) : (
          <>
            <SpaceBar space={space} onGone={() => void terminals.refresh()} />
            <GovernanceBanner />
            <SuspendedNotice pathname={pathname}>{children}</SuspendedNotice>
          </>
        )}
      </WorkspaceProvider>
    );
  }

  return (
    <div
      className={`flex ${refined ? 'h-[100dvh]' : 'h-screen'} w-full overflow-hidden`}
      style={{ background: 'var(--background)' }}
    >
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={closeMobile} />
      )}
      <Sidebar
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
        activeRoute={pathname}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobile}
        refined={refined}
        restoreFocusTo={menuButtonRef}
      />
      <div
        className={
          refined
            ? 'ui-refined flex flex-col flex-1 min-w-0 overflow-hidden bg-background text-foreground'
            : 'flex flex-col flex-1 min-w-0 overflow-hidden'
        }
      >
        <header
          className={`box-content flex items-center h-12 border-b border-border bg-card px-1.5 lg:px-4 gap-1 lg:gap-3 flex-shrink-0 ${workbench && space ? 'lg:hidden' : ''}`}
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <button
            ref={menuButtonRef}
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={t('shell.openMenu')}
            aria-expanded={mobileOpen}
            aria-controls={refined ? 'home-navigation' : undefined}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-surface-3 hover:text-foreground lg:hidden"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <TerminalSquare size={16} className="hidden lg:block text-muted-foreground" aria-hidden />
          <span className="text-[0.875rem] font-semibold text-foreground">{t('nav.terminal')}</span>
          {space && (
            <>
              <div className="w-px h-5 bg-border" aria-hidden />
              <span className="min-w-0 truncate text-[0.8rem] text-muted-foreground">
                {space.name}
                {space.kind === 'erp' && ` · ${t('terminal.ofErp')}`}
              </span>
              <div className="flex-1" />
              {space.kind === 'erp' && (
                <Link
                  href="/erp"
                  onClick={() => directory.select(space.id)}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius)] px-2.5 py-1.5 text-[0.75rem] text-muted-foreground hover:bg-surface-3 hover:text-foreground"
                >
                  <Building2 size={13} aria-hidden /> {t('terminal.openErp')}
                </Link>
              )}
            </>
          )}
        </header>
        <main
          className={
            workbench && space
              ? 'terminal-wb flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--wb-app)]'
              : 'flex-1 overflow-y-auto overscroll-contain px-3 pt-4 sm:px-5 sm:pt-5'
          }
          style={
            workbench && space
              ? { paddingBottom: 'env(safe-area-inset-bottom)' }
              : { paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }
          }
        >
          {body}
        </main>
      </div>
    </div>
  );
}
