'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi } from '@/lib/terminal/client';
import { AI_KINDS, AI_KIND_DEFS, type AiKind } from '@/lib/terminal/aiProviders';
import { Dialog, Empty, Status, buttonCls, errorMessage, inputCls, primaryCls } from './shared';

export interface AiProvider {
  id: string;
  kind: AiKind;
  name: string;
  config: Record<string, any>;
  allow_personal_keys: boolean;
  enabled: boolean;
  has_secret: boolean;
  status: 'untested' | 'ok' | 'failed';
  last_error_key: string | null;
  last_tested_at: string | null;
  my_key: boolean;
}

export interface AiOverview {
  providers: AiProvider[];
  policies: {
    provider_id: string;
    dataset_id: string;
    allowed: boolean;
    sensitive_columns: string[];
    sample_rows: number;
  }[];
  budget: {
    limit: string | number | null;
    spent: string | number;
    currency: string;
    people_decisions: 'review' | 'automate';
  };
  usage: {
    provider_name: string;
    personal_key: boolean;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    calls: number;
  }[];
  datasets: {
    id: string;
    name: string;
    folder: string;
    columns: { label: string; type: string; sensitive: boolean }[];
  }[];
  isOwner: boolean;
}

export function useAiOverview(workspaceId: string) {
  const { t } = useI18n();
  const [data, setData] = useState<AiOverview | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await terminalApi<AiOverview>('ai.overview', { workspaceId }));
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  }, [workspaceId, t]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, load };
}

/**
 * The workspace's AI: providers (managers of connections, two-factor), what
 * each may see of each dataset (policy managers, two-factor; denied until
 * allowed), the monthly budget and the Owner's rule for analyses about
 * people, this month's use, and members' own keys where a provider takes them.
 */
