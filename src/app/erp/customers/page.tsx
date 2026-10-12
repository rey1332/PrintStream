'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '../lib/WorkspaceContext';
import { customerService, partyBalances, type PartyBalance } from '../lib/erpService';
import { Search, Plus, Pencil, Trash2, X, Check, Upload, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { tr } from '@/lib/i18n/translate';
import type { MessageKey } from '@/lib/i18n/messages';
import { Pagination, useServerPage } from '../components/Pagination';

interface Customer {
  id?: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  creditLimit?: number | null;
  createdAt?: string;
}

const emptyCustomer = (): Omit<Customer, 'id' | 'createdAt'> => ({
  name: '',
  email: '',
  phone: '',
  address: '',
  city: '',
});

interface ImportRow {
  row: number;
  data: Partial<Customer>;
  errors: MessageKey[];
  valid: boolean;
}

function splitCSVLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

function parseCustomerCSV(text: string): ImportRow[] {
  const clean = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = clean
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((line, idx) => {
    const cols = splitCSVLine(line);
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      raw[h] = cols[i] || '';
    });
    const data: Partial<Customer> = {
      name: raw['name'] || raw['customer_name'] || '',
      email: raw['email'] || '',
      phone: raw['phone'] || raw['phone_number'] || '',
      address: raw['address'] || '',
      city: raw['city'] || '',
    };
    const errors: MessageKey[] = [];
    if (!data.name) errors.push('party.nameRequired');
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email))
      errors.push('party.invalidEmail');
    return { row: idx + 2, data, errors, valid: errors.length === 0 };
  });
}

