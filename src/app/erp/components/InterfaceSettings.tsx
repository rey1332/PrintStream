'use client';

import React, { useState } from 'react';
import { Check, MonitorSmartphone } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import { UI_VERSIONS, type UiVersion } from '@/lib/ui/mode';

const LABELS: Record<UiVersion, { name: MessageKey; description: MessageKey }> = {
  refined: { name: 'settings.ui.refined', description: 'settings.ui.refinedDesc' },
  legacy: { name: 'settings.ui.legacy', description: 'settings.ui.legacyDesc' },
};

export function InterfaceSettings() {
  const { t } = useI18n();
  const { preference, isDesktop, setPreference } = useUiMode();
  const [status, setStatus] = useState<'saved' | 'not-stored' | null>(null);

  function choose(next: UiVersion) {
    if (next === preference) return;
    setStatus(setPreference(next) ? 'saved' : 'not-stored');
  }

  return (
    <section
      className="rounded-xl border border-border overflow-hidden bg-card"
      aria-labelledby="interface-settings-title"
    >
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <MonitorSmartphone size={14} className="text-muted-foreground" />
        <h2 id="interface-settings-title" className="text-[0.85rem] font-semibold text-foreground">
          {t('settings.ui.title')}
        </h2>
      </div>
      <div className="px-5 py-4 space-y-3">
        <p className="text-[0.75rem] text-muted-foreground">{t('settings.ui.description')}</p>
        <div
          role="radiogroup"
          aria-labelledby="interface-settings-title"
          className="grid grid-cols-1 sm:grid-cols-2 gap-2"
        >
          {UI_VERSIONS.map((version) => {
            const selected = version === preference;
            return (
              <button
                key={version}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!isDesktop}
                onClick={() => choose(version)}
                className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  selected
                    ? 'border-foreground/40 bg-muted text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <span>
                  <span className={`block text-[0.82rem] ${selected ? 'font-medium' : ''}`}>
                    {t(LABELS[version].name)}
                  </span>
                  <span className="block text-[0.72rem] text-muted-foreground mt-0.5">
                    {t(LABELS[version].description)}
                  </span>
                </span>
                {selected && <Check size={13} className="mt-0.5 shrink-0" />}
              </button>
            );
          })}
        </div>
        {!isDesktop && (
          <p className="text-[0.72rem] text-muted-foreground" role="note">
            {t('settings.ui.smallScreen')}
          </p>
        )}
        {status === 'saved' && (
          <p className="text-[0.72rem] text-emerald-700 dark:text-emerald-400" role="status">
            {t('settings.ui.saved')}
          </p>
        )}
        {status === 'not-stored' && (
          <p className="text-[0.72rem] text-amber-700 dark:text-amber-400" role="status">
            {t('settings.ui.notStored')}
          </p>
        )}
      </div>
    </section>
  );
}
