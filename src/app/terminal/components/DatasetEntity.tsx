'use client';

import React, { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { ONTOLOGY_TYPES } from '@/lib/ontology/registry';
import { terminalApi, type Overview } from '@/lib/terminal/client';
import { PEOPLE_TYPES } from '@/lib/terminal/insights';
import { buttonCls, errorMessage, inputCls } from './shared';

interface Entity {
  entity_type: string;
  label: string | null;
  key_column: string | null;
  about_people: boolean;
  relations: { column: string; target_dataset?: string; target_type?: string }[];
}

const CUSTOM = '__custom';
/** Example of a type of the company's own (an identifier, not translated). */
const TYPE_EXAMPLE = 'weighTicket';

/**
 * What a dataset holds (ontology, R-44): one of the ERP's entity types or a
 * type of the company's own, its key column, which columns refer to other
 * entities, and whether it is about people (analyses then follow the
 * Owner's policy). Insights pass this meaning to an AI narrative.
 */
export function DatasetEntity({
  datasetId,
  workspaceId,
  columns,
  editable,
}: {
  datasetId: string;
  workspaceId: string;
  columns: string[];
  editable: boolean;
}) {
  const { t } = useI18n();
  const [entity, setEntity] = useState<Entity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [type, setType] = useState('');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    terminalApi<Overview>('overview', { workspaceId })
      .then((o) => setDatasets(o.datasets.map((d) => ({ id: d.id, name: d.name }))))
      .catch(() => setDatasets([]));
  }, [workspaceId]);

  useEffect(() => {
    terminalApi<Entity | null>('dataset.entity.get', { datasetId })
      .then((e) => {
        setEntity(e);
        const known = e && (ONTOLOGY_TYPES as readonly string[]).includes(e.entity_type);
        setType(e ? (known ? e.entity_type : CUSTOM) : '');
        setCustom(e && !known ? e.entity_type : '');
      })
      .catch((e) => toast.error(errorMessage(e, t)))
      .finally(() => setLoaded(true));
  }, [datasetId, t]);

  const draft: Entity = entity ?? {
    entity_type: '',
    label: null,
    key_column: null,
    about_people: false,
    relations: [],
  };
  const patch = (p: Partial<Entity>) => setEntity({ ...draft, ...p });
  const entityType = type === CUSTOM ? custom.trim() : type;

  const save = async (remove = false) => {
    setBusy(true);
    try {
      await terminalApi('dataset.entity.set', {
        datasetId,
        entityType: remove ? null : entityType,
        label: draft.label,
        keyColumn: draft.key_column,
        aboutPeople: draft.about_people || PEOPLE_TYPES.includes(entityType.toLowerCase()),
        relations: draft.relations.filter((r) => r.column),
      });
      if (remove) {
        setEntity(null);
        setType('');
      }
      toast.success(t('ps.ai.saved'));
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <div className="h-24 rounded-xl animate-pulse bg-[var(--surface-3)]" />;
  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3 text-[0.75rem]">
      <p className="text-muted-foreground max-w-3xl">{t('ps.ent.intro')}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ent.type')}
          <select
            className={inputCls}
            value={type}
            disabled={!editable}
            onChange={(e) => setType(e.target.value)}
            style={{ colorScheme: 'light dark' }}
          >
            <option value="">{t('ps.ent.none')}</option>
            {ONTOLOGY_TYPES.map((k) => (
              <option key={k} value={k}>
                {t(`onto.type.${k}` as any)}
              </option>
            ))}
            <option value={CUSTOM}>{t('ps.ent.custom')}</option>
          </select>
        </label>
        {type === CUSTOM && (
          <label className="block text-[0.7rem] text-muted-foreground">
            {t('ps.ent.customType')}
            <input
              className={`${inputCls} font-mono`}
              placeholder={TYPE_EXAMPLE}
              value={custom}
              disabled={!editable}
              onChange={(e) => setCustom(e.target.value)}
            />
          </label>
        )}
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ent.label')}
          <input
            className={inputCls}
            maxLength={80}
            value={draft.label ?? ''}
            disabled={!editable}
            onChange={(e) => patch({ label: e.target.value })}
          />
        </label>
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ent.key')}
          <select
            className={inputCls}
            value={draft.key_column ?? ''}
            disabled={!editable}
            onChange={(e) => patch({ key_column: e.target.value || null })}
            style={{ colorScheme: 'light dark' }}
          >
            <option value="">{t('ps.dbs.noKey')}</option>
            {columns.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-1.5">
        <input
          type="checkbox"
          disabled={!editable}
          checked={draft.about_people || PEOPLE_TYPES.includes(entityType.toLowerCase())}
          onChange={(e) => patch({ about_people: e.target.checked })}
        />
        {t('ps.ent.aboutPeople')}
      </label>
      <div className="space-y-1.5">
        <p className="text-[0.7rem] text-muted-foreground">{t('ps.ent.links')}</p>
        {draft.relations.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5">
            <select
              className="rounded border border-border bg-transparent px-1 py-0.5"
              aria-label={t('ps.dbs.column')}
              value={r.column}
              disabled={!editable}
              onChange={(e) =>
                patch({
                  relations: draft.relations.map((x, k) =>
                    k === i ? { ...x, column: e.target.value } : x
                  ),
                })
              }
              style={{ colorScheme: 'light dark' }}
            >
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="text-muted-foreground">→</span>
            <select
              className="rounded border border-border bg-transparent px-1 py-0.5"
              aria-label={t('ps.ent.target')}
              value={r.target_dataset ?? ''}
              disabled={!editable}
              onChange={(e) =>
                patch({
                  relations: draft.relations.map((x, k) =>
                    k === i ? { ...x, target_dataset: e.target.value || undefined } : x
                  ),
                })
              }
              style={{ colorScheme: 'light dark' }}
            >
              <option value="">{t('ps.ent.pickDataset')}</option>
              {datasets
                .filter((d) => d.id !== datasetId)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
            {editable && (
              <button
                type="button"
                className={buttonCls}
                aria-label={t('ps.web.removeField')}
                onClick={() => patch({ relations: draft.relations.filter((_, k) => k !== i) })}
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        ))}
        {editable && columns.length > 0 && (
          <button
            type="button"
            className={buttonCls}
            onClick={() => patch({ relations: [...draft.relations, { column: columns[0] }] })}
          >
            <Plus size={11} /> {t('ps.ent.addLink')}
          </button>
        )}
      </div>
      {editable && (
        <div className="flex gap-1.5">
          <button
            type="button"
            className={buttonCls}
            disabled={busy || !entityType}
            onClick={() => save()}
          >
            {t('common.save')}
          </button>
          {entity && (
            <button type="button" className={buttonCls} disabled={busy} onClick={() => save(true)}>
              {t('ps.ent.clear')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
