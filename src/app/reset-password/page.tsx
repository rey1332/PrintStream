'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { PASSWORD_MIN_LENGTH, newPasswordProblem } from '@/lib/auth/password-policy';

type State =
  | { step: 'checking' }
  | { step: 'invalid' }
  | { step: 'form'; email: string; purpose: 'reset' | 'invite' }
  | { step: 'done'; email: string };

async function post(action: string, body: unknown) {
  const response = await fetch(`/api/auth/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

// A one-time link from an ETNA administrator: /reset-password#token=...
// The token is after "#", so it never reaches the server's logs; it is
// removed from the address bar as soon as the page has read it.
export default function ResetPasswordPage() {
  const { t } = useI18n();
  const [state, setState] = useState<State>({ step: 'checking' });
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const found = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    window.history.replaceState(null, '', window.location.pathname);
    setToken(found);
    if (!found) {
      setState({ step: 'invalid' });
      return;
    }
    (async () => {
      try {
        const result = await post('password-link', { token: found });
        setState(
          result.ok && result.body?.valid
            ? { step: 'form', email: result.body.email, purpose: result.body.purpose }
            : { step: 'invalid' }
        );
      } catch {
        setState({ step: 'invalid' });
      }
    })();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || state.step !== 'form') return;
    setError('');
    const problem = newPasswordProblem(password);
    if (problem) {
      setError(
        t(problem === 'too_short' ? 'reset.err.short' : 'reset.err.long', {
          min: PASSWORD_MIN_LENGTH,
        })
      );
      return;
    }
    if (password !== repeat) {
      setError(t('reset.err.mismatch'));
      return;
    }
    setBusy(true);
    try {
      const result = await post('set-password', { token, password });
      if (result.ok) {
        setPassword('');
        setRepeat('');
        setToken('');
        setState({ step: 'done', email: state.email });
      } else if (result.status === 429) setError(t('reset.err.rateLimited'));
      else if (result.body?.error?.code === 'invalid_link') setState({ step: 'invalid' });
      else setError(t('reset.err.failed'));
    } catch {
      setError(t('reset.err.failed'));
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full rounded-lg border border-border bg-[var(--input)] px-3 py-2.5 text-[0.85rem] text-foreground outline-none focus:border-foreground/40 transition-colors';

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="text-[0.65rem] font-bold tracking-widest uppercase text-muted-foreground">
              ETNA
            </span>
          </div>
          <h1 className="text-[1.4rem] font-bold text-foreground">
            {t(
              state.step === 'form' && state.purpose === 'invite'
                ? 'reset.titleInvite'
                : 'reset.title'
            )}
          </h1>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
          {state.step === 'checking' && (
            <Loader2 size={18} className="mx-auto animate-spin text-muted-foreground" />
          )}

          {state.step === 'invalid' && (
            <>
              <p className="text-[0.85rem] text-foreground">{t('reset.invalid')}</p>
              <p className="text-[0.78rem] text-muted-foreground">{t('reset.invalidHint')}</p>
            </>
          )}

          {state.step === 'form' && (
            <form onSubmit={submit} className="space-y-4">
              <p className="text-[0.8rem] text-muted-foreground">
                {t('reset.for', { email: state.email })}
              </p>
              <label className="block">
                <span className="block text-[0.72rem] text-muted-foreground mb-1.5">
                  {t('reset.newPassword')}
                </span>
                <div className="relative">
                  <input
                    type={show ? 'text' : 'password'}
                    required
                    autoFocus
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`${inputCls} pr-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((v) => !v)}
                    aria-label={t(show ? 'reset.hide' : 'reset.show')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {show ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </label>
              <label className="block">
                <span className="block text-[0.72rem] text-muted-foreground mb-1.5">
                  {t('reset.repeat')}
                </span>
                <input
                  type={show ? 'text' : 'password'}
                  required
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  className={inputCls}
                />
              </label>
              <p className="text-[0.72rem] text-muted-foreground">
                {t('reset.rules', { min: PASSWORD_MIN_LENGTH })}
              </p>
              {error && (
                <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 rounded-lg text-[0.85rem] font-semibold bg-primary text-primary-foreground flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                {t('reset.save')}
              </button>
            </form>
          )}

          {state.step === 'done' && (
            <div className="space-y-3 text-center">
              <CheckCircle2 size={28} className="mx-auto text-emerald-500" />
              <p className="text-[0.85rem] text-foreground">
                {t('reset.done', { email: state.email })}
              </p>
              <Link
                href="/erp/login"
                className="inline-block rounded-lg bg-primary px-4 py-2 text-[0.82rem] font-medium text-primary-foreground"
              >
                {t('reset.signIn')}
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