export function AiSettings({
  workspaceId,
  permissions,
}: {
  workspaceId: string;
  permissions: string[];
}) {
  const { t, fmt } = useI18n();
  const { data, load } = useAiOverview(workspaceId);
  const [editing, setEditing] = useState<Partial<AiProvider> | null>(null);
  const [policyFor, setPolicyFor] = useState<string>('');
  const manage = permissions.includes('integrations.manage');
  const policies = permissions.includes('policies.manage');

  const act = async (action: string, payload: Record<string, unknown>, done?: string) => {
    try {
      await terminalApi(action, payload);
      if (done) toast.success(done);
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };

  if (!data) return <div className="h-32 rounded-xl animate-pulse bg-[var(--surface-3)]" />;
  const provider = data.providers.find((p) => p.id === policyFor) ?? data.providers[0] ?? null;
  const limit = data.budget.limit === null ? null : Number(data.budget.limit);
  const spent = Number(data.budget.spent);

  return (
    <div className="space-y-4">
      <p className="text-[0.75rem] text-muted-foreground max-w-3xl">{t('ps.ai.intro')}</p>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[0.85rem] font-semibold text-foreground flex items-center gap-1.5">
            <Bot size={14} /> {t('ps.ai.providers')}
          </h2>
          {manage && (
            <button type="button" className={primaryCls} onClick={() => setEditing({})}>
              <Plus size={13} /> {t('ps.ai.addProvider')}
            </button>
          )}
        </div>
        {data.providers.length === 0 ? (
          <Empty icon={Bot} title={t('ps.ai.noProviders')} hint={t('ps.ai.noProvidersHint')} />
        ) : (
          data.providers.map((p) => (
            <div key={p.id} className="rounded-lg border border-border px-3 py-2 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2 text-[0.75rem]">
                <span className="font-medium text-foreground">{p.name}</span>
                <span className="text-muted-foreground">
                  {t(`ps.ai.kind.${p.kind}` as any)} · {p.config.model}
                </span>
                <Status value={`conn_${p.status === 'untested' ? 'untested' : p.status}`} />
                {!p.enabled && <span className="text-muted-foreground">{t('ps.ai.off')}</span>}
                {p.last_error_key && p.status === 'failed' && (
                  <span className="text-red-600 dark:text-red-400">
                    {t('ps.job.error', { code: p.last_error_key })}
                  </span>
                )}
                <span className="ml-auto flex gap-1">
                  {manage && (
                    <>
                      <button
                        type="button"
                        className={buttonCls}
                        onClick={() => act('ai.provider.test', { id: p.id }, t('ps.conn.testing'))}
                      >
                        <RefreshCw size={11} /> {t('ps.conn.test')}
                      </button>
                      <button type="button" className={buttonCls} onClick={() => setEditing(p)}>
                        <Pencil size={11} /> {t('ps.conn.edit')}
                      </button>
                      <button
                        type="button"
                        className={`${buttonCls} hover:text-red-500`}
                        aria-label={t('ps.ds.delete')}
                        onClick={() =>
                          confirm(t('ps.ai.removeConfirm', { name: p.name })) &&
                          act('ai.provider.delete', { id: p.id })
                        }
                      >
                        <Trash2 size={11} />
                      </button>
                    </>
                  )}
                </span>
              </div>
              <p className="text-[0.68rem] text-muted-foreground">
                {t('ps.ai.capabilities', {
                  context: fmt.number(Number(p.config.context_tokens ?? 0)),
                  json: p.config.json_output ? t('ps.ai.yes') : t('ps.ai.no'),
                  tools: p.config.tools ? t('ps.ai.yes') : t('ps.ai.no'),
                })}{' '}
                {t('ps.ai.prices', {
                  input: fmt.number(Number(p.config.price_in ?? 0)),
                  output: fmt.number(Number(p.config.price_out ?? 0)),
                  currency: data.budget.currency,
                })}
              </p>
              {p.allow_personal_keys && <PersonalKey provider={p} onSaved={load} />}
            </div>
          ))
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="text-[0.85rem] font-semibold text-foreground flex items-center gap-1.5">
          <ShieldCheck size={14} /> {t('ps.ai.sharing')}
        </h2>
        <p className="text-[0.72rem] text-muted-foreground max-w-3xl">{t('ps.ai.sharingIntro')}</p>
        {!provider ? (
          <p className="text-[0.72rem] text-muted-foreground">{t('ps.ai.noProviders')}</p>
        ) : (
          <>
            <label className="block text-[0.7rem] text-muted-foreground max-w-xs">
              {t('ps.ai.provider')}
              <select
                className={inputCls}
                value={provider.id}
                onChange={(e) => setPolicyFor(e.target.value)}
                style={{ colorScheme: 'light dark' }}
              >
                {data.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="space-y-1.5">
              {data.datasets.map((d) => (
                <PolicyRow
                  key={`${provider.id}:${d.id}`}
                  dataset={d}
                  policy={
                    data.policies.find(
                      (x) => x.provider_id === provider.id && x.dataset_id === d.id
                    ) ?? null
                  }
                  editable={policies}
                  onSave={(next) =>
                    act(
                      'ai.policy.set',
                      { providerId: provider.id, datasetId: d.id, ...next },
                      t('ps.ai.saved')
                    )
                  }
                />
              ))}
              {data.datasets.length === 0 && (
                <p className="text-[0.72rem] text-muted-foreground">{t('ps.ai.noDatasets')}</p>
              )}
            </div>
          </>
        )}
      </section>

      <BudgetSection
        data={data}
        editable={policies}
        onSave={(b) => act('ai.settings.set', { workspaceId, ...b }, t('ps.ai.saved'))}
      />

      <section className="rounded-xl border border-border bg-card p-4 space-y-2">
        <h2 className="text-[0.85rem] font-semibold text-foreground">{t('ps.ai.usage')}</h2>
        <p className="text-[0.72rem] text-muted-foreground">
          {limit === null
            ? t('ps.ai.noBudgetSet')
            : t('ps.ai.spentOf', {
                spent: fmt.number(spent),
                limit: fmt.number(limit),
                currency: data.budget.currency,
              })}
        </p>
        {data.usage.length > 0 && (
          <table className="w-full text-[0.72rem]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-left font-medium">{t('ps.ai.provider')}</th>
                <th className="py-1 text-right font-medium">{t('ps.ai.calls')}</th>
                <th className="py-1 text-right font-medium">{t('ps.ai.tokens')}</th>
                <th className="py-1 text-right font-medium">{t('ps.ai.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.map((u) => (
                <tr key={`${u.provider_name}:${u.personal_key}`} className="border-t border-border">
                  <td className="py-1">
                    {u.provider_name}
                    {u.personal_key ? ` (${t('ps.ai.personalKeyShort')})` : ''}
                  </td>
                  <td className="py-1 text-right">{fmt.number(u.calls)}</td>
                  <td className="py-1 text-right">
                    {fmt.number(u.input_tokens + u.output_tokens)}
                  </td>
                  <td className="py-1 text-right">
                    {fmt.number(u.cost)} {data.budget.currency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <ProviderDialog
          workspaceId={workspaceId}
          provider={editing}
          currency={data.budget.currency}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function PersonalKey({ provider, onSaved }: { provider: AiProvider; onSaved: () => void }) {
  const { t } = useI18n();
  const [key, setKey] = useState('');
  const save = async (value: string | null) => {
    try {
      await terminalApi('ai.personalKey.set', { providerId: provider.id, key: value });
      setKey('');
      toast.success(t('ps.ai.saved'));
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e, t));
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-1.5 text-[0.7rem]">
      <label className="block text-muted-foreground">
        <KeyRound size={11} className="inline" />{' '}
        {provider.my_key ? t('ps.ai.myKeySet') : t('ps.ai.myKey')}
        <input
          className={inputCls}
          type="password"
          autoComplete="new-password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <button type="button" className={buttonCls} disabled={!key.trim()} onClick={() => save(key)}>
        {t('common.save')}
      </button>
      {provider.my_key && (
        <button type="button" className={buttonCls} onClick={() => save(null)}>
          {t('ps.ai.removeMyKey')}
        </button>
      )}
    </div>
  );
}

function PolicyRow({
  dataset,
  policy,
  editable,
  onSave,
}: {
  dataset: AiOverview['datasets'][number];
  policy: AiOverview['policies'][number] | null;
  editable: boolean;
  onSave: (next: { allowed: boolean; sensitiveColumns: string[]; sampleRows: number }) => void;
}) {
  const { t } = useI18n();
  const [allowed, setAllowed] = useState(policy?.allowed ?? false);
  const [sensitive, setSensitive] = useState<string[]>(policy?.sensitive_columns ?? []);
  const [sample, setSample] = useState(policy?.sample_rows ?? 0);
  const sensitiveColumns = dataset.columns.filter((c) => c.sensitive);
  const changed =
    allowed !== (policy?.allowed ?? false) ||
    sample !== (policy?.sample_rows ?? 0) ||
    sensitive.join() !== (policy?.sensitive_columns ?? []).join();
  return (
    <div className="rounded-lg border border-border px-3 py-2 text-[0.72rem] space-y-1">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 font-medium text-foreground">
          <input
            type="checkbox"
            checked={allowed}
            disabled={!editable}
            onChange={(e) => setAllowed(e.target.checked)}
          />
          {dataset.folder ? `${dataset.folder} / ` : ''}
          {dataset.name}
        </label>
        <span
          className={allowed ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}
        >
          {allowed ? t('ps.ai.allowed') : t('ps.ai.denied')}
        </span>
        {allowed && (
          <label className="flex items-center gap-1 text-muted-foreground">
            {t('ps.ai.sampleRows')}
            <input
              type="number"
              min={0}
              max={200}
              disabled={!editable}
              className="w-16 rounded border border-border bg-transparent px-1"
              value={sample}
              onChange={(e) => setSample(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
            />
          </label>
        )}
        {editable && changed && (
          <button
            type="button"
            className={`${buttonCls} ml-auto`}
            onClick={() => onSave({ allowed, sensitiveColumns: sensitive, sampleRows: sample })}
          >
            {t('common.save')}
          </button>
        )}
      </div>
      {allowed && sensitiveColumns.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>{t('ps.ai.sensitiveAllowed')}</span>
          {sensitiveColumns.map((c) => (
            <label key={c.label} className="flex items-center gap-1">
              <input
                type="checkbox"
                disabled={!editable}
                checked={sensitive.includes(c.label)}
                onChange={(e) =>
                  setSensitive(
                    e.target.checked
                      ? [...sensitive, c.label]
                      : sensitive.filter((x) => x !== c.label)
                  )
                }
              />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function BudgetSection({
  data,
  editable,
  onSave,
}: {
  data: AiOverview;
  editable: boolean;
  onSave: (b: { monthlyLimit: string; currency: string; peopleDecisions: string }) => void;
}) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(
    data.budget.limit === null ? '' : String(Number(data.budget.limit))
  );
  const [currency, setCurrency] = useState(data.budget.currency);
  const [people, setPeople] = useState(data.budget.people_decisions);
  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <h2 className="text-[0.85rem] font-semibold text-foreground flex items-center gap-1.5">
        <Wallet size={14} /> {t('ps.ai.budget')}
      </h2>
      <p className="text-[0.72rem] text-muted-foreground max-w-3xl">{t('ps.ai.budgetIntro')}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ai.monthlyLimit')}
          <input
            className={inputCls}
            inputMode="decimal"
            disabled={!editable}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ai.currency')}
          <input
            className={inputCls}
            maxLength={3}
            disabled={!editable}
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </label>
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ai.people')}
          <select
            className={inputCls}
            value={people}
            disabled={!editable || !data.isOwner}
            onChange={(e) => setPeople(e.target.value as 'review' | 'automate')}
            style={{ colorScheme: 'light dark' }}
          >
            <option value="review">{t('ps.ai.people.review')}</option>
            <option value="automate">{t('ps.ai.people.automate')}</option>
          </select>
        </label>
      </div>
      <p className="text-[0.68rem] text-muted-foreground">{t('ps.ai.peopleHint')}</p>
      {editable && (
        <button
          type="button"
          className={buttonCls}
          onClick={() => onSave({ monthlyLimit: limit, currency, peopleDecisions: people })}
        >
          {t('common.save')}
        </button>
      )}
    </section>
  );
}

const CONFIG_FIELDS = [
  'base_url',
  'model',
  'deployment',
  'api_version',
  'context_tokens',
  'max_output_tokens',
  'price_in',
  'price_out',
] as const;

function ProviderDialog({
  workspaceId,
  provider,
  currency,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  provider: Partial<AiProvider>;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const isNew = !provider.id;
  const [kind, setKind] = useState<AiKind>(provider.kind ?? 'anthropic');
  const [name, setName] = useState(provider.name ?? '');
  const [config, setConfig] = useState<Record<string, any>>(provider.config ?? {});
  const [key, setKey] = useState('');
  const [allowPersonal, setAllowPersonal] = useState(provider.allow_personal_keys ?? false);
  const [enabled, setEnabled] = useState(provider.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const def = AI_KIND_DEFS[kind];

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await terminalApi('ai.provider.save', {
        workspaceId,
        id: provider.id ?? null,
        kind,
        name,
        config,
        key,
        allowPersonal,
        enabled,
      });
      onSaved();
    } catch (e) {
      setError(errorMessage(e, t));
      setBusy(false);
    }
  };

  const fields = CONFIG_FIELDS.filter((f) =>
    f === 'deployment' || f === 'api_version' ? def.deployment : true
  );
  return (
    <Dialog
      title={isNew ? t('ps.ai.addProvider') : t('ps.conn.editTitle', { name: provider.name ?? '' })}
      onClose={onClose}
    >
      {error && (
        <p role="alert" className="text-[0.75rem] text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {isNew && (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ai.kind')}
          <select
            className={inputCls}
            value={kind}
            onChange={(e) => setKind(e.target.value as AiKind)}
            style={{ colorScheme: 'light dark' }}
          >
            {AI_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`ps.ai.kind.${k}` as any)}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-[0.7rem] text-muted-foreground">{t(`ps.ai.help.${kind}` as any)}</p>
      <label className="block text-[0.7rem] text-muted-foreground">
        {t('ps.ds.name')} *
        <input
          className={inputCls}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f} className="block text-[0.7rem] text-muted-foreground">
            {t(`ps.ai.field.${f}` as any, { currency })}
            {(f === 'model' || (f === 'base_url' && def.base_required) || f === 'deployment') &&
              ' *'}
            <input
              className={`${inputCls} font-mono`}
              placeholder={
                f === 'base_url'
                  ? def.base_url
                  : f === 'model'
                    ? def.model
                    : f === 'context_tokens'
                      ? String(def.defaults.context_tokens)
                      : undefined
              }
              value={config[f] ?? ''}
              onChange={(e) => setConfig({ ...config, [f]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-4 text-[0.72rem]">
        {(['json_output', 'tools'] as const).map((f) => (
          <label key={f} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={
                config[f] === undefined
                  ? def.defaults[f]
                  : config[f] === true || config[f] === 'true'
              }
              onChange={(e) => setConfig({ ...config, [f]: e.target.checked })}
            />
            {t(`ps.ai.field.${f}` as any)}
          </label>
        ))}
      </div>
      <p className="text-[0.68rem] text-muted-foreground">{t('ps.ai.declaredNote')}</p>
      {def.key !== 'none' && (
        <label className="block text-[0.7rem] text-muted-foreground">
          {t('ps.ai.field.key')}
          {def.key === 'required' && isNew ? ' *' : ''}
          <input
            className={inputCls}
            type="password"
            autoComplete="new-password"
            placeholder={!isNew && provider.has_secret ? t('ps.conn.secretKept') : undefined}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      )}
      <label className="flex items-center gap-1.5 text-[0.72rem]">
        <input
          type="checkbox"
          checked={allowPersonal}
          onChange={(e) => setAllowPersonal(e.target.checked)}
        />
        {t('ps.ai.allowPersonal')}
      </label>
      <label className="flex items-center gap-1.5 text-[0.72rem]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t('ps.ai.enabled')}
      </label>
      <p className="text-[0.68rem] text-muted-foreground">{t('ps.conn.secretNote')}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className={buttonCls} onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className={primaryCls} disabled={busy || !name.trim()} onClick={save}>
          {busy && <Loader2 size={13} className="animate-spin" />} {t('common.save')}
        </button>
      </div>
    </Dialog>
  );
}
