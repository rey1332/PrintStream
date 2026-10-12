'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChevronsLeft, ChevronsRight, Moon, Sun, X } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useUiMode } from '@/lib/ui/UiModeProvider';

export const cx = (...classes: (string | false | null | undefined)[]) =>
  classes.filter(Boolean).join(' ');

export const sidebarRowCls =
  'flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 h-11 lg:h-8 text-[0.8125rem] transition-colors';
const quietRowCls = `${sidebarRowCls} text-muted-foreground hover:bg-surface-3 hover:text-foreground`;

export interface RefinedNavItem {
  icon: React.ElementType;
  label: MessageKey;
  href: string;
}

export interface RefinedNavGroup {
  title?: MessageKey;
  items: RefinedNavItem[];
}

interface RowProps {
  icon: React.ElementType;
  label: string;
  iconOnly: boolean;
}

export function SidebarLinkRow({ href, icon: Icon, label, iconOnly }: RowProps & { href: string }) {
  return (
    <Link
      href={href}
      title={iconOnly ? label : undefined}
      className={cx(quietRowCls, iconOnly && 'justify-center px-0')}
    >
      <Icon size={15} className="shrink-0" aria-hidden />
      <span className={cx('truncate', iconOnly && 'sr-only')}>{label}</span>
    </Link>
  );
}

export function SidebarButtonRow({
  onClick,
  icon: Icon,
  label,
  iconOnly,
}: RowProps & { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={iconOnly ? label : undefined}
      className={cx(quietRowCls, iconOnly && 'justify-center px-0')}
    >
      <Icon size={15} className="shrink-0" aria-hidden />
      <span className={cx('truncate', iconOnly && 'sr-only')}>{label}</span>
    </button>
  );
}

export function SidebarThemeRow({ iconOnly }: { iconOnly: boolean }) {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();
  useEffect(() => setMounted(true), []);
  const isDark = resolvedTheme === 'dark';
  const label = mounted && isDark ? t('shell.lightMode') : t('shell.darkMode');

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      title={iconOnly ? t('shell.toggleTheme') : undefined}
      className={cx(quietRowCls, iconOnly && 'justify-center px-0')}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
        {mounted && (isDark ? <Sun size={15} /> : <Moon size={15} />)}
      </span>
      <span className={cx('truncate', iconOnly && 'sr-only')}>{label}</span>
    </button>
  );
}

interface RefinedSidebarProps {
  id: string;
  label: string;
  brand: (iconOnly: boolean) => React.ReactNode;
  groups: RefinedNavGroup[];
  isActive: (href: string) => boolean;
  top?: (iconOnly: boolean) => React.ReactNode;
  navExtra?: (iconOnly: boolean) => React.ReactNode;
  footer: (iconOnly: boolean) => React.ReactNode;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  restoreFocusTo?: React.RefObject<HTMLElement | null>;
}

export function RefinedSidebar({
  id,
  label,
  brand,
  groups,
  isActive,
  top,
  navExtra,
  footer,
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onMobileClose,
  restoreFocusTo,
}: RefinedSidebarProps) {
  const { t } = useI18n();
  const { isDesktop } = useUiMode();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Escape closes the drawer.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onMobileClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);

  // Focus moves into the drawer when it opens and back when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (mobileOpen) closeButtonRef.current?.focus();
    else if (wasOpen.current) restoreFocusTo?.current?.focus();
    wasOpen.current = mobileOpen;
  }, [mobileOpen, restoreFocusTo]);

  // Collapsing only applies on desktop; the phone drawer always shows labels.
  const iconOnly = collapsed && isDesktop;

  return (
    <aside
      id={id}
      aria-label={label}
      inert={!isDesktop && !mobileOpen}
      className={cx(
        'fixed inset-y-0 left-0 z-50 flex h-full w-[min(18rem,85vw)] flex-col border-r border-border bg-card',
        'transition-[transform,width] duration-200 ease-out lg:relative lg:translate-x-0',
        mobileOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full',
        collapsed ? 'lg:w-14' : 'lg:w-56'
      )}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
      }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        {brand(iconOnly)}
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onMobileClose}
          aria-label={t('shell.closeMenu')}
          className="-mr-1.5 inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-surface-3 hover:text-foreground lg:hidden"
        >
          <X size={18} />
        </button>
      </div>

      {top && <div className="shrink-0 px-2 pt-3">{top(iconOnly)}</div>}

      <nav
        className={cx(
          'flex-1 space-y-4 overflow-y-auto overflow-x-hidden px-2',
          top ? 'pb-3 pt-2' : 'py-3'
        )}
      >
        {groups.map((group, index) => (
          <div key={group.title ?? `group-${index}`}>
            {group.title && (
              <p
                className={cx(
                  'mb-1 px-2.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground',
                  iconOnly && 'sr-only'
                )}
              >
                {t(group.title)}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      title={iconOnly ? t(item.label) : undefined}
                      className={cx(
                        sidebarRowCls,
                        iconOnly && 'justify-center px-0',
                        active
                          ? 'bg-[var(--nav-active-bg)] font-medium text-[var(--nav-active-fg)]'
                          : 'text-muted-foreground hover:bg-surface-3 hover:text-foreground'
                      )}
                    >
                      <Icon size={16} className="shrink-0" aria-hidden />
                      <span className={cx('truncate', iconOnly && 'sr-only')}>{t(item.label)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {navExtra && <div className="!mt-0.5 space-y-0.5">{navExtra(iconOnly)}</div>}
      </nav>

      <div className="shrink-0 space-y-0.5 border-t border-border p-2">
        {footer(iconOnly)}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-controls={id}
          title={collapsed ? t('shell.expand') : undefined}
          className={cx(quietRowCls, 'hidden lg:flex', iconOnly && 'justify-center px-0')}
        >
          {collapsed ? (
            <ChevronsRight size={15} aria-hidden />
          ) : (
            <ChevronsLeft size={15} aria-hidden />
          )}
          <span className={cx('truncate', iconOnly && 'sr-only')}>
            {collapsed ? t('shell.expand') : t('shell.collapse')}
          </span>
        </button>
      </div>
    </aside>
  );
}
