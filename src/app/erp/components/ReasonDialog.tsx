'use client';

import React, { useState } from 'react';
import { X } from 'lucide-react';
import { MIN_REASON_LENGTH, isValidReason } from '../lib/erpRules';
import { useI18n } from '@/lib/i18n/I18nProvider';

interface ReasonDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  required?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}

export function ReasonDialog({
  title,
  description,
  confirmLabel,
  required = true,
  onConfirm,
  onClose,
}: ReasonDialogProps) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const valid = !required || isValidReason(reason);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    setError('');
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err: any) {
      setError(err?.message || t('common.changeNotSaved'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="overlay-mobile fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-4"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[1rem] font-semibold text-foreground">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label={t('reason.close')}
          >
            <X size={16} />
          </button>
        </div>
        <p className="text-[0.78rem] text-muted-foreground">{description}</p>
        <div>
          <label className="block text-[0.7rem] text-muted-foreground mb-1.5">
            {t('common.reasonLabel')}{' '}
            {required
              ? t('common.reasonRequiredHint', { count: MIN_REASON_LENGTH })
              : t('common.reasonOptionalHint')}
          </label>
          <textarea
            autoFocus
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40"
            style={{ background: 'var(--input)', borderColor: 'var(--border)' }}
          />
        </div>
        {error && <p className="text-[0.78rem] text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
          >
            {t('common.keepAsIs')}
          </button>
          <button
            type="submit"
            disabled={!valid || saving}
            className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
          >
            {saving ? t('common.saving') : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
