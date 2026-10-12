'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';

export const AUTO_REFRESH_MS = 60_000;

export type AutoRefreshPause = 'unsaved' | 'issues' | null;

const pageVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

export function AutoRefreshButton({
  enabled,
  onToggle,
  className,
}: {
  enabled: boolean;
  onToggle: () => void;
  className: string;
}) {
  const { t } = useI18n();
  return (
    <button
      onClick={onToggle}
      className={`${className} ${enabled ? 'border-primary text-primary' : ''}`}
      aria-pressed={enabled}
      title={t('wf.auto.hint')}
    >
      <RefreshCw size={12} />
      <span className="max-sm:sr-only">{t('wf.auto.label')}</span>
    </button>
  );
}

interface StatusProps {
  lastRunAt: number | null;
  busy: boolean;
  refreshing: boolean;
  paused: AutoRefreshPause;
  onDue: () => void;
}

export function AutoRefreshStatus({ lastRunAt, busy, refreshing, paused, onDue }: StatusProps) {
  const { t, fmt } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(pageVisible);
  const onDueRef = useRef(onDue);
  onDueRef.current = onDue;
  const firedFor = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      setVisible(pageVisible());
    };
    const id = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  const dueAt = lastRunAt === null ? 0 : lastRunAt + AUTO_REFRESH_MS;

  useEffect(() => {
    if (busy || paused || !visible || now < dueAt || firedFor.current === lastRunAt) return;
    // One run per due time, even if this effect runs again before the run starts.
    firedFor.current = lastRunAt;
    onDueRef.current();
  }, [now, dueAt, busy, paused, visible, lastRunAt]);

  let text: React.ReactNode;
  if (refreshing)
    text = (
      <>
        <Loader2 size={10} className="inline animate-spin mr-1" />
        {t('wf.auto.refreshing')}
      </>
    );
  else if (paused)
    text = t(paused === 'unsaved' ? 'wf.auto.pausedUnsaved' : 'wf.auto.pausedIssues');
  else if (!visible) text = t('wf.auto.hidden');
  else if (lastRunAt === null) text = t('wf.auto.starting');
  else
    text = t('wf.auto.status', {
      time: fmt.date(lastRunAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      seconds: fmt.number(
        Math.min(AUTO_REFRESH_MS / 1000, Math.max(0, Math.ceil((dueAt - now) / 1000)))
      ),
    });

  return (
    <p
      className={`px-4 py-1 text-[0.68rem] border-b border-border ${paused ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
      role="status"
      aria-live="off"
    >
      {text}
    </p>
  );
}
