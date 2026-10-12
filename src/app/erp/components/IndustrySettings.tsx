'use client';

import React, { useEffect, useState } from 'react';
import { Check, Factory, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import {
  INDUSTRIES,
  INDUSTRY_HELP,
  INDUSTRY_LABEL,
  INDUSTRY_MODULES,
  MODULES,
  MODULE_HELP,
  MODULE_LABEL,
  type Industry,
  type ModuleCode,
} from '@/lib/industry';
import { useWorkspace } from '../lib/WorkspaceContext';

// Settings → Industry and modules (20261012000023_erp_industry_modules.sql).
export function IndustrySettings() {
  const { t } = useI18n();
  const { active, role, refresh } = useWorkspace();
  const [industry, setIndustry] = useState<Industry>('general');
  const [modules, setModules] = useState<ModuleCode[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const canEdit = role === 'owner' || role === 'admin';

  useEffect(() => {
    setIndustry(active?.industry ?? 'general');
    setModules(active?.modules ?? []);
  }, [active?.id, active?.industry, active?.modules]);

  if (!active) return null;

  const dirty =
    industry !== active.industry ||
    modules.length !== active.modules.length ||
    modules.some((m) => !active.modules.includes(m));

  function pickIndustry(next: Industry) {
    setIndustry(next);
    setModules([...INDUSTRY_MODULES[next]]);
  }

  function toggle(module: ModuleCode) {
    setModules((current) =>
      current.includes(module) ? current.filter((m) => m !== module) : [...current, module]
    );
  }

  async function save() {
    if (!active || !canEdit || saving) return;
    setSaving(true);
    setError('');
    const { error: saveError } = await createClient().rpc('erp_set_workspace_industry', {
      p_workspace_id: active.id,
      p_industry: industry,
      p_modules: modules,
    });
    setSaving(false);
    if (saveError) {
      setError(t('industry.settings.failed'));
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
    await refresh();
  }

  return (
    <section className="rounded-xl border border-border overflow-hidden bg-card">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Factory size={14} className="text-muted-foreground" />
          <div>
            <h2 className="text-[0.85rem] font-semibold text-foreground">
              {t('industry.settings.title')}
            </h2>
            <p className="text-[0.72rem] text-muted-foreground">
              {t('industry.settings.subtitle')}
            </p>
          </div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[0.78rem] font-medium bg-primary text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
          >
            {saving ? (
              <Loader2 size={13} className="animate-spin" />
            ) : saved ? (
              <Check size={13} />
            ) : null}
            {saved ? t('common.saved') : t('common.save')}
          </button>
        )}
      </div>
      <div className="p-5 space-y-4">
        {!canEdit && (
          <p className="text-[0.75rem] text-muted-foreground">{t('industry.settings.readOnly')}</p>
        )}
        <div
          className="grid gap-2 sm:grid-cols-2"
          role="radiogroup"
          aria-label={t('industry.label')}
        >
          {INDUSTRIES.map((code) => (
            <label
              key={code}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 ${
                industry === code ? 'border-foreground/50 bg-[var(--surface-3)]' : 'border-border'
              } ${canEdit ? '' : 'cursor-default opacity-80'}`}
            >
              <input
                type="radio"
                name="erp-industry"
                className="mt-1"
                checked={industry === code}
                disabled={!canEdit}
                onChange={() => pickIndustry(code)}
              />
              <span>
                <span className="block text-[0.8rem] font-medium text-foreground">
                  {t(INDUSTRY_LABEL[code])}
                </span>
                <span className="block text-[0.7rem] text-muted-foreground">
                  {t(INDUSTRY_HELP[code])}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div>
          <h3 className="mb-2 text-[0.75rem] font-semibold text-foreground">
            {t('industry.settings.modules')}
          </h3>
          <div className="space-y-2">
            {MODULES.map((code) => (
              <label key={code} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={modules.includes(code)}
                  disabled={!canEdit}
                  onChange={() => toggle(code)}
                />
                <span>
                  <span className="block text-[0.8rem] text-foreground">
                    {t(MODULE_LABEL[code])}
                  </span>
                  <span className="block text-[0.7rem] text-muted-foreground">
                    {t(MODULE_HELP[code])}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
        {error && (
          <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
