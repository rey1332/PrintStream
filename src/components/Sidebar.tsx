'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { LayoutDashboard, ChevronLeft, ChevronRight, X, Sun, Moon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useI18n } from '@/lib/i18n/I18nProvider';
import SidebarLogo from '@/components/ui/SidebarLogo';
import {
  RefinedSidebar,
  SidebarThemeRow,
  cx,
  type RefinedNavGroup,
} from '@/components/refined/RefinedSidebar';
import { useErpDirectory } from '@/lib/workspaces/directory';
import { SidebarSearch } from '@/components/sidebar/SidebarSearch';
import { HomeNav, type FileActions } from '@/components/sidebar/HomeNav';

const NAV_GROUPS: RefinedNavGroup[] = [
  { items: [{ icon: LayoutDashboard, label: 'shell.dashboard', href: '/' }] },
];

// ─── Theme Toggle (footer) ────────────────────────────────────────────
function SidebarThemeToggle({ collapsed }: { collapsed: boolean }) {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();

  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="h-[32px]" />;
  }

  const isDark = resolvedTheme === 'dark';

  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={collapsed ? t('shell.toggleTheme') : undefined}
      className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-[0.75rem] transition-all duration-150 justify-center"
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
      {isDark ? (
        <Sun size={14} className="flex-shrink-0" />
      ) : (
        <Moon size={14} className="flex-shrink-0" />
      )}
      {!collapsed && (
        <span className="truncate">{isDark ? t('shell.lightMode') : t('shell.darkMode')}</span>
      )}
    </button>
  );
}

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  activeRoute: string;
  mobileOpen: boolean;
  onMobileClose: () => void;
  refined?: boolean;
  restoreFocusTo?: React.RefObject<HTMLElement | null>;
  fileActions?: FileActions;
}

export default function Sidebar({
  collapsed,
  onToggle,
  activeRoute,
  mobileOpen,
  onMobileClose,
  refined = false,
  restoreFocusTo,
  fileActions,
}: SidebarProps) {
  const { t } = useI18n();
  const directory = useErpDirectory();
  const activeErp = directory.erps.find((w) => w.id === directory.activeId);
  const expand = () => {
    if (collapsed) onToggle();
  };

  const search = (iconOnly: boolean) => (
    <SidebarSearch
      workspaceId={directory.activeId}
      erpName={activeErp?.name ?? 'ERP'}
      iconOnly={iconOnly}
      onExpand={expand}
    />
  );

  if (refined) {
    return (
      // display: contents keeps the flex layout while scoping the refined tokens.
      <div className="ui-refined contents">
        <RefinedSidebar
          id="home-navigation"
          label={t('shell.menu')}
          groups={NAV_GROUPS}
          isActive={(href) => href === activeRoute}
          top={search}
          navExtra={(iconOnly) => (
            <HomeNav
              variant="refined"
              iconOnly={iconOnly}
              directory={directory}
              fileActions={fileActions}
              onExpand={expand}
            />
          )}
          collapsed={collapsed}
          onToggleCollapsed={onToggle}
          mobileOpen={mobileOpen}
          onMobileClose={onMobileClose}
          restoreFocusTo={restoreFocusTo}
          brand={(iconOnly) => (
            <Link
              href="/"
              className={cx('flex min-w-0 items-center', iconOnly && 'w-full justify-center')}
              aria-label={t('shell.dashboard')}
            >
              <SidebarLogo height={22} />
            </Link>
          )}
          footer={(iconOnly) => <SidebarThemeRow iconOnly={iconOnly} />}
        />
      </div>
    );
  }
  return (
    <aside
      className={[
        'theme-light flex flex-col h-full border-r z-50',
        'fixed lg:relative',
        mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        collapsed ? 'w-14' : 'w-52',
      ].join(' ')}
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--border)',
        transition: 'width 250ms ease, transform 250ms ease, background 200ms ease',
      }}
    >
      {mobileOpen && (
        <div
          className="flex items-center justify-between h-12 border-b px-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <span className="text-[0.8125rem] font-semibold" style={{ color: 'var(--foreground)' }}>
            {t('shell.menu')}
          </span>
          <button
            onClick={onMobileClose}
            className="p-1 rounded"
            style={{ color: 'var(--muted-foreground)' }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {!mobileOpen && (
        <div
          className={[
            'h-12 border-b flex items-center flex-shrink-0',
            collapsed ? 'justify-center' : 'px-3',
          ].join(' ')}
          style={{ borderColor: 'var(--border)' }}
        >
          <SidebarLogo />
        </div>
      )}

      <div className="flex-shrink-0 px-2 pt-3">{search(collapsed)}</div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden pt-2 pb-3 px-2 space-y-0.5">
        {NAV_GROUPS.flatMap((group) => group.items).map((item) => {
          const Icon = item.icon;
          const isActive = activeRoute === item.href;
          return (
            <Link
              key={`nav-${item.href}`}
              href={item.href}
              className={['sidebar-item', isActive ? 'active' : ''].join(' ')}
              title={collapsed ? t(item.label) : undefined}
            >
              <Icon size={15} className="flex-shrink-0" />
              {!collapsed && <span className="flex-1 truncate">{t(item.label)}</span>}
            </Link>
          );
        })}
        <HomeNav
          variant="legacy"
          iconOnly={collapsed}
          directory={directory}
          fileActions={fileActions}
          onExpand={expand}
        />
      </nav>

      <div
        className="border-t p-2 flex-shrink-0 space-y-1"
        style={{ borderColor: 'var(--border)' }}
      >
        <SidebarThemeToggle collapsed={collapsed} />

        <button
          onClick={onToggle}
          className="hidden lg:flex w-full items-center justify-center p-2 rounded-md transition-all duration-150"
          style={{ color: 'var(--muted-foreground)' }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-3)';
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--foreground)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            (e.currentTarget as HTMLButtonElement).style.color = 'var(--muted-foreground)';
          }}
        >
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          {!collapsed && <span className="ml-2 text-[0.75rem]">{t('shell.collapse')}</span>}
        </button>
      </div>
    </aside>
  );
}
