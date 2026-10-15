'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { AsciiLogo } from '@/components/brand/AsciiLogo';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { translateServerMessage } from '@/lib/i18n/translate';

export default function LoginPage() {
  const router = useRouter();
  const { signIn, user, loading: authLoading } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [shared, setShared] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Redirect if already logged in
  useEffect(() => {
    if (!authLoading && user) {
      router.replace('/');
    }
  }, [user, authLoading, router]);

  const inputCls =
    'w-full rounded-lg border px-3 py-2.5 text-[0.85rem] text-white outline-none focus:border-white/40 transition-colors';
  const inputStyle = { background: '#1a1a1a', borderColor: '#2e2e2e' };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email, password, shared);
      router.replace('/');
    } catch (err: any) {
      setError(err?.message ? translateServerMessage(err.message) : t('auth.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  }

  if (authLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: '#0a0a0a' }}
      >
        <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: '#0a0a0a' }}
    >
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          {/* A little wider than the form, so the characters stay legible. */}
          <div className="mb-4 flex justify-center text-white/85">
            <div className="w-[min(92vw,30rem)] shrink-0">
              <AsciiLogo maxFontPx={9} spacing="normal" className="flex justify-center" />
            </div>
          </div>
          <h1 className="text-[1.5rem] font-bold text-white tracking-tight">
            {t('auth.welcomeBack')}
          </h1>
          <p className="text-[0.8rem] text-white/40 mt-1">{t('auth.signInToEtna')}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border p-6 space-y-4"
          style={{ background: '#111111', borderColor: '#222222' }}
        >
          <div>
            <label className="block text-[0.72rem] text-white/40 mb-1.5 uppercase tracking-wider">
              {t('auth.email')}
            </label>
            <input
              type="email"
              className={inputCls}
              style={inputStyle}
              placeholder={t('auth.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          <div>
            <label className="block text-[0.72rem] text-white/40 mb-1.5 uppercase tracking-wider">
              {t('auth.password')}
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                className={inputCls}
                style={inputStyle}
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60 transition-colors"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRememberMe(!rememberMe)}
              className="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-all"
              style={{
                background: rememberMe ? '#ffffff' : 'transparent',
                borderColor: rememberMe ? '#ffffff' : '#3a3a3a',
              }}
            >
              {rememberMe && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path
                    d="M1 4L3.5 6.5L9 1"
                    stroke="#000"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
            <span
              className="text-[0.78rem] text-white/40 select-none cursor-pointer"
              onClick={() => setRememberMe(!rememberMe)}
            >
              {t('auth.rememberMe')}
            </span>
          </div>

          <div className="flex items-start gap-2">
            <button
              type="button"
              role="checkbox"
              aria-checked={shared}
              aria-describedby="shared-computer-hint"
              onClick={() => setShared(!shared)}
              className="mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-all"
              style={{
                background: shared ? '#ffffff' : 'transparent',
                borderColor: shared ? '#ffffff' : '#3a3a3a',
              }}
            >
              {shared && (
                <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                  <path
                    d="M1 4L3.5 6.5L9 1"
                    stroke="#000"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
            <span className="select-none cursor-pointer" onClick={() => setShared(!shared)}>
              <span className="block text-[0.78rem] text-white/40">{t('auth.sharedComputer')}</span>
              <span id="shared-computer-hint" className="block text-[0.7rem] text-white/25">
                {t('auth.sharedComputerHint')}
              </span>
            </span>
          </div>

          {error && (
            <p className="text-[0.78rem] text-red-400/80 bg-red-500/10 rounded-lg px-3 py-2 border border-red-500/20">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg text-[0.85rem] font-semibold text-black flex items-center justify-center gap-2 transition-opacity disabled:opacity-50 mt-2"
            style={{ background: '#ffffff' }}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-black/20 border-t-black/60 rounded-full animate-spin" />
                {t('auth.signingIn')}
              </span>
            ) : (
              <>
                <LogIn size={14} />
                {t('auth.signIn')}
              </>
            )}
          </button>
        </form>

        <p className="text-center text-[0.75rem] text-white/40 mt-4">
          {t('auth.noAccount')}
          {t('auth.requestAccess')}
        </p>
        <p className="text-center text-[0.75rem] text-white/20 mt-6">{t('auth.tagline')}</p>
      </div>
    </div>
  );
}
