'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Eye, Loader2, Pencil, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { TermsText, type TermsContent, type TermsLocale } from '@/components/terms/TermsText';
import { useAdmin } from '../../components/AdminShell';
import { adminChange, adminGet } from '../../components/api';
import { ActionDialog, type ActionDialogProps } from '../../components/ActionDialog';
import { errorKey } from '../../components/labels';
import { Badge, Facts, Section, buttonCls, fieldCls } from '../../components/ui';

interface Version {
  id: string;
  label: string;
  content: TermsContent;
  status: 'draft' | 'current' | 'previous';
  created_at: string;
  created_by_email: string | null;
  published_at: string | null;
  published_by_email: string | null;
  acceptances: number;
  people: number;
}

// A new draft starts with an obvious placeholder: ETNA ships no legal text,
// and a draft that still contains "[PLACEHOLDER" cannot be published.
const PLACEHOLDER =
  '[PLACEHOLDER - NOT LEGAL TEXT]\n\nReplace this with the Terms & Conditions approved for ETNA.';

const LANGS: { code: TermsLocale; label: MessageKey }[] = [
  { code: 'en', label: 'padmin.terms.lang.en' },
  { code: 'id', label: 'padmin.terms.lang.id' },
  { code: 'zh', label: 'padmin.terms.lang.zh' },
];

type Dialog = Omit<ActionDialogProps, 'onClose'>;

