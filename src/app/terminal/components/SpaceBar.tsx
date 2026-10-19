'use client';

// The Terminal's own people and life (20261012000043, 044): members,
// invitations and roles (the same panel as an ERP's), the ERPs it is linked
// to, and deleting it (its Owner, with the password).

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Building2, Link2, Loader2, Trash2, Users } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useWorkspace } from '@/app/erp/lib/WorkspaceContext';
import { WorkspacePanel } from '@/app/erp/components/WorkspacePanel';
import { DeleteErpSection } from '@/app/erp/components/DeleteErpSection';
import type { TerminalSpace } from '@/lib/workspaces/terminalSpaces';
import { useErpDirectory } from '@/lib/workspaces/directory';
import { terminalApi } from '@/lib/terminal/client';
import { Dialog, buttonCls, errorMessage, inputCls, primaryCls } from './shared';

export function SpaceBar({
  space,
  onGone,
  compact = false,
}: {
  space: TerminalSpace;
  onGone: () => void;
  /** In the workbench's tab strip: small, without a row of its own. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { active } = useWorkspace();
  const [members, setMembers] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [linking, setLinking] = useState(false);
  // An ERP's members are managed in the ERP.
  if (space.kind !== 'terminal' || !active) return null;
  return (
    <div
      className={
        compact
          ? 'flex shrink-0 items-center gap-0.5 [&_button]:h-6 [&_button]:gap-1 [&_button]:rounded-[2px] [&_button]:border-0 [&_button]:px-1.5 [&_button]:py-0 [&_button]:text-[11px] [&_button]:font-normal [&_button]:text-[var(--wb-text-2)] [&_button:hover]:bg-[var(--wb-hover)] [&_button:hover]:text-[var(--wb-text)]'
          : 'mb-3 flex flex-wrap justify-end gap-1.5'
      }
    >
      <button
        type="button"
        className={buttonCls}
        onClick={() => setMembers(true)}
        title={t('terminal.members')}
      >
        <Users size={12} /> {t('terminal.members')}
      </button>
      <button
        type="button"
        className={buttonCls}
        onClick={() => setLinking(true)}
        title={t('terminal.erps')}
      >
        <Link2 size={12} /> {t('terminal.erps')}
      </button>
      {space.isOwner && (
        <button
          type="button"
          className={`${buttonCls} hover:text-red-500`}
          onClick={() => setDeleting(true)}
          title={t('settings.deleteTerminal')}
        >
          <Trash2 size={12} /> {t('settings.deleteTerminal')}
        </button>
      )}
      {members && (
        <WorkspacePanel
          onClose={() => {
            setMembers(false);
            // Renamed, or left: the list changes.
            onGone();
          }}
        />
      )}
      {linking && (
        <ErpLinksDialog
          workspaceId={space.id}
          canManage={space.canManage}
          onClose={() => setLinking(false)}
        />
      )}
      {deleting && (
        <Dialog title={t('settings.deleteTerminal')} onClose={() => setDeleting(false)}>
          <DeleteErpSection
            workspaceId={space.id}
            name={space.name}
            noun="terminal"
            inputClassName={inputCls}
            onDeleted={() => {
              setDeleting(false);
              onGone();
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

interface ErpLink {
  id: string;
  erpId: string;
  name: string;
  member: boolean;
}

/**
 * The ERPs this Terminal's pipelines may read and add to. Linking needs
 * managing the Terminal's connections and being the ERP's Owner or an Admin
 * (both with two-factor); every run still uses its runner's rights in the ERP.
 */
function ErpLinksDialog({
  workspaceId,
  canManage,
  onClose,
}: {
  workspaceId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const directory = useErpDirectory();
  const [links, setLinks] = useState<ErpLink[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setLinks(await terminalApi<ErpLink[]>('erpLinks.list', { workspaceId }));
    } catch (e) {
      toast.error(errorMessage(e, t));
      setLinks([]);
    }
  }, [workspaceId, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const linkable = directory.erps.filter(
    (e) => (e.role === 'owner' || e.role === 'admin') && !links?.some((l) => l.erpId === e.id)
  );

  const act = async (action: string, payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      await terminalApi(action, payload);
      setPick('');
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('terminal.erps')} onClose={onClose}>
      <p className="text-[0.75rem] text-muted-foreground">{t('terminal.erpsIntro')}</p>
      {!links ? (
        <div className="h-16 rounded-lg animate-pulse bg-[var(--surface-3)]" />
      ) : links.length === 0 ? (
        <p className="text-[0.75rem] text-muted-foreground">{t('terminal.erpsNone')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {links.map((l) => (
            <li key={l.id} className="flex items-center gap-2 px-3 py-2 text-[0.8rem]">
              <Building2 size={14} className="shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-foreground">{l.name}</span>
              {!l.member && (
                <span className="text-[0.68rem] text-amber-700 dark:text-amber-400">
                  {t('terminal.erpsNotMember')}
                </span>
              )}
              {canManage && (
                <button
                  type="button"
                  disabled={busy}
                  className={`${buttonCls} hover:text-red-500`}
                  onClick={() =>
                    confirm(t('terminal.erpsRemoveConfirm', { name: l.name })) &&
                    void act('erpLink.remove', { id: l.id })
                  }
                >
                  <Trash2 size={11} /> {t('terminal.erpsRemove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="flex gap-2">
          <select
            className={inputCls}
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            aria-label={t('terminal.erpsPick')}
            style={{ colorScheme: 'light dark' }}
          >
            <option value="">
              {linkable.length ? t('terminal.erpsPick') : t('terminal.erpsNoneToLink')}
            </option>
            {linkable.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={primaryCls}
            disabled={!pick || busy}
            onClick={() => void act('erpLink.add', { workspaceId, erpWorkspaceId: pick })}
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}{' '}
            {t('terminal.erpsLink')}
          </button>
        </div>
      )}
    </Dialog>
  );
}
