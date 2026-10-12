'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { Overview } from '@/lib/terminal/client';

type Tab = 'home' | 'datasets' | 'imports' | 'pipelines' | 'connections' | 'jobs';

interface Command {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

/** Ctrl+K (⌘K): jump to a dataset, pipeline or tab, or start something. */
export function CommandBar({
  overview,
  onNewDataset,
  onUpload,
  onTab,
}: {
  overview: Overview | null;
  onNewDataset: () => void;
  onUpload: () => void;
  onTab: (tab: Tab) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const can = (p: string) => !!overview?.permissions.includes(p);
    const list: Command[] = [];
    if (can('datasets.schema'))
      list.push({
        id: 'new-ds',
        label: t('ps.ds.new'),
        hint: t('ps.cmd.action'),
        run: onNewDataset,
      });
    if (can('datasets.import'))
      list.push({
        id: 'upload',
        label: t('ps.imp.upload'),
        hint: t('ps.cmd.action'),
        run: onUpload,
      });
    for (const tab of ['home', 'datasets', 'imports', 'pipelines', 'connections', 'jobs'] as Tab[])
      list.push({
        id: `tab-${tab}`,
        label: t(`ps.tab.${tab}` as any),
        hint: t('ps.cmd.goTo'),
        run: () => onTab(tab),
      });
    for (const d of overview?.datasets ?? [])
      list.push({
        id: `ds-${d.id}`,
        label: d.folder ? `${d.folder} / ${d.name}` : d.name,
        hint: t('ps.cmd.dataset'),
        run: () => router.push(`/terminal/datasets/${d.id}`),
      });
    for (const p of overview?.pipelines ?? [])
      list.push({
        id: `pl-${p.id}`,
        label: p.name,
        hint: t('ps.cmd.pipeline'),
        run: () => router.push(`/pipelines/${p.id}`),
      });
    return list;
  }, [overview, t, onNewDataset, onUpload, onTab, router]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands).slice(0, 30);
  }, [commands, query]);

  if (!open) return null;
  const choose = (c: Command | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };

  return (
    <div
      className="overlay-mobile fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh]"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-border bg-card shadow-xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={t('ps.cmd.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-border">
          <Search size={14} className="text-muted-foreground" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent py-3 text-[0.85rem] text-foreground outline-none"
            placeholder={t('ps.cmd.placeholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') choose(shown[index]);
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="ps-cmd-list"
          />
        </div>
        <ul id="ps-cmd-list" role="listbox" className="max-h-[50vh] overflow-y-auto py-1">
          {shown.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(c)}
              className={`flex items-center justify-between px-3 py-2 cursor-pointer text-[0.8rem] ${i === index ? 'bg-[var(--surface-3)]' : ''}`}
            >
              <span className="text-foreground truncate">{c.label}</span>
              <span className="text-[0.65rem] text-muted-foreground ml-3">{c.hint}</span>
            </li>
          ))}
          {!shown.length && (
            <li className="px-3 py-3 text-[0.75rem] text-muted-foreground">
              {t('ps.cmd.nothing')}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
