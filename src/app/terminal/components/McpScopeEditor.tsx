'use client';

// What an MCP token or connected app may use: tools by group, and either all
// or only some datasets and pipelines (src/lib/terminal/mcpScope.ts). The
// server enforces it; outside it, items do not exist for the assistant.

import React from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  MCP_TOOL_GROUPS,
  MCP_TOOL_NAMES,
  MCP_WRITE_TOOLS,
  type McpScope,
} from '@/lib/terminal/mcpScope';

export interface ScopeItem {
  id: string;
  name: string;
}

/** The editor's state: every tool chosen and no data limit = no scope at all. */
export function scopeForSave(scope: McpScope, canWrite: boolean): McpScope | null {
  const offered = MCP_TOOL_NAMES.filter((n) => canWrite || !MCP_WRITE_TOOLS.includes(n));
  const tools = scope.tools && scope.tools.filter((n) => offered.includes(n));
  const allTools = !tools || offered.every((n) => tools.includes(n));
  if (allTools && !scope.datasets && !scope.pipelines) return null;
  return { tools: allTools ? null : tools, datasets: scope.datasets, pipelines: scope.pipelines };
}

export const fullScope = (): McpScope => ({ tools: null, datasets: null, pipelines: null });

function ItemList({
  label,
  all,
  items,
  chosen,
  onChange,
}: {
  label: string;
  all: string;
  items: ScopeItem[];
  chosen: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[0.72rem] font-semibold text-foreground">{label}</legend>
      <div className="flex flex-wrap gap-3 text-[0.72rem]">
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" checked={chosen === null} onChange={() => onChange(null)} />
          {all}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input type="radio" checked={chosen !== null} onChange={() => onChange(chosen ?? [])} />
          {t('ps.mcpScope.only')}
        </label>
      </div>
      {chosen !== null &&
        (items.length === 0 ? (
          <p className="text-[0.68rem] text-muted-foreground">{t('ps.mcpScope.nothing')}</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {items.map((item) => (
              <li key={item.id}>
                <label className="flex items-center gap-2 px-2.5 py-1.5 text-[0.72rem] text-foreground">
                  <input
                    type="checkbox"
                    checked={chosen.includes(item.id)}
                    onChange={(e) =>
                      onChange(
                        e.target.checked
                          ? [...chosen, item.id]
                          : chosen.filter((id) => id !== item.id)
                      )
                    }
                  />
                  <span className="truncate">{item.name}</span>
                </label>
              </li>
            ))}
          </ul>
        ))}
    </fieldset>
  );
}

export function McpScopeEditor({
  scope,
  onChange,
  canWrite,
  datasets,
  pipelines,
  dataLimits = true,
}: {
  scope: McpScope;
  onChange: (next: McpScope) => void;
  canWrite: boolean;
  datasets: ScopeItem[];
  pipelines: ScopeItem[];
  /** The consent page shows tools only; data is limited later in the Terminal. */
  dataLimits?: boolean;
}) {
  const { t } = useI18n();
  const tools = scope.tools ?? MCP_TOOL_NAMES;
  const setTools = (next: string[]) => onChange({ ...scope, tools: next });
  const groups = MCP_TOOL_GROUPS.filter((g) => canWrite || !('write' in g && g.write));
  return (
    <div className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-[0.72rem] font-semibold text-foreground">
          {t('ps.mcpScope.tools')}
        </legend>
        {groups.map((g) => {
          const names: string[] = [...g.tools];
          const on = names.filter((n) => tools.includes(n));
          return (
            <div key={g.key} className="rounded-lg border border-border px-2.5 py-2">
              <label className="flex items-center gap-2 text-[0.72rem] font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={on.length === names.length}
                  ref={(el) => {
                    if (el) el.indeterminate = on.length > 0 && on.length < names.length;
                  }}
                  onChange={(e) =>
                    setTools(
                      e.target.checked
                        ? [...new Set([...tools, ...names])]
                        : tools.filter((n) => !names.includes(n))
                    )
                  }
                />
                {t(`ps.mcpScope.group.${g.key}` as MessageKey)}
              </label>
              <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5 pl-5">
                {names.map((n) => (
                  <label
                    key={n}
                    className="flex items-center gap-1.5 text-[0.68rem] text-muted-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={tools.includes(n)}
                      onChange={(e) =>
                        setTools(e.target.checked ? [...tools, n] : tools.filter((x) => x !== n))
                      }
                    />
                    <code className="text-foreground">{n}</code>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {tools.filter((n) => canWrite || !MCP_WRITE_TOOLS.includes(n)).length === 0 && (
          <p className="text-[0.68rem] text-red-500">{t('ps.mcpScope.noTools')}</p>
        )}
      </fieldset>
      {dataLimits && (
        <>
          <ItemList
            label={t('ps.mcpScope.datasets')}
            all={t('ps.mcpScope.allDatasets')}
            items={datasets}
            chosen={scope.datasets}
            onChange={(next) => onChange({ ...scope, datasets: next })}
          />
          <ItemList
            label={t('ps.mcpScope.pipelines')}
            all={t('ps.mcpScope.allPipelines')}
            items={pipelines}
            chosen={scope.pipelines}
            onChange={(next) => onChange({ ...scope, pipelines: next })}
          />
          <p className="text-[0.66rem] text-muted-foreground">{t('ps.mcpScope.hint')}</p>
        </>
      )}
    </div>
  );
}

/** One line under a token or app: what it is limited to. */
export function scopeSummary(
  scope: McpScope | null,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
): string {
  if (!scope || (!scope.tools && !scope.datasets && !scope.pipelines)) return t('ps.mcpScope.all');
  const parts: string[] = [];
  if (scope.tools) parts.push(t('ps.mcpScope.nTools', { n: scope.tools.length }));
  if (scope.datasets) parts.push(t('ps.mcpScope.nDatasets', { n: scope.datasets.length }));
  if (scope.pipelines) parts.push(t('ps.mcpScope.nPipelines', { n: scope.pipelines.length }));
  return parts.join(' · ');
}
