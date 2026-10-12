'use client';

import React, { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi, type DatasetInfo, type Overview } from '@/lib/terminal/client';
import { DATASET_WRITE_MODES } from '@/lib/workflow/runtime';
import { useWorkspace } from '@/app/erp/lib/WorkspaceContext';

// Same mapping as src/server/terminal/datasets.ts FIELD_TYPES (that file is server-only).
const FIELD_TYPE: Record<string, string> = {
  text: 'text',
  integer: 'integer',
  decimal: 'number',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'datetime',
  json: 'text',
};

const inputCls =
  'w-full rounded-md border border-border bg-input px-2.5 py-1.5 text-[0.75rem] text-foreground outline-none focus:border-foreground/40';

/**
 * Settings of the TERMINAL dataset nodes: which dataset, how many rows to read
 * (Dataset) or how to write (Write to dataset). Picking a dataset for reading
 * stores its column names, so the next steps can offer them.
 */
export default function DatasetNodePanel({
  type,
  config,
  onChange,
}: {
  type: 'src.psDataset' | 'out.psDataset';
  config: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
}) {
  const { t } = useI18n();
  const { active } = useWorkspace();
  const [datasets, setDatasets] = useState<DatasetInfo[] | null>(null);

  useEffect(() => {
    if (!active?.id) return;
    terminalApi<Overview>('overview', { workspaceId: active.id })
      .then((o) =>
        setDatasets(o.datasets.filter((d) => d.status === 'ready' || d.status === 'altering'))
      )
      .catch(() => setDatasets([]));
  }, [active?.id]);

  const pick = (id: string) => {
    const ds = datasets?.find((d) => d.id === id);
    const columns = ds?.columns
      .filter((c) => !c.hidden && c.provisioned)
      .map((c) => ({ name: c.label, type: FIELD_TYPE[c.type] ?? 'text' }));
    onChange(
      type === 'src.psDataset'
        ? { ...config, datasetId: id, columns }
        : { ...config, datasetId: id }
    );
  };

  return (
    <div className="p-4 border-b space-y-3" style={{ borderColor: 'var(--border)' }}>
      <p className="text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
        {t('wf.configuration')}
      </p>
      <label className="block text-[0.7rem] text-muted-foreground">
        {t('wf.field.datasetId')}
        {datasets === null ? (
          <p className="text-[0.7rem]">{t('wf.ds.loading')}</p>
        ) : datasets.length === 0 ? (
          <p className="text-[0.7rem]">{t('wf.ds.none')}</p>
        ) : (
          <select
            className={inputCls}
            value={config.datasetId ?? ''}
            onChange={(e) => pick(e.target.value)}
            style={{ colorScheme: 'light dark' }}
          >
            <option value="">{t('wf.err.pickDataset')}</option>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.folder ? `${d.folder} / ${d.name}` : d.name}
              </option>
            ))}
          </select>
        )}
      </label>
      {type === 'src.psDataset' ? (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('wf.field.n')}
          <input
            type="number"
            min={1}
            max={100000}
            className={inputCls}
            value={config.limit ?? 10000}
            onChange={(e) => onChange({ ...config, limit: Number(e.target.value) })}
          />
        </label>
      ) : (
        <>
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('wf.field.mode')}
            <select
              className={inputCls}
              value={config.mode ?? 'append'}
              onChange={(e) => onChange({ ...config, mode: e.target.value })}
              style={{ colorScheme: 'light dark' }}
            >
              {DATASET_WRITE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(`ps.mode.${m}` as any)}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[0.62rem] text-muted-foreground">{t('wf.ds.matchHint')}</p>
        </>
      )}
    </div>
  );
}
