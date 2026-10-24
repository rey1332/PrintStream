'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Loader2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { INDUSTRIES, INDUSTRY_HELP, INDUSTRY_LABEL, type Industry } from '@/lib/industry';
import { useAdmin, useAdminPath } from './AdminShell';
import { adminChange } from './api';
import { errorKey } from './labels';
import { LinkReveal } from './LinkReveal';
import { fieldCls } from './ui';

interface Created {
  workspace_id: string;
  user_id: string;
  new_user: boolean;
  url?: string;
  expires_at?: string;
  emailed: 'sent' | 'failed' | 'off' | null;
}

/** Workspaces → New company: an ERP for a client with its Owner. */
export function CompanyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const ap = useAdminPath();
  const { t } = useI18n();
  const { confirmIdentity } = useAdmin();
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState<Industry>('general');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [reason, setReason] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ name: string; result: Created } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await adminChange<Created>(confirmIdentity, '/api/admin/platform/companies', {
      name: name.trim(),
      industry,
      ownerEmail: ownerEmail.trim(),
      ownerName: ownerName.trim(),
      reason: reason.trim(),
      sendEmail,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') setError(t(errorKey(result.error)));
      return;
    }
    setCreated({ name: name.trim(), result: result.data });
    onCreated();
  }

  const label = 'block space-y-1';
  const caption = 'text-[0.75rem] text-muted-foreground';

  return (
    <div
      className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="company-title"
        className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl border border-border bg-card p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 id="company-title" className="text-[1rem] font-semibold text-foreground">
            {t('padmin.co.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1 text-muted-foreground hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        {created ? (
          <div className="space-y-3">
            <p className="text-[0.85rem] text-foreground">
              {t('padmin.co.created', { name: created.name })}
            </p>
            {created.result.url && created.result.expires_at ? (
              <LinkReveal
                url={created.result.url}
                purpose="invite"
                expiresAt={created.result.expires_at}
                emailed={created.result.emailed}
                onDismiss={onClose}
              />
            ) : (
              <p className={caption}>{t('padmin.co.existingOwner')}</p>
            )}
            <Link
              href={ap(`/workspaces/${created.result.workspace_id}`)}
              className="inline-block text-[0.8rem] text-foreground underline"
            >
              {t('padmin.co.open')}
            </Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <p className={caption}>{t('padmin.co.help')}</p>
            <label className={label}>
              <span className={caption}>{t('padmin.co.name')}</span>
              <input
                required
                autoFocus
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={`${fieldCls} w-full`}
              />
            </label>
            <label className={label}>
              <span className={caption}>{t('industry.label')}</span>
              <select
                value={industry}
                onChange={(e) => setIndustry(e.target.value as Industry)}
                className={`${fieldCls} w-full`}
              >
                {INDUSTRIES.map((code) => (
                  <option key={code} value={code}>
                    {t(INDUSTRY_LABEL[code])}
                  </option>
                ))}
              </select>
              <span className="block text-[0.7rem] text-muted-foreground">
                {t(INDUSTRY_HELP[industry])}
              </span>
            </label>
            <label className={label}>
              <span className={caption}>{t('padmin.co.ownerEmail')}</span>
              <input
                type="email"
                required
                maxLength={254}
                autoComplete="off"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                className={`${fieldCls} w-full`}
              />
            </label>
            <label className={label}>
              <span className={caption}>{t('padmin.co.ownerName')}</span>
              <input
                maxLength={120}
                autoComplete="off"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                className={`${fieldCls} w-full`}
              />
            </label>
            <label className={label}>
              <span className={caption}>{t('padmin.co.reason')}</span>
              <input
                required
                minLength={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={`${fieldCls} w-full`}
              />
            </label>
            <label className="flex items-center gap-2 text-[0.8rem] text-foreground">
              <input
                type="checkbox"
                checked={sendEmail}
                onChange={(e) => setSendEmail(e.target.checked)}
              />
              {t('padmin.mail.send')}
            </label>
            {error && (
              <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || !name.trim() || !ownerEmail.trim() || reason.trim().length < 3}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-[0.8rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              {t('padmin.co.create')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
