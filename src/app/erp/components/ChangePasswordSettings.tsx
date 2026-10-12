'use client';

import React, { useRef, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  newPasswordProblem,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from '@/lib/auth/password-policy';

type Field = 'current' | 'next' | 'confirm';
type Errors = Partial<Record<Field, MessageKey>>;

const inputCls =
  'w-full rounded-lg border bg-input px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

export function ChangePasswordSettings() {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<{ ok: boolean; key: MessageKey } | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = {
    current: useRef<HTMLInputElement>(null),
    next: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  const vars = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_BYTES };

  const show = (found: Errors) => {
    setErrors(found);
    const first = (['current', 'next', 'confirm'] as Field[]).find((f) => found[f]);
    if (first) refs[first].current?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    const found: Errors = {};
    if (!current) found.current = 'password.err.currentRequired';
    const problem = newPasswordProblem(next);
    if (problem)
      found.next = problem === 'too_short' ? 'password.err.tooShort' : 'password.err.tooLong';
    else if (current && next === current) found.next = 'password.err.same';
    if (!found.next && confirm !== next) found.confirm = 'password.err.mismatch';
    if (Object.keys(found).length > 0) {
      show(found);
      return;
    }

    setBusy(true);
    setErrors({});
    const { error } = await createClient().auth.changePassword({
      currentPassword: current,
      newPassword: next,
    });
    setBusy(false);
    if (!error) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setMessage({ ok: true, key: 'password.changed' });
      return;
    }
    switch (error.code) {
      case 'invalid_credentials':
        show({ current: 'password.err.currentWrong' });
        break;
      case 'same_password':
        show({ next: 'password.err.same' });
        break;
      case 'weak_password':
        show({
          next: /long/i.test(error.message) ? 'password.err.tooLong' : 'password.err.tooShort',
        });
        break;
      case 'over_request_rate_limit':
        setMessage({ ok: false, key: 'password.err.rateLimited' });
        break;
      case 'insufficient_aal':
        setMessage({ ok: false, key: 'mfa.settings.needsVerify' });
        break;
      default:
        setMessage({ ok: false, key: 'password.err.failed' });
    }
  };

  const field = (
    id: Field,
    label: MessageKey,
    value: string,
    set: (v: string) => void,
    autoComplete: string,
    hint?: string
  ) => {
    const errorId = `password-${id}-error`;
    const hintId = hint ? `password-${id}-hint` : undefined;
    const describedBy =
      [errors[id] ? errorId : null, hintId].filter(Boolean).join(' ') || undefined;
    return (
      <div>
        <label
          htmlFor={`password-${id}`}
          className="block text-[0.7rem] text-muted-foreground mb-1"
        >
          {t(label)}
        </label>
        <input
          ref={refs[id]}
          id={`password-${id}`}
          type="password"
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => {
            set(e.target.value);
            setErrors((prev) => ({ ...prev, [id]: undefined }));
            setMessage(null);
          }}
          aria-invalid={errors[id] ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputCls} ${errors[id] ? 'border-red-500' : 'border-border'}`}
        />
        {hint && (
          <p id={hintId} className="mt-1 text-[0.68rem] text-muted-foreground">
            {hint}
          </p>
        )}
        {errors[id] && (
          <p id={errorId} className="mt-1 text-[0.72rem] text-red-600 dark:text-red-400">
            {t(errors[id]!, vars)}
          </p>
        )}
      </div>
    );
  };

  return (
    <section
      id="change-password"
      className="rounded-xl border border-border bg-card p-5 space-y-4"
      aria-labelledby="password-settings-title"
    >
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-foreground" />
        <h2 id="password-settings-title" className="text-[0.9rem] font-semibold text-foreground">
          {t('password.title')}
        </h2>
      </div>
      <p className="text-[0.78rem] text-muted-foreground">{t('password.desc')}</p>

      <form onSubmit={submit} noValidate className="grid gap-3 sm:max-w-sm">
        {field('current', 'password.current', current, setCurrent, 'current-password')}
        {field('next', 'password.new', next, setNext, 'new-password', t('password.rules', vars))}
        {field('confirm', 'password.confirm', confirm, setConfirm, 'new-password')}
        <div>
          <button
            type="submit"
            disabled={busy}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.78rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {busy ? t('password.saving') : t('password.submit')}
          </button>
        </div>
      </form>

      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`text-[0.75rem] ${message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
        >
          {t(message.key)}
        </p>
      )}
    </section>
  );
}
