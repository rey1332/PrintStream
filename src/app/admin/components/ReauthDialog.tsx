'use client';

import React, { useEffect, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { adminPost } from './api';

interface Device {
  id: string;
  name: string;
}

// A fresh two-factor code before a sensitive admin action. The code goes to
// /api/admin/platform/reauth and is never kept in the page afterwards.
export function ReauthDialog({ onDone }: { onDone: (ok: boolean) => void }) {
  const { t } = useI18n();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch('/api/auth/factors', { cache: 'no-store' });
        const result = await response.json();
        const list: Device[] = (result?.totp ?? []).map(
          (f: { id: string; friendly_name: string | null }) => ({
            id: f.id,
            name: f.friendly_name || 'Authenticator',
          })
        );
        setDevices(list);
        setFactorId(list[0]?.id ?? '');
      } catch {
        setDevices([]);
      }
    })();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDone(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !factorId || code.length !== 6) return;
    setBusy(true);
    setError('');
    const result = await adminPost('/api/admin/platform/reauth', { factorId, code });
    setBusy(false);
    setCode('');
    if (result.ok) {
      onDone(true);
      return;
    }
    setError(
      t(
        result.error === 'rate_limited'
          ? 'padmin.reauth.rateLimited'
          : result.error === 'wrong_code' || result.error === 'invalid'
            ? 'padmin.reauth.wrong'
            : 'padmin.err.failed'
      )
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-5 shadow-lg"
      >
        <div className="flex items-center gap-2">
          <KeyRound size={15} className="text-primary" />
          <h2 id="reauth-title" className="text-[0.9rem] font-semibold text-foreground">
            {t('padmin.reauth.title')}
          </h2>
        </div>
        <p className="text-[0.78rem] text-muted-foreground">{t('padmin.reauth.body')}</p>

        {devices === null ? (
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        ) : devices.length === 0 ? (
          <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
            {t('padmin.reauth.noDevice')}
          </p>
        ) : (
          <>
            {devices.length > 1 && (
              <label className="block space-y-1">
                <span className="text-[0.75rem] text-muted-foreground">
                  {t('padmin.reauth.device')}
                </span>
                <select
                  value={factorId}
                  onChange={(e) => setFactorId(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-[0.85rem] text-foreground"
                >
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block space-y-1">
              <span className="text-[0.75rem] text-muted-foreground">
                {t('padmin.reauth.code')}
              </span>
              <input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-[1rem] tracking-[0.3em] text-foreground outline-none focus:border-foreground/40"
              />
            </label>
          </>
        )}

        {error && (
          <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onDone(false)}
            className="rounded-lg border border-border px-3 py-1.5 text-[0.78rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
          >
            {t('padmin.reauth.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy || !factorId || code.length !== 6}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-[0.78rem] font-medium text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {t('padmin.reauth.confirm')}
          </button>
        </div>
      </form>
    </div>
  );
}
