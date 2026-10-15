'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { translateServerMessage } from '@/lib/i18n/translate';

export default function ERPLoginPage() {
  const router = useRouter();
  const { signIn } = useAuth();
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shared, setShared] = useState(false);

  const inputCls =
    'w-full rounded-lg border px-3 py-2.5 text-[0.85rem] text-foreground placeholder:text-muted-foreground outline-none focus:border-foreground/40 transition-colors';
  const inputStyle = { background: 'var(--input)', borderColor: 'var(--border)' };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signIn(email, password, shared);
      router.replace('/erp');
    } catch (err: any) {
      setError(err?.message ? translateServerMessage(err.message) : t('auth.failed'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="text-[0.65rem] font-bold tracking-widest uppercase text-muted-foreground">
              ETNA
            </span>
            <span className="text-[0.65rem] text-muted-foreground opacity-50">/</span>
            <span className="text-[0.85rem] font-semibold text-foreground">ERP</span>
          </div>
          <h1 className="text-[1.4rem] font-bold text-foreground">{t('auth.signIn')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-1">{t('auth.accessErp')}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl border border-border bg-card p-6 space-y-4"
        >
          <div>
            <label className="block text-[0.72rem] text-muted-foreground mb-1.5">
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
            />
          </div>

          <div>
            <label className="block text-[0.72rem] text-muted-foreground mb-1.5">
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
                minLength={6}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => setShared(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>
              <span className="block text-[0.8rem] text-foreground">
                {t('auth.sharedComputer')}
              </span>
              <span className="block text-[0.72rem] text-muted-foreground">
                {t('auth.sharedComputerHint')}
              </span>
            </span>
          </label>

          {error && (
            <p className="text-[0.78rem] text-muted-foreground bg-muted rounded-lg px-3 py-2 border border-border">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 rounded-lg text-[0.85rem] font-semibold bg-primary text-primary-foreground flex items-center justify-center gap-2 transition-opacity disabled:opacity-50"
          >
            {loading ? (
              <span className="text-[0.8rem]">{t('common.pleaseWait')}</span>
            ) : (
              <>
                <LogIn size={14} /> {t('auth.signIn')}
              </>
            )}
          </button>
        </form>

        <p className="text-center text-[0.8rem] text-muted-foreground mt-4">
          {t('auth.noAccount')}
          {t('auth.requestAccess')}
        </p>
        <p className="text-center text-[0.72rem] text-muted-foreground mt-2">
          {t('auth.invitedHintBefore')}
          <span className="text-foreground">{t('auth.invitedHintWorkspace')}</span>
          {t('auth.invitedHintAfter')}
        </p>
      </div>
    </div>
  );
}
