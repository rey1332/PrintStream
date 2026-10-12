'use client';

import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, GitCommitVertical, Upload } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { WorkflowDetail } from '@/lib/workflow/storage';

interface Props {
  detail: WorkflowDetail | null;
  dirty: boolean;
  canEdit: boolean;
  onSaveVersion: (note: string, publish: boolean) => Promise<void>;
  onPublish: (versionId: string, version: number) => Promise<void>;
  onRestore: (versionId: string, version: number) => Promise<void>;
}

const pill = 'px-2 py-0.5 rounded-full text-[0.62rem] font-medium whitespace-nowrap';

export default function VersionBar({
  detail,
  dirty,
  canEdit,
  onSaveVersion,
  onPublish,
  onRestore,
}: Props) {
  const { t, fmt } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [note, setNote] = useState('');
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!dialogOpen) return;
    dialogRef.current?.querySelector('textarea')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDialogOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialogOpen]);

  if (!detail) return null;
  const published = detail.published;
  // Unsaved edits always differ from what was published.
  const differs = published && (dirty || !published.draftMatches);

  const submit = async () => {
    setBusy(true);
    try {
      await onSaveVersion(note.trim(), publish);
      setDialogOpen(false);
      setNote('');
      setPublish(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span
        className={`${pill} ${dirty ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300' : 'bg-[var(--surface-3)] text-muted-foreground'}`}
      >
        {dirty ? t('wf.ver.unsavedChanges') : `${t('wf.ver.draft')} · ${t('wf.ver.savedDraft')}`}
      </span>
      <span
        className={`${pill} ${!published ? 'bg-[var(--surface-3)] text-muted-foreground' : differs ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300' : 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300'}`}
      >
        {!published
          ? t('wf.ver.notPublished')
          : differs
            ? t('wf.ver.differs', { version: published.version })
            : t('wf.ver.matches', { version: published.version })}
      </span>

      {detail.versionsAvailable && (
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[0.7rem] border border-border hover:bg-[var(--surface-3)]"
          >
            <GitCommitVertical size={12} />
            {t('wf.ver.versions')} ({fmt.number(detail.versions.length)})
            <ChevronDown size={11} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute z-50 mt-1 w-80 max-h-80 overflow-y-auto rounded-lg border border-border bg-card shadow-xl p-1"
            >
              {canEdit && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setDialogOpen(true);
                  }}
                  className="w-full text-left px-2 py-1.5 rounded text-[0.72rem] font-medium text-foreground hover:bg-[var(--surface-3)]"
                >
                  {t('wf.ver.saveVersion')}…
                </button>
              )}
              {detail.versions.length === 0 && (
                <p className="px-2 py-2 text-[0.7rem] text-muted-foreground">{t('wf.ver.none')}</p>
              )}
              {detail.versions.map((v) => (
                <div key={v.id} className="px-2 py-1.5 rounded hover:bg-[var(--surface-2)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.72rem] font-semibold text-foreground">
                      v{v.version}
                      {published?.id === v.id && (
                        <span className="ml-1.5 text-[0.6rem] font-normal text-green-700 dark:text-green-400">
                          {t('wf.ver.current')}
                        </span>
                      )}
                    </span>
                    <span className="text-[0.62rem] text-muted-foreground">
                      {fmt.dateTime(v.created_at)}
                    </span>
                  </div>
                  {v.note && (
                    <p className="text-[0.66rem] text-muted-foreground break-words">{v.note}</p>
                  )}
                  {canEdit && (
                    <div className="mt-1 flex gap-3 text-[0.66rem]">
                      <button
                        type="button"
                        role="menuitem"
                        className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                        onClick={() => {
                          setMenuOpen(false);
                          void onRestore(v.id, v.version);
                        }}
                      >
                        {t('wf.ver.restore')}
                      </button>
                      {published?.id !== v.id && (
                        <button
                          type="button"
                          role="menuitem"
                          className="text-muted-foreground hover:text-foreground underline underline-offset-2"
                          onClick={() => {
                            setMenuOpen(false);
                            void onPublish(v.id, v.version);
                          }}
                        >
                          {t('wf.ver.publishThis')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {canEdit && detail.versionsAvailable && (
        <button
          type="button"
          onClick={() => {
            setPublish(true);
            setDialogOpen(true);
          }}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[0.7rem] border border-border hover:bg-[var(--surface-3)]"
        >
          <Upload size={12} />
          {t('wf.ver.publish')}
        </button>
      )}

      {dialogOpen && (
        <div
          className="overlay-mobile fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onMouseDown={() => setDialogOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-version-title"
            className="w-full max-w-sm rounded-xl border border-border bg-card p-5 space-y-3 shadow-2xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 id="save-version-title" className="text-[0.95rem] font-semibold text-foreground">
              {t('wf.ver.saveTitle')}
            </h2>
            <p className="text-[0.75rem] text-muted-foreground">{t('wf.ver.saveBody')}</p>
            <label htmlFor="version-note" className="block text-[0.7rem] text-muted-foreground">
              {t('wf.ver.note')}
            </label>
            <textarea
              id="version-note"
              value={note}
              maxLength={500}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[0.78rem] text-foreground outline-none focus:border-foreground/40"
            />
            <label className="flex items-center gap-2 text-[0.75rem] text-foreground">
              <input
                type="checkbox"
                checked={publish}
                onChange={(e) => setPublish(e.target.checked)}
              />
              {t('wf.ver.publishToo')}
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] border border-border text-muted-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {publish ? t('wf.ver.publish') : t('wf.ver.saveVersion')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
