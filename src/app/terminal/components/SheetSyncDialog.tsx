'use client';

import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi } from '@/lib/terminal/client';
import type { RestColumn } from '@/lib/terminal/restSource';
import { parseSheetSource, type SheetProvider, type SheetSource } from '@/lib/terminal/sheetSource';
import { askWorker } from './connectorAsk';
import { Dialog, buttonCls, errorMessage, inputCls, primaryCls } from './shared';
import { ColumnTypesTable, SamplePreview } from './SourceColumns';

const EXAMPLE: Record<SheetProvider, string> = {
  google: 'https://docs.google.com/spreadsheets/d/1AbC…/edit#gid=0',
  microsoft: 'https://contoso.sharepoint.com/:x:/s/finance/EAbC…',
};

interface Preview {
  columns: RestColumn[];
  sample: Record<string, unknown>[];
  count: number;
  key: string | null;
  sheets: string[] | null;
}

/**
 * A sync of one tab of a spreadsheet, in two steps: the sheet (its address,
 * tab, range and header row), checked by reading it, then the columns and
 * the key.
 */
export function SheetSyncDialog({
  connection,
  onClose,
  onSaved,
}: {
  connection: { id: string; name: string; config?: Record<string, unknown> };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  const provider: SheetProvider =
    connection.config?.provider === 'microsoft' ? 'microsoft' : 'google';
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState('');
  const [sheet, setSheet] = useState('');
  const [range, setRange] = useState('');
  const [headerRow, setHeaderRow] = useState(1);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [columns, setColumns] = useState<RestColumn[]>([]);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const source = (): SheetSource | null =>
    parseSheetSource(
      {
        mode: 'sheet',
        url,
        sheet: sheet.trim() || null,
        range: range.trim() || null,
        header_row: headerRow,
        key: key || null,
      },
      provider
    );
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
      if (!name.trim()) setName(`${connection.name} · ${s.sheet ?? answer.sheets?.[0] ?? 'Sheet'}`);
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

  return (
    <Dialog title={t('ps.sheet.add')} onClose={onClose} wide>
      <p className="text-[0.7rem] text-muted-foreground">
        {t('ps.sheet.step', { n: step })} · {t(step === 1 ? 'ps.sheet.step1' : 'ps.sheet.step2')}
      </p>
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {step === 1 && (
        <>
          <label className="block text-[0.7rem] text-muted-foreground">
            {t(provider === 'google' ? 'ps.sheet.urlGoogle' : 'ps.sheet.urlMicrosoft')}
            <input
              className={`${inputCls} font-mono`}
              value={url}
              placeholder={EXAMPLE[provider]}
              onChange={(e) => {
                setUrl(e.target.value);
                changed();
              }}
            />
          </label>
          <p className="text-[0.68rem] text-muted-foreground">
            {t(
              provider === 'microsoft'
                ? 'ps.sheet.urlHintMicrosoft'
                : connection.config?.google_auth === 'service_account'
                  ? 'ps.sheet.urlHintService'
                  : 'ps.sheet.urlHintLink'
            )}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.sheet.tab')}
              {preview?.sheets?.length ? (
                <select
                  className={inputCls}
                  value={sheet}
                  onChange={(e) => {
                    setSheet(e.target.value);
                    changed();
                  }}
                  style={{ colorScheme: 'light dark' }}
                >
                  <option value="">{t('ps.sheet.firstTab')}</option>
                  {preview.sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputCls}
                  value={sheet}
                  placeholder={t('ps.sheet.firstTab')}
                  onChange={(e) => {
                    setSheet(e.target.value);
                    changed();
                  }}
                />
              )}
            </label>
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.sheet.range')}
              <input
                className={`${inputCls} font-mono`}
                value={range}
                placeholder="A1:H500"
                onChange={(e) => {
                  setRange(e.target.value);
                  changed();
                }}
              />
            </label>
            <label className="block text-[0.7rem] text-muted-foreground">
              {t('ps.sheet.headerRow')}
              <input
                type="number"
                min={1}
                max={50}
                className={inputCls}
                value={headerRow}
                onChange={(e) => {
                  setHeaderRow(Math.max(1, Math.min(50, Number(e.target.value) || 1)));
                  changed();
                }}
              />
            </label>
          </div>
          <button type="button" className={buttonCls} disabled={working || !valid} onClick={read}>
            {working && <Loader2 size={11} className="animate-spin" />} {t('ps.sheet.read')}
          </button>
          {url.trim() && !valid && (
            <p className="text-[0.7rem] text-red-600 dark:text-red-400">{t('ps.sheet.badUrl')}</p>
          )}
          {preview && (
            <>
              <p className="text-[0.7rem] text-muted-foreground">
                {preview.count
                  ? t('ps.rest.previewCount', { count: fmt.number(preview.count) })
                  : t('ps.sheet.noRows')}
              </p>
              <SamplePreview columns={preview.columns} sample={preview.sample} />
            </>
          )}
        </>
      )}

      {step === 2 && (
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
          onClick={step === 1 ? onClose : () => setStep(1)}
        >
          {step === 1 ? t('common.cancel') : t('ps.rest.back')}
        </button>
        {step === 1 ? (
          <button
            type="button"
            className={primaryCls}
            disabled={working || !valid || !preview || !columns.length}
            onClick={() => setStep(2)}
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
