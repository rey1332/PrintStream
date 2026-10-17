'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Building2,
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  FolderClosed,
  Paperclip,
  Plus,
  ArrowLeftRight,
  TerminalSquare,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { cx, sidebarRowCls } from '@/components/refined/RefinedSidebar';
import type { ErpDirectory } from '@/lib/workspaces/directory';
import { useTerminalSpaces } from '@/lib/workspaces/terminalSpaces';
import { AddModulesDialog } from './AddModulesDialog';

export interface FileActions {
  onExport?: () => void;
}

type Variant = 'refined' | 'legacy';

const FILE_OPEN_KEY = 'etna.sidebar.fileOpen';

function rowClass(variant: Variant, iconOnly: boolean, active = false): string {
  if (variant === 'legacy') return cx('sidebar-item w-full', active && 'active');
  return cx(
    sidebarRowCls,
    iconOnly && 'justify-center px-0',
    active
      ? 'bg-[var(--nav-active-bg)] font-medium text-[var(--nav-active-fg)]'
      : 'text-muted-foreground hover:bg-surface-3 hover:text-foreground'
  );
}

const subRowClass =
  'flex w-full items-center gap-2 rounded-[var(--radius)] pl-7 pr-2 h-10 lg:h-7 text-[0.78rem] text-muted-foreground hover:bg-surface-3 hover:text-foreground';

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-7 pb-0.5 pt-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
      {children}
    </p>
  );
}

interface HomeNavProps {
  variant: Variant;
  iconOnly: boolean;
  directory: ErpDirectory;
  fileActions?: FileActions;
  onExpand: () => void;
}

