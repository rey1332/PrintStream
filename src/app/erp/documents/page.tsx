'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { DOCUMENT_ACCEPT, MAX_DOCUMENT_BYTES } from '@/lib/workspaces/limits';
import { useWorkspace } from '../lib/WorkspaceContext';
import { rpcWorkspaceId } from '../lib/workspace';

interface DocumentRow {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: string | null;
  canDelete: boolean;
}

const ERRORS: Record<string, MessageKey> = {
  fileType: 'docs.error.fileType',
  tooLarge: 'docs.error.tooLarge',
  too_large: 'docs.error.tooLarge',
  quota_exceeded: 'docs.error.quota',
  empty: 'docs.error.empty',
  documents_full: 'docs.error.full',
  forbidden: 'docs.error.forbidden',
  notFound: 'docs.error.notFound',
};

class DocumentsApiError extends Error {}

async function documentsApi<T>(body: BodyInit, json: boolean): Promise<T> {
  const response = await fetch('/api/erp/documents', {
    method: 'POST',
    headers: json ? { 'Content-Type': 'application/json' } : undefined,
    body,
    cache: 'no-store',
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success)
    throw new DocumentsApiError(String(result?.error ?? 'failed'));
  return result.data as T;
}

export default function DocumentsPage() {
  const { t, fmt } = useI18n();
  const { active, ready } = useWorkspace();
  const inputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const message = useCallback(
    (error: unknown) =>
      t(ERRORS[error instanceof DocumentsApiError ? error.message : ''] ?? 'docs.error.failed'),
    [t]
  );
  const workspaceId = active?.id ?? null;

  const load = useCallback(async () => {
    setError('');
    try {
      setDocuments(
        await documentsApi<DocumentRow[]>(
          JSON.stringify({ action: 'list', workspaceId: rpcWorkspaceId() }),
          true
        )
      );
    } catch (err) {
      setDocuments([]);
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void load();
  }, [ready, workspaceId, load]);

  async function upload(file: File) {
    if (file.size > MAX_DOCUMENT_BYTES) {
      toast.error(t('docs.error.tooLarge'));
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('workspaceId', rpcWorkspaceId() ?? '');
      form.append('file', file);
      await documentsApi(form, false);
      toast.success(t('docs.uploaded', { name: file.name }));
      await load();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setUploading(false);
    }
  }

  async function remove(doc: DocumentRow) {
    if (!window.confirm(t('docs.confirmDelete', { name: doc.fileName }))) return;
    try {
      await documentsApi(JSON.stringify({ action: 'delete', id: doc.id }), true);
      toast.success(t('docs.deleted'));
      setDocuments((rows) => rows.filter((row) => row.id !== doc.id));
    } catch (err) {
      toast.error(message(err));
    }
  }

  const size = (bytes: number) =>
    bytes >= 1024 * 1024
      ? fmt.number(bytes / (1024 * 1024), {
          style: 'unit',
          unit: 'megabyte',
          maximumFractionDigits: 1,
        })
      : fmt.number(Math.max(1, Math.round(bytes / 1024)), { style: 'unit', unit: 'kilobyte' });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('nav.file.documents')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {t('docs.subtitle', { erp: active?.name ?? 'ERP' })}
          </p>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={DOCUMENT_ACCEPT}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading || !ready}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
        >
          {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
          {uploading ? t('docs.uploading') : t('docs.upload')}
        </button>
      </div>

      {error && (
        <p className="text-[0.8rem] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
          ))}
        </div>
      ) : documents.length === 0 && !error ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Paperclip size={32} className="mx-auto text-muted-foreground mb-3 opacity-40" />
          <p className="text-[0.8rem] text-muted-foreground max-w-sm mx-auto">{t('docs.empty')}</p>
        </div>
      ) : documents.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-[0.8rem]">
            <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('docs.col.name')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('docs.col.size')}</th>
                <th className="px-4 py-2 font-medium max-md:hidden">{t('docs.col.uploadedBy')}</th>
                <th className="px-4 py-2 font-medium max-sm:hidden">{t('docs.col.date')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr key={doc.id} className="border-t border-border">
                  <td className="px-4 py-2 max-w-[18rem]">
                    <span className="flex items-center gap-2 min-w-0">
                      <FileText size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate text-foreground" title={doc.fileName}>
                        {doc.fileName}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                    {size(doc.sizeBytes)}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground truncate max-w-[14rem] max-md:hidden">
                    {doc.uploadedBy ?? t('docs.unknownUploader')}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground whitespace-nowrap max-sm:hidden">
                    {fmt.dateTime(doc.createdAt)}
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    <a
                      href={`/api/erp/documents/${doc.id}`}
                      download
                      aria-label={t('docs.download', { name: doc.fileName })}
                      title={t('docs.download', { name: doc.fileName })}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                    >
                      <Download size={14} />
                    </a>
                    {doc.canDelete && (
                      <button
                        type="button"
                        onClick={() => void remove(doc)}
                        aria-label={t('docs.delete', { name: doc.fileName })}
                        title={t('docs.delete', { name: doc.fileName })}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-red-600 max-lg:h-11 max-lg:w-11"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