export default function CustomersPage() {
  const { user } = useAuth();
  const { can, hasModule } = useWorkspace();
  const canEdit = can('customers');
  const { t, fmt } = useI18n();
  // Entity names for the shared message templates.
  const ev = {
    entity: t('entity.customer.one'),
    entities: t('entity.customer.many'),
    Entity: t('entity.customer.title'),
    Entities: t('entity.customer.titleMany'),
  };
  // One page at a time, searched by the database.
  const list = useServerPage<Customer>(
    (q) => (user ? customerService.page(user.id, q) : Promise.resolve({ rows: [], total: 0 })),
    [user?.id]
  );
  const loading = list.loading;
  const [modal, setModal] = useState<{ mode: 'add' | 'edit'; data: Partial<Customer> } | null>(
    null
  );
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [importModal, setImportModal] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [importDone, setImportDone] = useState<{ success: number; failed: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadError = list.error
    ? (list.error instanceof Error && list.error.message) ||
      tr('party.loadFailed', { entities: tr('entity.customer.many') })
    : '';

  async function handleSave() {
    if (!modal || !user) return;
    if (!modal.data.name) {
      setError(t('party.nameRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await customerService.upsert(user.id, modal.data);
      list.reload();
      setModal(null);
      toast.success(t(modal.mode === 'add' ? 'party.added' : 'party.updated', ev));
    } catch (err: any) {
      setError(err?.message || t('party.saveFailed', ev));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!user) return;
    try {
      await customerService.remove(user.id, id);
      list.reload();
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast.success(t('party.deleted', ev));
    } catch (err: any) {
      toast.error(err?.message || t('party.deleteOneFailed', ev));
    }
    setDeleteId(null);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // The page shown: selects or clears its rows.
  const pageIds = list.items.map((c) => c.id!).filter(Boolean);
  // Calculated from invoices / orders and payments, for the rows on this page.
  const [balances, setBalances] = useState<Record<string, PartyBalance>>({});
  const pageKey = pageIds.join(',');
  useEffect(() => {
    let cancelled = false;
    partyBalances('customers', pageKey ? pageKey.split(',') : [])
      .then((map) => !cancelled && setBalances(map))
      .catch(() => !cancelled && setBalances({}));
    return () => {
      cancelled = true;
    };
  }, [pageKey]);
  const pageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) {
        if (pageSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  // ✅ FIX: pakai remove() loop, gak pake bulkRemove yang gak ada
  async function handleBulkDelete() {
    if (!user || selectedIds.size === 0) return;
    setBulkDeleting(true);

    const ids = Array.from(selectedIds);

    try {
      const results = await Promise.allSettled(
        ids.map((id) => customerService.remove(user.id, id))
      );

      const successIds: string[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') successIds.push(ids[i]);
        else console.error('[bulkDelete] failed for', ids[i], r.reason);
      });

      if (successIds.length > 0) {
        list.reload();
        setSelectedIds(new Set());

        if (successIds.length === ids.length) {
          toast.success(
            t('party.deletedN', {
              ...ev,
              entities: ids.length > 1 ? ev.entities : ev.entity,
              count: successIds.length,
            })
          );
        } else {
          toast.warning(
            t('party.deletedPartial', {
              done: successIds.length,
              total: ids.length,
              failed: ids.length - successIds.length,
            })
          );
        }
      } else {
        toast.error(t('party.deleteFailed'));
      }
    } catch (err: any) {
      console.error('[bulkDelete] unexpected error:', err);
      toast.error(err?.message || t('party.unexpected'));
    } finally {
      setBulkDeleting(false);
      setConfirmBulkDelete(false);
    }
  }

  async function handleDeleteAll() {
    if (!user || list.total === 0) return;
    setDeletingAll(true);

    try {
      // Every customer, not only the page shown.
      const ids = await customerService.allIds(user.id);
      const results = await Promise.allSettled(
        ids.map((id) => customerService.remove(user.id, id))
      );

      const successIds: string[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') successIds.push(ids[i]);
        else console.error('[deleteAll] failed for', ids[i], r.reason);
      });

      list.reload();
      setSelectedIds(new Set());

      if (successIds.length === ids.length) {
        toast.success(
          t('party.deletedAll', {
            ...ev,
            entities: ids.length > 1 ? ev.entities : ev.entity,
            count: successIds.length,
          })
        );
      } else if (successIds.length > 0) {
        toast.warning(t('party.deletedAllPartial', { done: successIds.length, total: ids.length }));
      } else {
        toast.error(t('party.deleteAllFailed'));
      }
    } catch (err: any) {
      console.error('[deleteAll] unexpected error:', err);
      toast.error(err?.message || t('party.deleteAllFailedShort'));
    } finally {
      setDeletingAll(false);
      setConfirmDeleteAll(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setImportRows(parseCustomerCSV(text));
      setImportDone(null);
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function handleImport() {
    if (!user) return;
    const valid = importRows.filter((r) => r.valid);
    if (!valid.length) return;
    setImporting(true);
    const CHUNK_SIZE = 200;
    let success = 0,
      failed = 0;
    for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
      const chunk = valid.slice(i, i + CHUNK_SIZE).map((r) => r.data);
      const { data, error } = await customerService.bulkInsert(user.id, chunk);
      if (error) failed += chunk.length;
      else {
        success += data.length;
        failed += chunk.length - data.length;
      }
    }
    list.reload();
    setImportDone({ success, failed });
    setImporting(false);
  }

  function downloadTemplate() {
    const csv =
      'name,email,phone,address,city\nJohn Doe,john@example.com,+1234567890,123 Main St,New York';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'customers_template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputCls =
    'w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input px-3 py-2 text-[0.8rem] text-zinc-900 dark:text-foreground placeholder:text-zinc-400 dark:placeholder:text-muted-foreground outline-none focus:border-zinc-400 dark:focus:border-foreground/40';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between max-lg:flex-wrap max-lg:gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{ev.Entities}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {loading ? t('common.loading') : t('party.totalCount', { ...ev, count: list.total })}
          </p>
        </div>
        <div className={`flex items-center gap-2 max-lg:flex-wrap ${canEdit ? '' : 'hidden'}`}>
          {selectedIds.size > 0 && (
            <button
              onClick={() => setConfirmBulkDelete(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/50 transition-all"
            >
              <Trash2 size={14} /> {t('common.deleteSelected', { count: selectedIds.size })}
            </button>
          )}
          {selectedIds.size === 0 && list.total > 0 && !list.search && (
            <button
              onClick={() => setConfirmDeleteAll(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium text-muted-foreground border border-border hover:text-foreground transition-all"
            >
              <Trash2 size={14} /> {t('common.deleteAll')}
            </button>
          )}
          <button
            onClick={() => {
              setImportModal(true);
              setImportRows([]);
              setImportDone(null);
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium text-muted-foreground border border-border hover:text-foreground transition-all"
          >
            <Upload size={14} /> {t('common.importCsv')}
          </button>
          <button
            onClick={() => {
              setModal({ mode: 'add', data: emptyCustomer() });
              setError('');
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground transition-all"
          >
            <Plus size={14} /> {t('party.add', ev)}
          </button>
        </div>
      </div>

      <div className="relative">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          className="w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input pl-9 pr-3 py-2 text-[0.8rem] text-zinc-900 dark:text-foreground placeholder:text-zinc-400 dark:placeholder:text-muted-foreground outline-none focus:border-zinc-400 dark:focus:border-foreground/40"
          placeholder={t('party.search')}
          value={list.search}
          onChange={(e) => list.setSearch(e.target.value)}
        />
      </div>

      {list.focusId && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-[var(--surface-2)] px-4 py-2 text-[0.78rem] text-muted-foreground">
          <span>{t('common.focusOnly')}</span>
          <button
            type="button"
            onClick={list.showAll}
            className="font-medium text-foreground underline"
          >
            {t('common.showAll')}
          </button>
        </div>
      )}
      {loadError && (
        <p role="alert" className="text-[0.8rem] text-red-600 dark:text-red-400">
          {loadError}
        </p>
      )}

      <div className="rounded-xl border border-border overflow-hidden bg-card">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-3 w-10">
                <input
                  type="checkbox"
                  checked={pageSelected}
                  onChange={toggleSelectAll}
                  className="accent-foreground cursor-pointer"
                />
              </th>
              {[
                t('common.name'),
                t('common.email'),
                t('common.phone'),
                t('common.city'),
                t('party.outstanding'),
                t('common.actions'),
              ].map((h) => (
                <th
                  key={h}
                  className="text-left px-4 py-3 text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('party.loading', ev)}
                </td>
              </tr>
            ) : (
              list.items.map((c, i) => (
                <tr
                  key={c.id}
                  {...list.focusAttrs(c.id)}
                  className={`border-b border-border ${i === list.items.length - 1 ? 'border-b-0' : ''}`}
                >
                  <td className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id!)}
                      onChange={() => toggleSelect(c.id!)}
                      className="accent-foreground cursor-pointer"
                    />
                  </td>
                  <td className="px-4 py-3 text-[0.8rem] font-medium text-foreground">{c.name}</td>
                  <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">{c.email}</td>
                  <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">{c.phone}</td>
                  <td className="px-4 py-3 text-[0.78rem] text-muted-foreground">{c.city}</td>
                  <td className="px-4 py-3 text-[0.78rem]">
                    {balances[c.id!] ? (
                      <>
                        <span className="font-semibold text-foreground">
                          {fmt.money(balances[c.id!].outstanding)}
                        </span>
                        {balances[c.id!].overdue > 0 && (
                          <span className="block text-[0.68rem] text-red-600 dark:text-red-400">
                            {t('party.overdue', { amount: fmt.money(balances[c.id!].overdue) })}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className={`flex items-center gap-2 ${canEdit ? '' : 'hidden'}`}>
                      <button
                        onClick={() => {
                          setModal({ mode: 'edit', data: { ...c } });
                          setError('');
                        }}
                        className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => setDeleteId(c.id!)}
                        className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
            {!loading && list.items.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-[0.8rem] text-muted-foreground"
                >
                  {t('party.none', ev)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination {...list.props} />
      </div>

      {importModal && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-2xl rounded-2xl border border-zinc-200 dark:border-border bg-white dark:bg-card flex flex-col max-h-[85vh] shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-border flex-shrink-0">
              <div>
                <h2 className="text-[1rem] font-semibold text-zinc-900 dark:text-foreground">
                  {t('party.importTitle', ev)}
                </h2>
                <p className="text-[0.72rem] text-zinc-500 dark:text-muted-foreground mt-0.5">
                  {t('party.columns')}
                </p>
              </div>
              <button
                onClick={() => setImportModal(false)}
                className="p-1 text-zinc-500 dark:text-muted-foreground hover:text-zinc-900 dark:hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground"
                >
                  <Upload size={14} /> {t('common.chooseCsv')}
                </button>
                <button
                  onClick={downloadTemplate}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.78rem] text-zinc-500 dark:text-muted-foreground border border-zinc-200 dark:border-border hover:text-zinc-900 dark:hover:text-foreground transition-colors"
                >
                  {t('party.downloadTemplate')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>
              {importRows.length === 0 && !importDone && (
                <p className="text-[0.78rem] text-zinc-500 dark:text-muted-foreground">
                  {t('party.choosePreview')}
                </p>
              )}
              {importRows.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[0.78rem] text-zinc-500 dark:text-muted-foreground">
                    {t('party.validErrors', {
                      valid: importRows.filter((r) => r.valid).length,
                      invalid: importRows.filter((r) => !r.valid).length,
                    })}
                  </p>
                  <div className="rounded-lg border border-zinc-200 dark:border-border overflow-hidden">
                    <div className="overflow-x-auto max-h-64 overflow-y-auto">
                      <table className="w-full text-[0.75rem]">
                        <thead className="sticky top-0 bg-zinc-100 dark:bg-surface-3">
                          <tr>
                            {[
                              t('party.row'),
                              t('common.name'),
                              t('common.email'),
                              t('common.city'),
                              t('common.status'),
                            ].map((h) => (
                              <th
                                key={h}
                                className="text-left px-3 py-2 text-zinc-500 dark:text-muted-foreground font-medium"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {importRows.map((row) => (
                            <tr
                              key={row.row}
                              className="border-t border-zinc-200 dark:border-border"
                            >
                              <td className="px-3 py-2 text-zinc-500 dark:text-muted-foreground">
                                {row.row}
                              </td>
                              <td className="px-3 py-2 text-zinc-900 dark:text-foreground">
                                {row.data.name || '—'}
                              </td>
                              <td className="px-3 py-2 text-zinc-500 dark:text-muted-foreground">
                                {row.data.email || '—'}
                              </td>
                              <td className="px-3 py-2 text-zinc-500 dark:text-muted-foreground">
                                {row.data.city || '—'}
                              </td>
                              <td className="px-3 py-2">
                                {row.valid ? (
                                  <span className="text-zinc-500 dark:text-muted-foreground text-[0.68rem]">
                                    {t('party.valid')}
                                  </span>
                                ) : (
                                  <span className="flex items-center gap-1 text-zinc-500 dark:text-muted-foreground text-[0.68rem]">
                                    <AlertCircle size={10} /> {t(row.errors[0])}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
              {importDone && (
                <div className="rounded-lg px-4 py-3 text-[0.8rem] bg-zinc-100 dark:bg-surface-3 border border-zinc-200 dark:border-border">
                  <p className="text-zinc-900 dark:text-foreground">
                    {t('party.importComplete')}{' '}
                    <span className="font-semibold">
                      {t('party.inserted', { count: importDone.success })}
                    </span>
                    {importDone.failed > 0 && (
                      <span className="text-zinc-500 dark:text-muted-foreground">
                        {t('party.failedCount', { count: importDone.failed })}
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-zinc-200 dark:border-border flex gap-2 flex-shrink-0">
              <button
                onClick={() => setImportModal(false)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-zinc-500 dark:text-muted-foreground border border-zinc-200 dark:border-border transition-colors"
              >
                {importDone ? t('common.close') : t('common.cancel')}
              </button>
              {!importDone && (
                <button
                  onClick={handleImport}
                  disabled={importing || importRows.filter((r) => r.valid).length === 0}
                  className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-40"
                >
                  {importing
                    ? t('common.importing')
                    : t('common.importRecords', {
                        count: importRows.filter((r) => r.valid).length,
                      })}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 dark:border-border bg-white dark:bg-card p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="text-[1rem] font-semibold text-zinc-900 dark:text-foreground">
                {t(modal.mode === 'add' ? 'party.add' : 'party.edit', ev)}
              </h2>
              <button
                onClick={() => setModal(null)}
                className="p-1 text-zinc-500 dark:text-muted-foreground hover:text-zinc-900 dark:hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {(['name', 'email', 'phone', 'address', 'city'] as const).map((field) => (
                <div key={field} className={field === 'address' ? 'col-span-2' : ''}>
                  <label className="block text-[0.7rem] text-zinc-500 dark:text-muted-foreground mb-1">
                    {t(`common.${field}`)}
                  </label>
                  <input
                    className={inputCls}
                    value={(modal.data as any)[field] || ''}
                    onChange={(e) =>
                      setModal({ ...modal, data: { ...modal.data, [field]: e.target.value } })
                    }
                  />
                </div>
              ))}
              {hasModule('weighbridge') && (
                <div className="col-span-2">
                  <label className="block text-[0.7rem] text-zinc-500 dark:text-muted-foreground mb-1">
                    {t('party.creditLimit')}
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className={inputCls}
                    value={modal.data.creditLimit ?? ''}
                    onChange={(e) =>
                      setModal({
                        ...modal,
                        data: {
                          ...modal.data,
                          creditLimit: e.target.value === '' ? null : Number(e.target.value),
                        },
                      })
                    }
                  />
                  <p className="mt-1 text-[0.68rem] text-zinc-500 dark:text-muted-foreground">
                    {t('party.creditLimitHelp')}
                  </p>
                </div>
              )}
            </div>
            {error && (
              <p className="text-[0.78rem] text-zinc-500 dark:text-muted-foreground bg-zinc-100 dark:bg-surface-3 rounded-lg px-3 py-2 border border-zinc-200 dark:border-border">
                {error}
              </p>
            )}
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setModal(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-zinc-500 dark:text-muted-foreground border border-zinc-200 dark:border-border transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {saving ? (
                  t('common.saving')
                ) : (
                  <>
                    <Check size={13} /> {t('common.save')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteId && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 dark:border-border bg-white dark:bg-card p-6 space-y-4 shadow-2xl">
            <h2 className="text-[1rem] font-semibold text-zinc-900 dark:text-foreground">
              {t('party.deleteOne', ev)}
            </h2>
            <p className="text-[0.8rem] text-zinc-500 dark:text-muted-foreground">
              {t('party.cannotUndo')}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setDeleteId(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-zinc-500 dark:text-muted-foreground border border-zinc-200 dark:border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-red-600 text-white"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmBulkDelete && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
          <div className="w-full max-w-sm rounded-2xl border border-zinc-200 dark:border-border bg-white dark:bg-card p-6 space-y-4 shadow-2xl">
            <h2 className="text-[1rem] font-semibold text-zinc-900 dark:text-foreground">
              {t('party.deleteMany', {
                ...ev,
                Entities: selectedIds.size > 1 ? ev.Entities : ev.Entity,
                count: selectedIds.size,
              })}
            </h2>
            <p className="text-[0.8rem] text-zinc-500 dark:text-muted-foreground">
              {t('party.cannotUndo')}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmBulkDelete(false)}
                disabled={bulkDeleting}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-zinc-500 dark:text-muted-foreground border border-zinc-200 dark:border-border disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-red-600 text-white disabled:opacity-50"
              >
                {bulkDeleting ? t('common.deleting') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteAll && (
        <div className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80">
          <div className="w-full max-w-sm rounded-2xl border border-red-500/40 bg-white dark:bg-card p-6 space-y-4 shadow-2xl">
            <h2 className="text-[1rem] font-semibold text-zinc-900 dark:text-foreground">
              {t('party.deleteAllTitle', { ...ev, count: list.total })}
            </h2>
            <p className="text-[0.8rem] text-zinc-500 dark:text-muted-foreground">
              {t('party.deleteAllBody', ev)}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDeleteAll(false)}
                disabled={deletingAll}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-zinc-500 dark:text-muted-foreground border border-zinc-200 dark:border-border disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDeleteAll}
                disabled={deletingAll}
                className="flex-1 py-2 rounded-lg text-[0.8rem] font-medium bg-red-600 text-white disabled:opacity-50"
              >
                {deletingAll ? t('common.deleting') : t('common.deleteAll')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
