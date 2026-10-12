'use client';

import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { CATEGORIES, NODE_DEFINITIONS } from '@/lib/workflow/registry';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { categoryLabel, nodeTypeDescription, nodeTypeLabel } from '@/lib/workflow/i18n';

/** The registry's nodes, by category (sources first, outputs last). */
const PALETTE = CATEGORIES.map((cat) => ({
  ...cat,
  nodes: NODE_DEFINITIONS.filter((d) => d.category === cat.id),
})).filter((cat) => cat.nodes.length > 0);

export default function NodePalette({
  onAdd,
  sheet = false,
}: {
  onAdd: (type: string) => void;
  sheet?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q
    ? PALETTE.map((cat) => ({
        ...cat,
        nodes: cat.nodes.filter((d) =>
          `${nodeTypeLabel(d.type, t)} ${nodeTypeDescription(d.type, t)}`.toLowerCase().includes(q)
        ),
      })).filter((cat) => cat.nodes.length > 0)
    : PALETTE;
  const onDragStart = (e: React.DragEvent, nodeType: string) => {
    e.dataTransfer.setData('application/reactflow', nodeType);
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div
      className={
        sheet ? 'flex h-full min-h-0 flex-col' : 'w-60 border-r bg-card flex flex-col h-full'
      }
      style={{ borderColor: 'var(--border)' }}
    >
      <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
        <p className="text-[0.7rem] font-semibold uppercase tracking-widest text-muted-foreground">
          {t('wf.nodes')}
        </p>
        <p className="mt-0.5 text-[0.62rem] text-muted-foreground">
          {t(sheet ? 'wf.palette.tapHint' : 'wf.palette.hint')}
        </p>
        <label className="mt-2 flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
          <Search size={12} className="shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('wf.palette.search')}
            aria-label={t('wf.palette.search')}
            className="min-w-0 flex-1 bg-transparent text-[0.72rem] text-foreground outline-none"
          />
        </label>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {shown.map((cat) => (
          <div key={cat.id}>
            <p
              className="text-[0.62rem] font-bold uppercase tracking-widest mb-2 px-1"
              style={{ color: cat.color }}
            >
              {categoryLabel(cat.id, t, cat.label)}
            </p>
            <div className={sheet ? 'grid grid-cols-1 gap-1 min-[420px]:grid-cols-2' : 'space-y-1'}>
              {cat.nodes.map((def) => {
                const Icon = def.icon;
                return (
                  <button
                    type="button"
                    key={def.type}
                    draggable={!sheet}
                    onDragStart={(e) => onDragStart(e, def.type)}
                    onClick={() => onAdd(def.type)}
                    className={`flex w-full items-center gap-2 px-2 rounded-md text-left cursor-grab active:cursor-grabbing hover:bg-[var(--surface-3)] transition-colors ${sheet ? 'min-h-11 py-2' : 'py-1.5'}`}
                    title={nodeTypeDescription(def.type, t)}
                  >
                    <div
                      className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
                      style={{ background: def.color + '22' }}
                    >
                      <Icon size={12} style={{ color: def.color }} />
                    </div>
                    <span className="min-w-0">
                      <span className="block text-[0.75rem] text-foreground truncate">
                        {nodeTypeLabel(def.type, t)}
                      </span>
                      {sheet && (
                        <span className="block text-[0.62rem] text-muted-foreground truncate">
                          {nodeTypeDescription(def.type, t)}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
