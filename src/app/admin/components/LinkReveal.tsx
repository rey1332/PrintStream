'use client';

import React, { useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';

// A one-time password link, shown once. It is not stored anywhere in the page
// and disappears when dismissed; ETNA keeps only its hash.
export function LinkReveal({
  url,
  purpose,
  expiresAt,
  emailed,
  onDismiss,
}: {
  url: string;
  purpose: 'reset' | 'invite';
  expiresAt: string;
  /** What happened to the e-mail with the link, when one was asked for. */
  emailed?: 'sent' | 'failed' | 'off' | null;
  onDismiss: () => void;
}) {
  const { t, fmt } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Still on screen to copy by hand.
    }
  }

  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30"
    >
      <p className="flex items-center gap-2 text-[0.8rem] font-medium text-foreground">
        <Link2 size={13} />
        {t(purpose === 'invite' ? 'padmin.link.inviteReady' : 'padmin.link.resetReady')}
      </p>
      <p className="text-[0.75rem] text-muted-foreground">
        {t('padmin.link.once', {
          when: fmt.date(expiresAt, { dateStyle: 'medium', timeStyle: 'short' }),
        })}
      </p>
      {emailed && (
        <p
          className={`text-[0.75rem] ${emailed === 'sent' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
        >
          {t(
            emailed === 'sent'
              ? 'padmin.mail.sent'
              : emailed === 'off'
                ? 'padmin.mail.off'
                : 'padmin.mail.failed'
          )}
        </p>
      )}
      <code className="block break-all rounded-md bg-card px-3 py-2 font-mono text-[0.75rem] text-foreground select-all">
        {url}
      </code>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1.5 text-[0.72rem] text-foreground max-lg:min-h-11"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('users.copied') : t('users.copy')}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md border border-border bg-card px-2 py-1.5 text-[0.72rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
        >
          {t('users.dismiss')}
        </button>
      </div>
    </div>
  );
}
