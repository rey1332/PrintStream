'use client';

import React, { useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi } from '@/lib/terminal/client';
import type { RestColumn } from '@/lib/terminal/restSource';
import {
  HTML_FORMATS,
  WEB_FORMATS,
  parseWebSource,
  type WebField,
  type WebFormat,
  type WebSource,
} from '@/lib/terminal/webSource';
import { askWorker } from './connectorAsk';
import { Dialog, buttonCls, errorMessage, inputCls, primaryCls } from './shared';
import { ColumnTypesTable, SamplePreview } from './SourceColumns';

/** Examples in the inputs (selectors and paths, not translated). */
const EXAMPLE = {
  urls: '/harga\n/produk?page=1',
  sitemap: '/sitemap.xml',
  filter: '/produk/',
  next: 'a[rel=next]',
  table: 'table.harga',
  item: '.product-card',
  field: { name: 'price', selector: '.price', attr: 'href' },
  types: 'Product',
  records: 'data.items',
  record: 'item',
};

interface Preview {
  columns: RestColumn[];
  sample: Record<string, unknown>[];
  count: number;
  key: string | null;
}

/**
 * A sync of a website, in three steps: the pages (a list, or the sitemap,
 * and a "next page" link to follow), what to read in them (a table, repeated
 * items, JSON-LD, a feed or a file), checked by reading the first page, then
 * the columns and the key.
 */
