'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ScrollText } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { safeNext } from '@/lib/auth/safe-next';
import { ACTIVE_WORKSPACE_KEY } from '@/lib/console/bridge';
import { TermsText, shownLocale, type TermsContent } from '@/components/terms/TermsText';

interface Terms {
  id: string;
  label: string;
  content: TermsContent;
  published_at: string;
}

interface Status {
  required: boolean;
  versionId: string | null;
  acceptedAt: string | null;
}

function activeWorkspace(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

async function post(action: string, body: unknown) {
  const response = await fetch(`/api/auth/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, body: await response.json().catch(() => null) };
}

// The current Terms & Conditions. Anyone can read them; a signed-in account
// that has not accepted the current version accepts (or declines) here before
// anything else in ETNA opens.
function TermsPage() {
  const { t, fmt, locale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [loaded, setLoaded] = useState<{ terms: Terms | null; status: Status | null } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/auth/terms', { cache: 'no-store' });
      setLoaded(await response.json());
    } catch {
      setLoaded({ terms: null, status: null });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 size={18} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { terms, status } = loaded;
  const lang = terms ? shownLocale(terms.content, locale) : 'en';

  async function accept() {
    if (!terms || !agreed || busy) return;
    setBusy(true);
    setError('');
    const result = await post('terms-accept', {
      versionId: terms.id,
      locale: lang,
      workspaceId: activeWorkspace(),
    });
    setBusy(false);
    if (result.ok) {
      router.replace(next);
      return;
    }
    const code = result.body?.error?.code;
    if (code === 'terms_changed') {
      setAgreed(false);
      setError(t('terms.changed'));
      await load();
    } else if (code === 'insufficient_aal') {
      router.replace(`/mfa?next=${encodeURIComponent(`/terms?next=${encodeURIComponent(next)}`)}`);
    } else if (code === 'no_session') {
      router.replace('/erp/login');
    } else setError(t('terms.failed'));
  }

  async function decline() {
    if (busy || !window.confirm(t('terms.declineConfirm'))) return;
    setBusy(true);
    await post('terms-decline', { versionId: terms?.id ?? null }).catch(() => null);
    window.location.href = '/erp/login';
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-5">
        <div className="text-center">
          <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
            ETNA
          </span>
          <h1 className="mt-2 flex items-center justify-center gap-2 text-[1.4rem] font-bold text-foreground">
            <ScrollText size={20} />
            {t('terms.title')}
          </h1>
          {terms && (
            <p className="mt-1 text-[0.78rem] text-muted-foreground">
              {t('terms.version', {
                version: terms.label,
                date: fmt.date(terms.published_at, { dateStyle: 'long' }),
              })}
            </p>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card">
          {!terms ? (
            <p className="p-6 text-[0.85rem] text-muted-foreground">{t('terms.none')}</p>
          ) : (
            <>
              {status?.required && (
                <p className="border-b border-border px-6 py-3 text-[0.8rem] text-foreground">
                  {t('terms.mustAccept')}
                </p>
              )}
              {lang !== locale && (
                <p className="border-b border-border px-6 py-2 text-[0.72rem] text-muted-foreground">
                  {t('terms.englishOnly')}
                </p>
              )}
              <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
                <TermsText text={terms.content[lang] ?? terms.content.en} />
              </div>
            </>
          )}
        </div>

        {terms && status?.required && (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-5">
            <label className="flex items-start gap-2 text-[0.82rem] text-foreground">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5"
              />
              {t('terms.agree', { version: terms.label })}
            </label>
            {error && (
              <p role="alert" className="text-[0.78rem] text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => void decline()}
                disabled={busy}
                className="rounded-lg border border-border px-4 py-2 text-[0.82rem] text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {t('terms.decline')}
              </button>
              <button
                type="button"
                onClick={() => void accept()}
                disabled={!agreed || busy}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[0.82rem] font-semibold text-primary-foreground disabled:opacity-50"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                {t('terms.accept')}
              </button>
            </div>
          </div>
        )}

        {terms && status && !status.required && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-[0.8rem] text-muted-foreground">
            <span>
              {t('terms.acceptedOn', {
                date: fmt.date(status.acceptedAt, { dateStyle: 'long', timeStyle: 'short' }),
              })}
            </span>
            <Link
              href={next}
              className="rounded-lg bg-primary px-4 py-2 text-[0.82rem] font-medium text-primary-foreground"
            >
              {t('terms.continue')}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TermsRoute() {
  return (
    <Suspense fallback={null}>
      <TermsPage />
    </Suspense>
  );
}