export function HomeNav({ variant, iconOnly, directory, fileActions, onExpand }: HomeNavProps) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [fileOpen, setFileOpen] = useState(false);
  const [modulesOpen, setModulesOpen] = useState(false);
  const { erps, quota, activeId, ready, failed } = directory;
  const terminalSpaces = useTerminalSpaces();

  // Remember whether File was open (a convenience only).
  useEffect(() => {
    try {
      setFileOpen(window.localStorage.getItem(FILE_OPEN_KEY) === '1');
    } catch {
      // Storage unavailable: File starts closed.
    }
  }, []);
  const toggleFile = (next: boolean) => {
    setFileOpen(next);
    try {
      window.localStorage.setItem(FILE_OPEN_KEY, next ? '1' : '0');
    } catch {
      // Not remembered.
    }
  };

  const openErp = (id: string) => {
    directory.select(id);
    setModulesOpen(false);
    router.push('/erp');
  };

  // Terminal opens on its own screen; choosing one there does not change the ERP.
  const openTerminal = (id: string) => {
    terminalSpaces.select(id);
    setModulesOpen(false);
    router.push('/terminal');
  };
  const terminals = terminalSpaces.spaces;
  const activeTerminal = terminalSpaces.activeId;
  const inTerminal = pathname === '/terminal' || pathname.startsWith('/terminal/');

  const label = (text: string) => (
    <span className={cx('flex-1 truncate text-left', iconOnly && 'sr-only')}>{text}</span>
  );
  const quotaText = quota ? `${quota.used}/${quota.limit}` : '';
  const FolderIcon = fileOpen && !iconOnly ? FolderOpen : FolderClosed;

  return (
    <>
      <div>
        <button
          type="button"
          onClick={() => {
            if (iconOnly) {
              toggleFile(true);
              onExpand();
            } else {
              toggleFile(!fileOpen);
            }
          }}
          aria-expanded={!iconOnly && fileOpen}
          aria-controls="sidebar-file-menu"
          title={iconOnly ? t('nav.file') : undefined}
          className={rowClass(variant, iconOnly)}
        >
          <FolderIcon size={variant === 'legacy' ? 15 : 16} className="shrink-0" aria-hidden />
          {label(t('nav.file'))}
          {!iconOnly && (
            <ChevronDown
              size={13}
              className={cx('shrink-0 transition-transform', !fileOpen && '-rotate-90')}
              aria-hidden
            />
          )}
        </button>

        {!iconOnly && fileOpen && (
          <div id="sidebar-file-menu" className="mt-0.5 space-y-0.5">
            <SubHeading>{t('nav.file.myErps')}</SubHeading>
            {!ready ? (
              <p className="pl-7 text-[0.72rem] text-muted-foreground">{t('common.loading')}</p>
            ) : failed ? (
              <p className="pl-7 text-[0.72rem] text-muted-foreground">
                {t('nav.file.loadFailed')}
              </p>
            ) : erps.length === 0 ? (
              <p className="pl-7 text-[0.72rem] text-muted-foreground">{t('nav.file.noErps')}</p>
            ) : (
              <ul className="space-y-0.5">
                {erps.map((erp) => {
                  const current = erp.id === activeId;
                  return (
                    <li key={erp.id}>
                      <button
                        type="button"
                        onClick={() => openErp(erp.id)}
                        aria-current={current ? 'true' : undefined}
                        title={erp.name}
                        className={cx(subRowClass, current && 'text-foreground font-medium')}
                      >
                        <Building2 size={13} className="shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-left">{erp.name}</span>
                        {current && (
                          <Check size={12} className="shrink-0" aria-label={t('nav.file.active')} />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <Link href="/erp/sync" className={subRowClass}>
              <ArrowLeftRight size={13} className="shrink-0" aria-hidden />
              <span className="truncate">{t('nav.file.manageErps')}</span>
            </Link>

            {fileActions?.onExport && (
              <>
                <SubHeading>{t('nav.file.export')}</SubHeading>
                <button type="button" onClick={fileActions.onExport} className={subRowClass}>
                  <Download size={13} className="shrink-0" aria-hidden />
                  <span className="truncate">{t('nav.file.exportErp')}</span>
                </button>
              </>
            )}

            <SubHeading>{t('nav.file.documents')}</SubHeading>
            <Link href="/erp/documents" className={subRowClass}>
              <Paperclip size={13} className="shrink-0" aria-hidden />
              <span className="truncate">{t('nav.file.documents')}</span>
            </Link>
          </div>
        )}
      </div>

      {terminalSpaces.ready &&
        (iconOnly || terminals.length === 0 ? (
          <button
            type="button"
            onClick={() =>
              terminals.length
                ? openTerminal(activeTerminal ?? terminals[0].id)
                : router.push('/terminal')
            }
            title={t('nav.terminal')}
            className={rowClass(variant, iconOnly, inTerminal)}
          >
            <TerminalSquare
              size={variant === 'legacy' ? 15 : 16}
              className="shrink-0"
              aria-hidden
            />
            {label(t('nav.terminal'))}
          </button>
        ) : (
          <div>
            <p
              className={cx(
                rowClass(variant, false, false),
                'pointer-events-none',
                inTerminal && 'text-foreground'
              )}
            >
              <TerminalSquare
                size={variant === 'legacy' ? 15 : 16}
                className="shrink-0"
                aria-hidden
              />
              {label(t('nav.terminal'))}
            </p>
            <ul className="mt-0.5 space-y-0.5">
              {terminals.map((space) => {
                const current = inTerminal && space.id === activeTerminal;
                return (
                  <li key={space.id}>
                    <button
                      type="button"
                      onClick={() => openTerminal(space.id)}
                      aria-current={current ? 'page' : undefined}
                      title={
                        space.kind === 'erp' ? `${space.name} · ${t('terminal.ofErp')}` : space.name
                      }
                      className={cx(subRowClass, current && 'text-foreground font-medium')}
                    >
                      {space.kind === 'erp' ? (
                        <Building2 size={13} className="shrink-0" aria-hidden />
                      ) : (
                        <TerminalSquare size={13} className="shrink-0" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate text-left">{space.name}</span>
                      {current && <Check size={12} className="shrink-0" aria-hidden />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

      <button
        type="button"
        onClick={() => {
          setModulesOpen(true);
          void directory.refresh();
        }}
        aria-haspopup="dialog"
        title={iconOnly ? `${t('nav.addModules')} (${quotaText})` : undefined}
        className={rowClass(variant, iconOnly)}
      >
        <Plus size={variant === 'legacy' ? 15 : 16} className="shrink-0" aria-hidden />
        {label(t('nav.addModules'))}
        {!iconOnly && quotaText && (
          <span
            className={cx(
              'shrink-0 rounded-full px-1.5 py-px text-[0.625rem] font-medium tabular-nums',
              quota && !quota.canJoin
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                : 'bg-surface-3 text-muted-foreground'
            )}
            aria-label={t('modules.used', { used: quota?.used ?? 0, limit: quota?.limit ?? 0 })}
          >
            {quotaText}
          </span>
        )}
      </button>

      {modulesOpen && (
        <AddModulesDialog
          directory={directory}
          onOpenErp={openErp}
          onOpenTerminal={openTerminal}
          onClose={() => {
            setModulesOpen(false);
            // Terminal may have been added to or removed from an ERP.
            void terminalSpaces.refresh();
          }}
        />
      )}
    </>
  );
}