export function WebSyncDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: { id: string; name: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  const [step, setStep] = useState(1);
  const [pages, setPages] = useState<'urls' | 'sitemap'>('urls');
  const [urls, setUrls] = useState('/');
  const [sitemap, setSitemap] = useState('');
  const [filter, setFilter] = useState('');
  const [next, setNext] = useState('');
  const [maxPages, setMaxPages] = useState(100);
  const [format, setFormat] = useState<WebFormat>('table');
  const [table, setTable] = useState('');
  const [item, setItem] = useState('');
  const [fields, setFields] = useState<WebField[]>([{ name: 'name', selector: '', attr: null }]);
  const [types, setTypes] = useState('');
  const [records, setRecords] = useState('');
  const [record, setRecord] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [columns, setColumns] = useState<RestColumn[]>([]);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const html = HTML_FORMATS.includes(format);
  const source = (): WebSource | null =>
    parseWebSource({
      mode: 'web',
      format,
      pages,
      urls: urls
        .split(/\r?\n/)
        .map((u) => u.trim())
        .filter(Boolean),
      sitemap: sitemap.trim() || null,
      filter: filter.trim() || null,
      next: html ? next.trim() || null : null,
      max_pages: maxPages,
      table: table.trim() || null,
      item: item.trim() || null,
      fields,
      types: types.trim() || null,
      records: records.trim(),
      record: record.trim() || null,
      key: key || null,
    });
  const valid = source() !== null;
  const changed = () => setPreview(null);

  const read = async () => {
    const s = source();
    if (!s) return;
    setWorking(true);
    setError('');
    try {
      const answer = await askWorker<Preview>(connection.id, { ...s, key: null });
      setPreview(answer);
      setColumns(answer.columns);
      if (!answer.columns.some((c) => c.name === key)) setKey(answer.key ?? '');
      if (!name.trim()) setName(`${connection.name} · ${t(`ps.web.format.${s.format}` as any)}`);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setWorking(false);
    }
  };

  const save = async () => {
    const s = source();
    if (!s || !columns.length) return;
    setWorking(true);
    setError('');
    try {
      await terminalApi('sync.createSource', {
        connectionId: connection.id,
        source: s,
        columns: columns.map((c) => ({ name: c.name, type: c.type })),
        datasetName: name,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setWorking(false);
    }
  };

  const input = (
    label: string,
    value: string,
    set: (v: string) => void,
    placeholder?: string,
    mono = true
  ) => (
    <label className="block text-[0.7rem] text-muted-foreground">
      {label}
      <input
        className={`${inputCls} ${mono ? 'font-mono' : ''}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          set(e.target.value);
          changed();
        }}
      />
    </label>
  );

  return (
    <Dialog title={t('ps.web.add')} onClose={onClose} wide>
      <p className="text-[0.7rem] text-muted-foreground">
        {t('ps.web.step', { n: step })} · {t(`ps.web.step${step}` as any)}
      </p>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {step === 1 && (
        <>
          <div className="flex gap-3 text-[0.75rem]" role="radiogroup">
            {(['urls', 'sitemap'] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="web-pages"
                  checked={pages === m}
                  onChange={() => {
                    setPages(m);
                    changed();
                  }}
                />
                {t(`ps.web.pages.${m}` as any)}
              </label>
            ))}
          </div>
          {pages === 'urls' ? (
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.web.urls')}
              <textarea
                className={`${inputCls} font-mono`}
                rows={4}
                spellCheck={false}
                placeholder={EXAMPLE.urls}
                value={urls}
                onChange={(e) => {
                  setUrls(e.target.value);
                  changed();
                }}
              />
            </label>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {input(t('ps.web.sitemap'), sitemap, setSitemap, EXAMPLE.sitemap)}
              {input(t('ps.web.filter'), filter, setFilter, EXAMPLE.filter)}
            </div>
          )}
          <label className="block text-[0.7rem] text-muted-foreground max-w-xs">
            {t('ps.web.max_pages')}
            <input
              type="number"
              min={1}
              max={1000}
              className={inputCls}
              value={maxPages}
              onChange={(e) => setMaxPages(Number(e.target.value))}
            />
          </label>
          <p className="text-[0.68rem] text-muted-foreground">{t('ps.web.manners')}</p>
        </>
      )}

      {step === 2 && (
        <>
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.web.format')}
            <select
              className={inputCls}
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as WebFormat);
                changed();
              }}
              style={{ colorScheme: 'light dark' }}
            >
              {WEB_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {t(`ps.web.format.${f}` as any)}
                </option>
              ))}
            </select>
          </label>
          {format === 'table' && input(t('ps.web.table'), table, setTable, EXAMPLE.table)}
          {format === 'list' && (
            <>
              {input(t('ps.web.item'), item, setItem, EXAMPLE.item)}
              <p className="text-[0.7rem] text-muted-foreground">{t('ps.web.fields')}</p>
              {fields.map((f, i) => (
                <div
                  key={i}
                  className="grid gap-1.5 sm:grid-cols-[1fr_1.5fr_1fr_auto] sm:items-end"
                >
                  {(['name', 'selector', 'attr'] as const).map((k) => (
                    <label key={k} className="block text-[0.68rem] text-muted-foreground">
                      {t(
                        k === 'name'
                          ? 'ps.web.fieldName'
                          : k === 'selector'
                            ? 'ps.web.fieldSelector'
                            : 'ps.web.fieldAttr'
                      )}
                      <input
                        className={`${inputCls} font-mono`}
                        value={f[k] ?? ''}
                        placeholder={EXAMPLE.field[k]}
                        onChange={(e) => {
                          const nextFields = [...fields];
                          nextFields[i] = {
                            ...f,
                            [k]: k === 'attr' ? e.target.value || null : e.target.value,
                          };
                          setFields(nextFields);
                          changed();
                        }}
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    className={buttonCls}
                    aria-label={t('ps.web.removeField')}
                    disabled={fields.length < 2}
                    onClick={() => {
                      setFields(fields.filter((_, k) => k !== i));
                      changed();
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={buttonCls}
                disabled={fields.length >= 50}
                onClick={() => setFields([...fields, { name: '', selector: '', attr: null }])}
              >
                <Plus size={11} /> {t('ps.web.addField')}
              </button>
            </>
          )}
          {format === 'jsonld' && input(t('ps.web.types'), types, setTypes, EXAMPLE.types)}
          {format === 'json' && input(t('ps.rest.records'), records, setRecords, EXAMPLE.records)}
          {format === 'xml' && input(t('ps.web.record'), record, setRecord, EXAMPLE.record)}
          {html && input(t('ps.web.next'), next, setNext, EXAMPLE.next)}
          <button type="button" className={buttonCls} disabled={working || !valid} onClick={read}>
            {working && <Loader2 size={11} className="animate-spin" />} {t('ps.web.preview')}
          </button>
          {preview && (
            <>
              <p className="text-[0.7rem] text-muted-foreground">
                {preview.count
                  ? t('ps.rest.previewCount', { count: fmt.number(preview.count) })
                  : t('ps.web.noRecords')}
              </p>
              <SamplePreview columns={preview.columns} sample={preview.sample} />
            </>
          )}
        </>
      )}

      {step === 3 && (
        <>
          <ColumnTypesTable
            columns={columns}
            onType={(i, type) => {
              const nextColumns = [...columns];
              nextColumns[i] = { ...columns[i], type };
              setColumns(nextColumns);
            }}
          />
          <label className="block text-[0.7rem] text-muted-foreground max-w-sm">
            {t('ps.dbs.key')}
            <select
              className={inputCls}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              style={{ colorScheme: 'light dark' }}
            >
              <option value="">{t('ps.dbs.noKey')}</option>
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[0.7rem] text-muted-foreground">
            {key ? t('ps.rest.howFull') : t('ps.rest.howNoKey')}
          </p>
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.sync.dataset')}
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </label>
        </>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={buttonCls}
          onClick={step === 1 ? onClose : () => setStep(step - 1)}
        >
          {step === 1 ? t('common.cancel') : t('ps.rest.back')}
        </button>
        {step < 3 ? (
          <button
            type="button"
            className={primaryCls}
            disabled={
              working ||
              (step === 1 && pages === 'urls' && !urls.trim()) ||
              (step === 2 && (!valid || !preview || !columns.length))
            }
            onClick={() => setStep(step + 1)}
          >
            {t('ps.rest.next')}
          </button>
        ) : (
          <button
            type="button"
            className={primaryCls}
            disabled={working || !columns.length || !name.trim() || !valid}
            onClick={save}
          >
            {working && <Loader2 size={13} className="animate-spin" />} {t('ps.sync.create')}
          </button>
        )}
      </div>
    </Dialog>
  );
}
