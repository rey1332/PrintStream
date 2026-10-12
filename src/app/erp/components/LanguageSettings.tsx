'use client';

import React, { useState } from 'react';
import { Check, Languages } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { LOCALES, LOCALE_NATIVE_NAMES, type Locale } from '@/lib/i18n/config';

export function LanguageSettings() {
  const { locale, setLocale, t } = useI18n();
  const [status, setStatus] = useState<'saved' | 'not-stored' | null>(null);

  function choose(next: Locale) {
    if (next === locale) return;
    setStatus(setLocale(next) ? 'saved' : 'not-stored');
  }

  return (
    <section
      className="rounded-xl border border-border overflow-hidden bg-card"
      aria-labelledby="language-settings-title"
    >
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <Languages size={14} className="text-muted-foreground" />
        <h2 id="language-settings-title" className="text-[0.85rem] font-semibold text-foreground">
          {t('settings.language.title')}
        </h2>
      </div>
      <div className="px-5 py-4 space-y-3">
        <p className="text-[0.75rem] text-muted-foreground">{t('settings.language.description')}</p>
        <div
          role="radiogroup"
          aria-labelledby="language-settings-title"
          className="grid grid-cols-1 sm:grid-cols-3 gap-2"
        >
          {LOCALES.map((code) => {
            const selected = code === locale;
            return (
              <button
                key={code}
                type="button"
                role="radio"
                aria-checked={selected}
                lang={code}
                data-locale-option={code}
                onClick={() => choose(code)}
                className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-[0.82rem] transition-colors ${
                  selected
                    ? 'border-foreground/40 bg-muted text-foreground font-medium'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <span>{LOCALE_NATIVE_NAMES[code]}</span>
                {selected && <Check size={13} />}
              </button>
            );
          })}
        </div>
        {status === 'saved' && (
          <p className="text-[0.72rem] text-emerald-700 dark:text-emerald-400" role="status">
            {t('settings.language.saved')}
          </p>
        )}
        {status === 'not-stored' && (
          <p className="text-[0.72rem] text-amber-700 dark:text-amber-400" role="status">
            {t('settings.language.notStored')}
          </p>
        )}
      </div>
    </section>
  );
}
