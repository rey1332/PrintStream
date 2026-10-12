'use client';

import React, { useEffect, useState } from 'react';
import { Info, TriangleAlert, Wrench, X } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useWorkspace } from '../../lib/WorkspaceContext';

interface Announcement {
  id: string;
  message: string;
  level: 'info' | 'warning' | 'maintenance';
  workspace_id: string | null;
}

const HIDDEN_KEY = 'etna.announcements.hidden';
const REFRESH_MS = 10 * 60_000;

function readHidden(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(-50) : [];
  } catch {
    return [];
  }
}

const STYLE = {
  info: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-200',
  warning:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200',
  maintenance:
    'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200',
} as const;
const ICON = { info: Info, warning: TriangleAlert, maintenance: Wrench } as const;

/** Announcements from ETNA's admins (admin panel → Announcements), for everyone or this ERP. */
export function AnnouncementBanner() {
  const { t } = useI18n();
  const { active } = useWorkspace();
  const [items, setItems] = useState<Announcement[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    setHidden(readHidden());
    let cancelled = false;
    const load = () =>
      createClient()
        .rpc('erp_my_announcements')
        .then(({ data, error }) => {
          // Missing function = announcements not installed yet: nothing to show.
          if (!cancelled && !error && Array.isArray(data)) setItems(data as Announcement[]);
        });
    void load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const shown = items.filter(
    (a) => !hidden.includes(a.id) && (a.workspace_id === null || a.workspace_id === active?.id)
  );
  if (shown.length === 0) return null;

  function hide(id: string) {
    const next = [...hidden, id];
    setHidden(next);
    try {
      window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next.slice(-50)));
    } catch {
      // Storage unavailable: hidden until the page reloads.
    }
  }

  return (
    <div className="mb-4 space-y-2">
      {shown.map((a) => {
        const Icon = ICON[a.level] ?? Info;
        return (
          <div
            key={a.id}
            role="status"
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[0.8rem] ${STYLE[a.level] ?? STYLE.info}`}
          >
            <Icon size={14} className="mt-0.5 shrink-0" aria-hidden />
            <p className="flex-1 whitespace-pre-line">{a.message}</p>
            <button
              type="button"
              onClick={() => hide(a.id)}
              aria-label={t('erp.announcement.dismiss')}
              title={t('erp.announcement.dismiss')}
              className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 max-lg:p-2"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
