'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Inbox, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { useWorkspace } from '../lib/WorkspaceContext';
import { SyncError, syncService, type InboxItem } from '../lib/syncService';

const inputCls =
  'rounded-lg border border-border bg-card px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => Number(v ?? 0);

export default function SyncInboxPage() {
  const { t, fmt, currency: base } = useI18n();
  const { active, can } = useWorkspace();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<{
    item: InboxItem;
    mode: 'post' | 'dismiss';
    value: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState('');

  const errorText = useCallback(
    (err: unknown) => t(err instanceof SyncError ? err.key : 'sync.err.failed'),
    [t]
  );

  const load = useCallback(async () => {
    if (!active) return;
    setError('');
    try {
      setItems(await syncService.inbox(active.id));
    } catch (err) {
      setItems([]);
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [active, errorText]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const kindLabel = (item: InboxItem) => t(`sync.inbox.kind.${item.kind}` as MessageKey);
  const mayAct = (item: InboxItem) => can(item.kind === 'invoice' ? 'invoicing' : 'payments');
  const docCurrency = (item: InboxItem) => str(item.payload.currency) || null;
  const foreign = (item: InboxItem) => {
    const c = docCurrency(item);
    return !!c && !!base && c !== base;
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!acting || busy) return;
    setBusy(true);
    setActError('');
    try {
      if (acting.mode === 'post') {
        const rate = acting.value.trim() ? Number(acting.value.replace(',', '.')) : null;
        if (rate !== null && !(rate > 0)) throw new SyncError('sync.err.fx');
        await syncService.post(acting.item.id, rate);
        toast.success(t('sync.inbox.postedToast'));
      } else {
        await syncService.dismiss(acting.item.id, acting.value);
        toast.success(t('sync.inbox.dismissedToast'));
      }
      setActing(null);
      await load();
    } catch (err) {
      setActError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const pending = items.filter((i) => i.status === 'pending');
  const handled = items.filter((i) => i.status !== 'pending');

  const row = (item: InboxItem) => {
    const p = item.payload;
    const isInvoice = item.kind === 'invoice';
    const amount = isInvoice ? num(p.total) : num(p.amount);
    const date = isInvoice ? str(p.invoice_date) : str(p.payment_date);
    return (
      <tr key={item.id} className="border-t border-border align-top">
        <td className="px-4 py-2 whitespace-nowrap">
          <span className="font-medium text-foreground">{kindLabel(item)}</span>
          {!isInvoice && (
            <span className="block text-[0.7rem] text-muted-foreground">
              {t(p.payment_type === 'outgoing' ? 'sync.inbox.outgoing' : 'sync.inbox.incoming')}
            </span>
          )}
        </td>
        <td className="px-4 py-2">{item.sourceName}</td>
        <td className="px-4 py-2">
          {isInvoice ? str(p.customer_name) : str(p.party)}
          {isInvoice && p.due_date ? (
            <span className="block text-[0.7rem] text-muted-foreground">
              {t('sync.inbox.due', { date: fmt.date(str(p.due_date)) })}
            </span>
          ) : null}
        </td>
        <td className="px-4 py-2 whitespace-nowrap">{fmt.date(date)}</td>
        <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">
          {fmt.moneyIn(amount, docCurrency(item) === base ? null : docCurrency(item))}
        </td>
        <td className="px-2 py-1 text-right whitespace-nowrap">
          {item.status === 'pending' ? (
            mayAct(item) && (
              <span className="inline-flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setActError('');
                    setActing({ item, mode: 'post', value: '' });
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-[0.75rem] font-medium text-primary-foreground max-lg:min-h-11"
                >
                  <Check size={13} /> {t('sync.inbox.post')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActError('');
                    setActing({ item, mode: 'dismiss', value: '' });
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-[0.75rem] text-muted-foreground hover:text-foreground max-lg:min-h-11"
                >
                  <X size={13} /> {t('sync.inbox.dismiss')}
                </button>
              </span>
            )
          ) : (
            <span className="text-[0.72rem] text-muted-foreground" title={item.note || undefined}>
              {t(item.status === 'posted' ? 'sync.inbox.posted' : 'sync.inbox.dismissed')}
              {item.decidedAt && ` · ${fmt.dateTime(item.decidedAt)}`}
              {item.decidedBy && ` · ${item.decidedBy}`}
            </span>
          )}
        </td>
      </tr>
    );
  };

  const table = (list: InboxItem[]) => (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-[0.8rem]">
        <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">{t('sync.inbox.kind')}</th>
            <th className="px-4 py-2 font-medium">{t('sync.inbox.from')}</th>
            <th className="px-4 py-2 font-medium">{t('sync.inbox.party')}</th>
            <th className="px-4 py-2 font-medium">{t('common.date')}</th>
            <th className="px-4 py-2 font-medium text-right">{t('common.amount')}</th>
            <th className="px-4 py-2">
              <span className="sr-only">{t('common.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>{list.map(row)}</tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.syncInbox')}</h1>
        <p className="text-[0.8rem] text-muted-foreground mt-0.5 max-w-2xl">
          {t('sync.inbox.subtitle', { erp: active?.name ?? '' })}
        </p>
      </div>

      {error && (
        <p className="text-[0.8rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
          ))}
        </div>
      ) : (
        <>
          <section aria-labelledby="inbox-pending" className="space-y-2">
            <h2 id="inbox-pending" className="text-[0.85rem] font-semibold text-foreground">
              {t('sync.inbox.pending')} ({fmt.number(pending.length)})
            </h2>
            {pending.length === 0 ? (
              <div className="rounded-xl border border-border bg-card p-10 text-center">
                <Inbox size={32} className="mx-auto text-muted-foreground mb-3 opacity-40" />
                <p className="text-[0.8rem] text-muted-foreground">{t('sync.inbox.empty')}</p>
              </div>
            ) : (
              table(pending)
            )}
          </section>
          {handled.length > 0 && (
            <section aria-labelledby="inbox-handled" className="space-y-2">
              <h2 id="inbox-handled" className="text-[0.85rem] font-semibold text-foreground">
                {t('sync.inbox.handled')}
              </h2>
              {table(handled)}
            </section>
          )}
        </>
      )}

      {acting && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setActing(null);
          }}
        >
          <form
            onSubmit={submit}
            role="dialog"
            aria-modal="true"
            aria-labelledby="inbox-act-title"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-5 space-y-4"
          >
            <h2 id="inbox-act-title" className="text-[1rem] font-semibold text-foreground">
              {t(acting.mode === 'post' ? 'sync.inbox.postTitle' : 'sync.inbox.dismissTitle', {
                kind: kindLabel(acting.item).toLowerCase(),
              })}
            </h2>
            {acting.mode === 'post' ? (
              <>
                <p className="text-[0.8rem] text-muted-foreground">{t('sync.inbox.postBody')}</p>
                {foreign(acting.item) && (
                  <label className="block">
                    <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                      {t('sync.inbox.rate', { base: base ?? '' })} · {docCurrency(acting.item)}
                    </span>
                    <input
                      inputMode="decimal"
                      value={acting.value}
                      onChange={(e) => setActing({ ...acting, value: e.target.value })}
                      className={`${inputCls} w-full`}
                    />
                    <span className="mt-1 block text-[0.68rem] text-muted-foreground">
                      {t('sync.inbox.rateHint')}
                    </span>
                  </label>
                )}
              </>
            ) : (
              <label className="block">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('sync.inbox.reason')}
                </span>
                <textarea
                  rows={2}
                  maxLength={500}
                  value={acting.value}
                  onChange={(e) => setActing({ ...acting, value: e.target.value })}
                  className={`${inputCls} w-full`}
                />
              </label>
            )}
            {actError && (
              <p className="text-[0.78rem] text-red-600 dark:text-red-400" role="alert">
                {actError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setActing(null)}
                disabled={busy}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {t(acting.mode === 'post' ? 'sync.inbox.post' : 'sync.inbox.dismiss')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
