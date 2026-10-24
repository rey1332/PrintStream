'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FilePlus2, Loader2, ScrollText, UserX } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useAdmin, useAdminPath } from '../components/AdminShell';
import { adminGet } from '../components/api';
import { Badge, Pager, Section, buttonCls, rowCls, tableCls, theadCls } from '../components/ui';

interface Version {
  id: string;
  label: string;
  status: 'draft' | 'current' | 'previous';
  updated_at: string;
  published_at: string | null;
  published_by_email: string | null;
  acceptances: number;
}

interface Pending {
  user_id: string;
  email: string;
  full_name: string;
  disabled: boolean;
  last_sign_in_at: string | null;
  last_accepted: string | null;
}

const STATUS: Record<Version['status'], { key: MessageKey; tone: 'warn' | 'good' | 'neutral' }> = {
  draft: { key: 'padmin.terms.draft', tone: 'warn' },
  current: { key: 'padmin.terms.current', tone: 'good' },
  previous: { key: 'padmin.terms.previous', tone: 'neutral' },
};

const LIMIT = 50;

export default function TermsAdminPage() {
  const ap = useAdminPath();
  const { t, fmt } = useI18n();
  const { role } = useAdmin();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [pending, setPending] = useState<{ rows: Pending[]; total: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [failed, setFailed] = useState(false);

  const when = (value: string | null) =>
    fmt.date(value, { dateStyle: 'medium', timeStyle: 'short' });

  useEffect(() => {
    (async () => {
      const result = await adminGet<{ versions: Version[] }>('/api/admin/platform/terms');
      if (result.ok) setVersions(result.data.versions);
      else setFailed(true);
    })();
  }, []);

  const loadPending = useCallback(async () => {
    const result = await adminGet<{ rows: Pending[]; total: number }>(
      `/api/admin/platform/terms/pending?offset=${offset}&limit=${LIMIT}`
    );
    if (result.ok) setPending(result.data);
  }, [offset]);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const current = versions?.find((v) => v.status === 'current');

  return (
    <div className="space-y-5">
      <Section
        title={t('padmin.nav.terms')}
        icon={ScrollText}
        actions={
          role === 'super_admin' && (
            <Link href={ap('/terms/new')} className={buttonCls}>
              <FilePlus2 size={13} />
              {t('padmin.terms.newDraft')}
            </Link>
          )
        }
      >
        <p className="px-5 pt-3 text-[0.75rem] text-muted-foreground">
          {t('padmin.terms.subtitle')}
        </p>
        {failed ? (
          <p role="alert" className="px-5 py-6 text-[0.8rem] text-red-600 dark:text-red-400">
            {t('padmin.err.failed')}
          </p>
        ) : !versions ? (
          <div className="px-5 py-6">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : versions.length === 0 ? (
          <p className="px-5 py-6 text-[0.8rem] text-muted-foreground">{t('padmin.terms.none')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto border-t border-border">
            <table className={`${tableCls} min-w-[640px]`}>
              <thead className={theadCls}>
                <tr>
                  <th className="px-5 py-2 font-medium">{t('padmin.terms.col.version')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.users.col.status')}</th>
                  <th className="px-3 py-2 font-medium">{t('padmin.terms.col.published')}</th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('padmin.terms.col.accepted')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className={rowCls}>
                    <td className="px-5 py-2">
                      <Link
                        href={ap(`/terms/${v.id}`)}
                        className="text-foreground underline-offset-2 hover:underline"
                      >
                        {v.label}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={STATUS[v.status].tone}>{t(STATUS[v.status].key)}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {v.published_at
                        ? `${when(v.published_at)} · ${v.published_by_email ?? '—'}`
                        : t('padmin.terms.editedAt', { date: when(v.updated_at) })}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {v.published_at ? v.acceptances : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {current && (
        <Section title={t('padmin.terms.pendingTitle', { version: current.label })} icon={UserX}>
          {!pending ? (
            <div className="px-5 py-4">
              <Loader2 size={16} className="animate-spin text-muted-foreground" />
            </div>
          ) : pending.rows.length === 0 ? (
            <p className="px-5 py-4 text-[0.8rem] text-muted-foreground">
              {t('padmin.terms.allAccepted')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className={`${tableCls} min-w-[600px]`}>
                <thead className={theadCls}>
                  <tr>
                    <th className="px-5 py-2 font-medium">{t('padmin.admins.col.account')}</th>
                    <th className="px-3 py-2 font-medium">{t('padmin.terms.col.lastAccepted')}</th>
                    <th className="px-3 py-2 font-medium">{t('padmin.admins.col.lastSignIn')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.rows.map((p) => (
                    <tr key={p.user_id} className={rowCls}>
                      <td className="px-5 py-2">
                        <Link
                          href={ap(`/users/${p.user_id}`)}
                          className="text-foreground underline-offset-2 hover:underline"
                        >
                          {p.email}
                        </Link>
                        {p.disabled && (
                          <span className="ml-2">
                            <Badge tone="bad">{t('padmin.users.disabled')}</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{p.last_accepted ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {when(p.last_sign_in_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pending && (
            <Pager offset={offset} limit={LIMIT} total={pending.total} onChange={setOffset} />
          )}
        </Section>
      )}
    </div>
  );
}
