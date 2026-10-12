'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Search, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import { ONTOLOGY, ONTOLOGY_TYPES, recordHref, recordReference } from '@/lib/ontology/registry';
import { SEARCH_LIMITS } from '@/lib/ontology/query';
import { OntologyApiError, searchErp, type OntologyItem } from '@/lib/ontology/client';
import { cx } from '@/components/refined/RefinedSidebar';

const PER_TYPE = 3;
const MAX_SHOWN = 8;

interface SidebarSearchProps {
  workspaceId: string | null;
  erpName: string;
  iconOnly: boolean;
  onExpand: () => void;
}

type Status = 'idle' | 'loading' | 'done' | 'error' | 'forbidden';

export function SidebarSearch({ workspaceId, erpName, iconOnly, onExpand }: SidebarSearchProps) {
  const { t } = useI18n();
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const focusAfterExpand = useRef(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [items, setItems] = useState<OntologyItem[]>([]);
  const [active, setActive] = useState(-1);

  const text = query.trim();
  const longEnough = text.length >= SEARCH_LIMITS.minMultiTypeLength;

  // Debounced search; a newer query cancels the one in flight.
  useEffect(() => {
    if (!longEnough) {
      setStatus('idle');
      setItems([]);
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    const timer = setTimeout(() => {
      searchErp(workspaceId, { q: text, types: [...ONTOLOGY_TYPES] }, controller.signal)
        .then((result) => {
          const found = result.groups
            .flatMap((group) => group.items.slice(0, PER_TYPE))
            .slice(0, MAX_SHOWN);
          setItems(found);
          setActive(found.length ? 0 : -1);
          setStatus('done');
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setItems([]);
          setStatus(
            error instanceof OntologyApiError && error.code === 'forbidden' ? 'forbidden' : 'error'
          );
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, longEnough, workspaceId]);

  // Clicking elsewhere closes the panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // After the sidebar opens from the search icon, put the cursor in the box.
  useEffect(() => {
    if (!iconOnly && focusAfterExpand.current) {
      focusAfterExpand.current = false;
      inputRef.current?.focus();
    }
  }, [iconOnly]);

  const seeAll = () => {
    setOpen(false);
    router.push(`/erp/search?q=${encodeURIComponent(text)}`);
  };

  const openItem = (item: OntologyItem) => {
    setOpen(false);
    setQuery('');
    router.push(recordHref(item.type, item.id, item.props));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!items.length) return;
      event.preventDefault();
      setOpen(true);
      setActive((i) =>
        event.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
      );
      return;
    }
    if (event.key === 'Enter' && text) {
      event.preventDefault();
      if (open && active >= 0 && items[active]) openItem(items[active]);
      else if (text.length >= 2) seeAll();
    }
  };

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={() => {
          focusAfterExpand.current = true;
          onExpand();
        }}
        title={t('nav.search.label')}
        aria-label={t('nav.search.label')}
        className="flex h-8 w-full items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-surface-3 hover:text-foreground"
      >
        <Search size={15} aria-hidden />
      </button>
    );
  }

  const showPanel = open && text.length > 0;

  return (
    <div ref={boxRef} className="relative">
      <div className="flex h-9 lg:h-8 items-center gap-2 rounded-[var(--radius)] border border-border bg-[var(--input,transparent)] px-2.5 focus-within:border-foreground/40">
        <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          value={query}
          maxLength={SEARCH_LIMITS.maxQueryLength}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={t('nav.search.placeholder')}
          aria-label={t('nav.search.label')}
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-activedescendant={showPanel && active >= 0 ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        {status === 'loading' && (
          <Loader2 size={13} className="shrink-0 animate-spin text-muted-foreground" aria-hidden />
        )}
        {query && status !== 'loading' && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            aria-label={t('nav.search.clear')}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X size={13} aria-hidden />
          </button>
        )}
      </div>

      {showPanel && (
        <div className="absolute left-0 top-full z-[60] mt-1 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-xl">
          <p className="border-b border-border px-3 py-1.5 text-[0.6875rem] text-muted-foreground truncate">
            {t('nav.search.scope', { erp: erpName })}
          </p>
          {!longEnough ? (
            <p className="px-3 py-3 text-[0.75rem] text-muted-foreground">{t('nav.search.hint')}</p>
          ) : status === 'loading' && !items.length ? (
            <p className="px-3 py-3 text-[0.75rem] text-muted-foreground">
              {t('nav.search.searching')}
            </p>
          ) : status === 'error' || status === 'forbidden' ? (
            <p className="px-3 py-3 text-[0.75rem] text-red-600 dark:text-red-400" role="alert">
              {t(status === 'forbidden' ? 'nav.search.forbidden' : 'nav.search.failed')}
            </p>
          ) : items.length === 0 ? (
            <p className="px-3 py-3 text-[0.75rem] text-muted-foreground">
              {t('nav.search.noResults', { erp: erpName })}
            </p>
          ) : (
            <ul
              id={listId}
              role="listbox"
              aria-label={t('nav.search.label')}
              className="max-h-80 overflow-y-auto py-1"
            >
              {items.map((item, index) => {
                const def = ONTOLOGY[item.type];
                const title = item.props[def.title];
                return (
                  <li
                    key={`${item.type}-${item.id}`}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => openItem(item)}
                    className={cx(
                      'flex cursor-pointer items-center gap-2 px-3 py-1.5 max-lg:min-h-11',
                      index === active && 'bg-surface-3'
                    )}
                  >
                    <span className="w-24 shrink-0 truncate text-[0.6875rem] text-muted-foreground">
                      {t(`onto.type.${item.type}` as MessageKey)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground">
                      {title === null || title === undefined || title === '' ? '—' : String(title)}
                    </span>
                    <span className="shrink-0 font-mono text-[0.625rem] text-muted-foreground">
                      {recordReference(
                        item.type,
                        item.id,
                        item.props as { entryNo?: unknown; code?: unknown }
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {text.length >= 2 && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={seeAll}
              className="block w-full border-t border-border px-3 py-2 text-left text-[0.75rem] font-medium text-foreground hover:bg-surface-3"
            >
              {t('nav.search.seeAll')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