export default function TermsVersionPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const router = useRouter();
  const { t, fmt } = useI18n();
  const { role, confirmIdentity } = useAdmin();
  const [version, setVersion] = useState<Version | null>(null);
  const [missing, setMissing] = useState(false);
  const [label, setLabel] = useState('');
  const [texts, setTexts] = useState<Record<TermsLocale, string>>({
    en: PLACEHOLDER,
    id: '',
    zh: '',
  });
  const [lang, setLang] = useState<TermsLocale>('en');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const load = useCallback(async () => {
    if (isNew) return;
    const result = await adminGet<Version>(`/api/admin/platform/terms/${id}`);
    if (!result.ok) {
      setMissing(true);
      return;
    }
    setVersion(result.data);
    setLabel(result.data.label);
    setTexts({
      en: result.data.content.en,
      id: result.data.content.id ?? '',
      zh: result.data.content.zh ?? '',
    });
    setDirty(false);
  }, [id, isNew]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing)
    return <p className="text-[0.85rem] text-muted-foreground">{t('padmin.err.not_found')}</p>;
  if (!isNew && !version)
    return <Loader2 size={16} className="animate-spin text-muted-foreground" />;

  const editable = role === 'super_admin' && (isNew || version?.status === 'draft');
  const when = (value: string | null) =>
    fmt.date(value, { dateStyle: 'medium', timeStyle: 'short' });

  async function save(): Promise<string | null> {
    setBusy(true);
    const result = await adminChange<{ id: string }>(confirmIdentity, '/api/admin/platform/terms', {
      id: isNew ? null : id,
      label: label.trim(),
      content: texts,
    });
    setBusy(false);
    if (!result.ok) {
      if (result.error !== 'cancelled') toast.error(t(errorKey(result.error)));
      return null;
    }
    toast.success(t('padmin.terms.saved'));
    setDirty(false);
    if (isNew) router.replace(`/admin/terms/${result.data.id}`);
    else await load();
    return result.data.id;
  }

  async function act(action: 'publish' | 'delete'): Promise<string | null> {
    const result = await adminChange(confirmIdentity, `/api/admin/platform/terms/${id}`, {
      action,
    });
    if (!result.ok) return result.error === 'cancelled' ? null : t(errorKey(result.error));
    toast.success(t(action === 'publish' ? 'padmin.terms.published' : 'padmin.terms.deleted'));
    if (action === 'delete') router.replace('/admin/terms');
    else await load();
    return null;
  }

  const shown = texts[lang];

  return (
    <div className="space-y-5">
      <Link
        href="/admin/terms"
        className="inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={12} />
        {t('padmin.nav.terms')}
      </Link>

      <section className="space-y-3 rounded-xl border border-border bg-card px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[1rem] font-semibold text-foreground">
            {isNew ? t('padmin.terms.newDraft') : version!.label}
          </h1>
          {version && (
            <Badge
              tone={
                version.status === 'draft'
                  ? 'warn'
                  : version.status === 'current'
                    ? 'good'
                    : 'neutral'
              }
            >
              {t(
                version.status === 'draft'
                  ? 'padmin.terms.draft'
                  : version.status === 'current'
                    ? 'padmin.terms.current'
                    : 'padmin.terms.previous'
              )}
            </Badge>
          )}
        </div>
        {version?.published_at && (
          <Facts
            items={[
              [
                t('padmin.terms.col.published'),
                `${when(version.published_at)} · ${version.published_by_email ?? '—'}`,
              ],
              [
                t('padmin.terms.col.accepted'),
                t('padmin.terms.acceptedOf', {
                  count: version.acceptances,
                  people: version.people,
                }),
              ],
            ]}
          />
        )}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonCls}
              disabled={busy || !label.trim() || !texts.en.trim()}
              onClick={() => void save()}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Pencil size={13} />}
              {t('padmin.terms.saveDraft')}
            </button>
            {!isNew && (
              <>
                <button
                  type="button"
                  className={buttonCls}
                  disabled={dirty}
                  title={dirty ? t('padmin.terms.saveFirst') : undefined}
                  onClick={() =>
                    setDialog({
                      title: t('padmin.terms.publish'),
                      description: t('padmin.terms.publishBody', { version: label }),
                      confirmLabel: t('padmin.terms.publish'),
                      danger: true,
                      onConfirm: () => act('publish'),
                    })
                  }
                >
                  <Send size={13} />
                  {t('padmin.terms.publish')}
                </button>
                <button
                  type="button"
                  className={buttonCls}
                  onClick={() =>
                    setDialog({
                      title: t('padmin.terms.deleteDraft'),
                      description: t('padmin.terms.deleteBody', { version: label }),
                      confirmLabel: t('padmin.terms.deleteDraft'),
                      danger: true,
                      onConfirm: () => act('delete'),
                    })
                  }
                >
                  <Trash2 size={13} />
                  {t('padmin.terms.deleteDraft')}
                </button>
              </>
            )}
          </div>
        )}
      </section>

      <Section
        title={t('padmin.terms.text')}
        actions={
          <>
            <div className="flex rounded-lg border border-border p-0.5">
              {LANGS.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => setLang(l.code)}
                  className={`rounded-md px-2.5 py-1 text-[0.72rem] max-lg:min-h-11 ${
                    lang === l.code
                      ? 'bg-[var(--surface-2)] font-medium text-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  {t(l.label)}
                </button>
              ))}
            </div>
            {editable && (
              <button type="button" className={buttonCls} onClick={() => setPreview((v) => !v)}>
                {preview ? <Pencil size={13} /> : <Eye size={13} />}
                {t(preview ? 'padmin.terms.edit' : 'padmin.terms.preview')}
              </button>
            )}
          </>
        }
      >
        {editable && !preview ? (
          <div className="space-y-3 px-5 py-4">
            <label className="block space-y-1">
              <span className="text-[0.75rem] text-muted-foreground">
                {t('padmin.terms.label')}
              </span>
              <input
                value={label}
                maxLength={60}
                onChange={(e) => {
                  setLabel(e.target.value);
                  setDirty(true);
                }}
                placeholder="2026-10-01 v1.0"
                className={`${fieldCls} w-full max-w-sm`}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[0.75rem] text-muted-foreground">
                {t(lang === 'en' ? 'padmin.terms.textRequired' : 'padmin.terms.textOptional')}
              </span>
              <textarea
                value={shown}
                rows={22}
                maxLength={200000}
                onChange={(e) => {
                  setTexts((all) => ({ ...all, [lang]: e.target.value }));
                  setDirty(true);
                }}
                className={`${fieldCls} w-full font-mono text-[0.78rem] leading-relaxed`}
              />
            </label>
            <p className="text-[0.72rem] text-muted-foreground">{t('padmin.terms.plainText')}</p>
          </div>
        ) : (
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
            {shown.trim() ? (
              <TermsText text={shown} />
            ) : (
              <p className="text-[0.8rem] text-muted-foreground">
                {t('padmin.terms.fallsBackToEnglish')}
              </p>
            )}
          </div>
        )}
      </Section>

      {dialog && <ActionDialog {...dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
