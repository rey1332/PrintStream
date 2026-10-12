'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, Check, ImagePlus, Loader2, X } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { rpcWorkspaceId } from '../lib/workspace';
import { useWorkspace } from '../lib/WorkspaceContext';
import { EMPTY_PROFILE, loadCompanyProfile, type CompanyProfile } from '../lib/companyProfile';

const FIELDS: { key: Exclude<keyof CompanyProfile, 'logo'>; label: MessageKey; wide?: boolean }[] =
  [
    { key: 'legal_name', label: 'company.legalName' },
    { key: 'tax_id', label: 'company.taxId' },
    { key: 'address', label: 'company.address', wide: true },
    { key: 'city', label: 'company.city' },
    { key: 'phone', label: 'company.phone' },
    { key: 'email', label: 'company.email' },
    { key: 'website', label: 'company.website' },
    { key: 'bank_details', label: 'company.bank', wide: true },
    { key: 'footer_note', label: 'company.footer', wide: true },
  ];

const MAX_LOGO_PX = 400;

function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_LOGO_PX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error());
    };
    img.src = url;
  });
}

export function CompanyProfileSettings({ inputClassName }: { inputClassName: string }) {
  const { t } = useI18n();
  const { active } = useWorkspace();
  const [profile, setProfile] = useState<CompanyProfile>(EMPTY_PROFILE);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loadCompanyProfile(rpcWorkspaceId());
      setProfile(result.profile);
      setCanEdit(result.canEdit);
    } catch {
      setError(t('company.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load, active?.id]);

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setError('');
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      setError(t('company.logoType'));
      return;
    }
    try {
      const logo = await shrinkImage(file);
      if (logo.length > 400_000) {
        setError(t('company.logoSize'));
        return;
      }
      setProfile((p) => ({ ...p, logo }));
    } catch {
      setError(t('company.logoType'));
    }
  }

  async function save() {
    if (!canEdit || saving) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const { error: saveError } = await createClient().rpc('erp_company_profile_set', {
        p_workspace_id: rpcWorkspaceId(),
        p_profile: profile,
      });
      if (saveError) {
        setError(
          t(/e-mail/.test(saveError.message ?? '') ? 'company.emailInvalid' : 'company.saveFailed')
        );
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      await load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border overflow-hidden bg-card">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Building2 size={14} className="text-muted-foreground" />
          <div>
            <h2 className="text-[0.85rem] font-semibold text-foreground">{t('company.title')}</h2>
            <p className="text-[0.72rem] text-muted-foreground">{t('company.subtitle')}</p>
          </div>
        </div>
        {canEdit && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading}
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
      {loading ? (
        <div className="p-5 text-[0.8rem] text-muted-foreground">{t('common.loading')}</div>
      ) : (
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-32 items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-background">
              {profile.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a data URL, not a remote image
                <img
                  src={profile.logo}
                  alt={t('company.logo')}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="text-[0.7rem] text-muted-foreground">{t('company.noLogo')}</span>
              )}
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    void pickLogo(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[0.75rem] text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11"
                >
                  <ImagePlus size={13} /> {t('company.uploadLogo')}
                </button>
                {profile.logo && (
                  <button
                    type="button"
                    onClick={() => setProfile((p) => ({ ...p, logo: null }))}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[0.75rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
                  >
                    <X size={13} /> {t('company.removeLogo')}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.key} className={`block ${f.wide ? 'sm:col-span-2' : ''}`}>
                <span className="mb-1 block text-[0.72rem] font-medium text-foreground">
                  {t(f.label)}
                </span>
                {f.wide ? (
                  <textarea
                    rows={2}
                    value={profile[f.key]}
                    disabled={!canEdit}
                    onChange={(e) => setProfile((p) => ({ ...p, [f.key]: e.target.value }))}
                    className={inputClassName}
                  />
                ) : (
                  <input
                    value={profile[f.key]}
                    disabled={!canEdit}
                    onChange={(e) => setProfile((p) => ({ ...p, [f.key]: e.target.value }))}
                    className={inputClassName}
                  />
                )}
              </label>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
