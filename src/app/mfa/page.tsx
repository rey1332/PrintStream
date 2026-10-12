'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { safeNext } from '@/lib/auth/safe-next';
import { useI18n } from '@/lib/i18n/I18nProvider';

interface Device {
  id: string;
  name: string;
}

function MfaForm() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [devices, setDevices] = useState<Device[]>([]);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const db = createClient();
    (async () => {
      const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.currentLevel === 'aal2' || aal?.nextLevel !== 'aal2') {
        router.replace(next);
        return;
      }
      const { data } = await db.auth.mfa.listFactors();
      const verified = (data?.totp ?? [])
        .filter((f) => f.status === 'verified')
        .map((f) => ({ id: f.id, name: f.friendly_name || 'Authenticator' }));
      setDevices(verified);
      setFactorId(verified[0]?.id ?? null);
      setLoading(false);
    })();
  }, [router, next]);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factorId || code.length !== 6) return;
    setBusy(true);
    setError('');
    const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({
      factorId,
      code,
    });
    if (verifyError) {
      setError(
        t(
          verifyError.code === 'over_request_rate_limit'
            ? 'password.err.rateLimited'
            : 'mfa.invalidCode'
        )
      );
      setBusy(false);
      return;
    }
    // Full navigation so the middleware sees the upgraded session cookie.
    window.location.assign(next);
  };

  const submitRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (recoveryCode.trim().length < 10) return;
    setBusy(true);
    setError('');
    const db = createClient();
    const { data, error: rpcError } = await db.rpc('erp_mfa_use_recovery_code', {
      p_code: recoveryCode,
    });
    if (rpcError || data !== 'ok') {
      setError(
        data === 'locked'
          ? t('mfa.recoveryLocked')
          : data === 'invalid'
            ? t('mfa.recoveryInvalid')
            : t('mfa.recoveryFailed')
      );
      setBusy(false);
      return;
    }
    await db.auth.refreshSession();
    window.location.assign('/erp/settings?mfa=recovered');
  };

  const switchMode = () => {
    setRecoveryMode((on) => !on);
    setError('');
    setCode('');
    setRecoveryCode('');
  };

  const signOut = async () => {
    await createClient().auth.signOut();
    router.replace(next.startsWith('/erp') ? '/erp/login' : '/login');
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-foreground" />
          <h1 className="text-[1.1rem] font-bold text-foreground">{t('mfa.title')}</h1>
        </div>
        {loading ? (
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        ) : !factorId ? (
          <p className="text-[0.8rem] text-muted-foreground">{t('mfa.noFactor')}</p>
        ) : recoveryMode ? (
          <form onSubmit={submitRecovery} className="space-y-3">
            <p className="text-[0.8rem] text-muted-foreground">{t('mfa.recoveryPrompt')}</p>
            <label
              htmlFor="mfa-recovery-code"
              className="block text-[0.72rem] text-muted-foreground"
            >
              {t('mfa.recoveryCode')}
            </label>
            <input
              id="mfa-recovery-code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={20}
              autoFocus
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
              placeholder={t('mfa.recoveryPlaceholder')}
              className="w-full rounded-lg border border-border bg-input px-3 py-2.5 text-[1rem] tracking-[0.2em] text-center font-mono text-foreground outline-none focus:border-foreground/40"
            />
            {error && (
              <p className="text-[0.75rem] text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || recoveryCode.trim().length < 10}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[0.85rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? t('mfa.verifying') : t('mfa.recoveryUse')}
            </button>
            <p className="text-[0.7rem] text-muted-foreground">{t('mfa.recoveryNoCodes')}</p>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <p className="text-[0.8rem] text-muted-foreground">{t('mfa.prompt')}</p>
            {devices.length > 1 && (
              <>
                <label htmlFor="mfa-device" className="block text-[0.72rem] text-muted-foreground">
                  {t('mfa.device')}
                </label>
                <select
                  id="mfa-device"
                  value={factorId ?? ''}
                  onChange={(e) => {
                    setFactorId(e.target.value);
                    setError('');
                  }}
                  className="w-full rounded-lg border border-border bg-input px-3 py-2 text-[0.85rem] text-foreground outline-none focus:border-foreground/40"
                >
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <label htmlFor="mfa-code" className="block text-[0.72rem] text-muted-foreground">
              {t('mfa.code')}
            </label>
            <input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full rounded-lg border border-border bg-input px-3 py-2.5 text-[1.1rem] tracking-[0.4em] text-center font-mono text-foreground outline-none focus:border-foreground/40"
            />
            {error && (
              <p className="text-[0.75rem] text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy || code.length !== 6}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[0.85rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {busy ? t('mfa.verifying') : t('mfa.verify')}
            </button>
          </form>
        )}
        {!loading && factorId && (
          <button
            type="button"
            onClick={switchMode}
            className="block text-[0.75rem] text-foreground hover:underline underline-offset-2"
          >
            {recoveryMode ? t('mfa.useAuthenticator') : t('mfa.useRecovery')}
          </button>
        )}
        <button
          type="button"
          onClick={signOut}
          className="text-[0.75rem] text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          {t('mfa.signOut')}
        </button>
      </div>
    </div>
  );
}

export default function MfaPage() {
  return (
    <Suspense fallback={null}>
      <MfaForm />
    </Suspense>
  );
}
