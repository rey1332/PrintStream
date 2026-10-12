'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Menu, X, LogOut, Sun, Moon, UsersRound } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '../../lib/WorkspaceContext';
import { WorkspacePanel } from '../WorkspacePanel';
import { capturePendingJoin } from '../../lib/pendingJoin';
import { useI18n } from '@/lib/i18n/I18nProvider';
import SidebarLogo from '@/components/ui/SidebarLogo';
import { navFor } from './nav';
import { RoleGuard } from './RoleGuard';
import { useErpSignOut } from './useErpSignOut';

// ─── Theme Toggle Button ────────────────────────────────────────────────
function ThemeToggleButton({ collapsed }: { collapsed: boolean }) {
  const [mounted, setMounted] = React.useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();

  React.useEffect(() => setMounted(true), []);

  // ✅ Pakai resolvedTheme untuk baca actual state
  const isDark = resolvedTheme === 'dark';

  const handleToggle = () => setTheme(isDark ? 'light' : 'dark');

  return (
    <button
      onClick={handleToggle}
      title={collapsed ? t('shell.toggleTheme') : undefined}
      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-[0.75rem] transition-colors"
      style={{ color: 'var(--muted-foreground)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--surface-3)';
        e.currentTarget.style.color = 'var(--foreground)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--muted-foreground)';
      }}
    >
      {mounted && (isDark ? <Sun size={13} /> : <Moon size={13} />)}
      {!collapsed && <span>{mounted && isDark ? t('shell.lightMode') : t('shell.darkMode')}</span>}
    </button>
  );
}

export function LegacyShell({
  children,
  pathname,
}: {
  children: React.ReactNode;
  pathname: string;
}) {
  const { user } = useAuth();
  const handleSignOut = useErpSignOut();
  const { ready, active, enabled, can, hasModule } = useWorkspace();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // An invitation link (/erp#join=…) opens the workspace panel with the code filled in.
  useEffect(() => {
    if (capturePendingJoin()) setWorkspaceOpen(true);
  }, []);

  return (
    <div
      className="flex h-screen w-full overflow-hidden"
      style={{ background: 'var(--background)' }}
    >
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={[
          'theme-light flex flex-col h-full z-50 border-r',
          'fixed lg:relative',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          collapsed ? 'w-14' : 'w-56',
        ].join(' ')}
        style={{
          background: 'var(--card)',
          borderColor: 'var(--border)',
          transition: 'width 250ms ease, transform 250ms ease, background 200ms ease',
        }}
      >
        <div
          className="h-12 border-b flex items-center px-3 flex-shrink-0 justify-between"
          style={{ borderColor: 'var(--border)' }}
        >
          {!collapsed && (
            <div className="flex items-center gap-2">
              <SidebarLogo height={24} />
              <span className="text-[0.65rem]" style={{ color: 'var(--surface-5)' }}>
                /
              </span>
              <span className="text-[0.75rem] font-semibold" style={{ color: 'var(--foreground)' }}>
                ERP
              </span>
            </div>
          )}
          {collapsed && (
            <span className="w-full flex justify-center">
              <SidebarLogo height={24} />
            </span>
          )}
          {mobileOpen && (
            <button
              onClick={() => setMobileOpen(false)}
              className="p-1 rounded lg:hidden"
              style={{ color: 'var(--muted-foreground)' }}
            >
              <X size={14} />
            </button>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-3 px-2 space-y-4">
          {navFor(can, hasModule).map((group) => (
            <div key={group.title}>
              {!collapsed && (
                <p
                  className="text-[0.6rem] font-semibold tracking-widest uppercase px-2 mb-1.5"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  {t(group.title)}
                </p>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? t(item.label) : undefined}
                      className="flex items-center gap-2.5 px-2 py-1.5 rounded-md text-[0.8rem] transition-all duration-150"
                      style={{
                        background: isActive ? 'var(--primary)' : 'transparent',
                        color: isActive ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
                        fontWeight: isActive ? 600 : 400,
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          (e.currentTarget as HTMLAnchorElement).style.background =
                            'var(--surface-3)';
                          (e.currentTarget as HTMLAnchorElement).style.color = 'var(--foreground)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';
                          (e.currentTarget as HTMLAnchorElement).style.color =
                            'var(--muted-foreground)';
                        }
                      }}
                    >
                      <Icon size={14} className="flex-shrink-0" />
                      {!collapsed && <span className="truncate">{t(item.label)}</span>}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div
          className="border-t p-2 flex-shrink-0 space-y-1"
          style={{ borderColor: 'var(--border)' }}
        >
          {!collapsed && (
            <Link
              href="/"
              className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[0.75rem] transition-colors"
              style={{ color: 'var(--muted-foreground)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--foreground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--muted-foreground)';
              }}
            >
              <ChevronLeft size={13} />
              <span>{t('shell.backToEtna')}</span>
            </Link>
          )}

          <ThemeToggleButton collapsed={collapsed} />

          {!collapsed && user && (
            <button
              onClick={handleSignOut}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-[0.75rem] transition-colors"
              style={{ color: 'var(--muted-foreground)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--foreground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--muted-foreground)';
              }}
            >
              <LogOut size={13} />
              <span>{t('shell.signOut')}</span>
            </button>
          )}

          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex w-full items-center justify-center p-2 rounded-md transition-colors"
            style={{ color: 'var(--muted-foreground)' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--foreground)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--muted-foreground)';
            }}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            {!collapsed && <span className="ml-2 text-[0.75rem]">{t('shell.collapse')}</span>}
          </button>
        </div>
      </aside>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <header
          className="h-12 border-b flex items-center px-4 flex-shrink-0 justify-between"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
        >
          <button
            className="lg:hidden p-1.5 rounded"
            style={{ color: 'var(--muted-foreground)' }}
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={16} />
          </button>
          <div className="flex items-center gap-2"></div>
          <div className="flex items-center gap-3">
            {user && (
              <span
                className="text-[0.7rem] hidden sm:block truncate max-w-[160px]"
                style={{ color: 'var(--muted-foreground)' }}
              >
                {user.email}
              </span>
            )}
            <button
              onClick={() => setWorkspaceOpen((open) => !open)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md border text-[0.72rem] transition-colors"
              style={{
                borderColor: 'var(--border)',
                color: workspaceOpen ? 'var(--foreground)' : 'var(--muted-foreground)',
                background: workspaceOpen ? 'var(--surface-3)' : 'transparent',
              }}
              aria-expanded={workspaceOpen}
              aria-label={t('erp.workspaceAndMembers')}
              title={t('erp.workspaceAndMembers')}
            >
              <UsersRound size={13} />
              <span className="hidden md:inline truncate max-w-[140px]">
                {enabled && active
                  ? `${active.name} · ${active.customRoleName ?? t(`role.${active.role}`)}`
                  : t('erp.workspaceButton')}
              </span>
            </button>
          </div>
        </header>

        <main className="flex-1 overflow-auto" style={{ background: 'var(--background)' }}>
          <div className="max-w-screen-2xl mx-auto px-4 lg:px-6 py-6">
            {ready ? (
              // Remount the page when the workspace changes so it reloads in the new scope.
              <React.Fragment key={active?.id ?? 'personal'}>
                <RoleGuard pathname={pathname}>{children}</RoleGuard>
              </React.Fragment>
            ) : (
              <p className="text-[0.8rem] text-muted-foreground">{t('erp.loadingWorkspace')}</p>
            )}
          </div>
        </main>
      </div>

      {workspaceOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
            onClick={() => setWorkspaceOpen(false)}
          />
          <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
        </>
      )}
    </div>
  );
}
