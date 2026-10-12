'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { PICK_LIMIT } from '../lib/erpService';

export interface PickerOption<T> {
  id: string;
  label: string;
  detail?: string;
  data: T;
}

export function RecordPicker<T>({
  value,
  valueLabel,
  search,
  onChange,
  placeholder,
  ariaLabel,
  id,
  required,
  disabled,
  className,
  style,
}: {
  value: string;
  valueLabel: string;
  search: (text: string) => Promise<PickerOption<T>[]>;
  onChange: (option: PickerOption<T> | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { t } = useI18n();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [options, setOptions] = useState<PickerOption<T>[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const searchRef = useRef(search);
  searchRef.current = search;

  // Search after typing stops; only the latest answer is shown.
  useEffect(() => {
    if (!open) return;
    const ticket = ++request.current;
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        searchRef
          .current(text.trim())
          .then((rows) => {
            if (ticket !== request.current) return;
            setOptions(rows);
            setActive(0);
            setFailed(false);
          })
          .catch(() => ticket === request.current && setFailed(true))
          .finally(() => ticket === request.current && setLoading(false));
      },
      text ? 250 : 0
    );
    return () => window.clearTimeout(timer);
  }, [open, text]);

  function pick(option: PickerOption<T>) {
    onChange(option);
    setOpen(false);
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && open) {
      // Picks instead of submitting the form.
      e.preventDefault();
      if (options[active]) pick(options[active]);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
      setText('');
    }
  }

  const activeId = open && options[active] ? `${listId}-${active}` : undefined;

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        autoComplete="off"
        required={required && !value}
        disabled={disabled}
        placeholder={open ? t('picker.typeToSearch') : placeholder}
        value={open ? text : valueLabel}
        onFocus={() => {
          setText('');
          setOpen(true);
        }}
        // Closing waits a moment so a click on an option still lands.
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={`${className ?? ''} ${value && !disabled ? 'pr-8' : ''}`}
        style={style}
      />
      {value && !disabled && !required && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('picker.clear')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange(null)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
        >
          <X size={12} />
        </button>
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 right-0 z-40 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-lg"
        >
          {loading && options.length === 0 ? (
            <li className="flex items-center gap-2 px-3 py-2 text-[0.75rem] text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> {t('picker.searching')}
            </li>
          ) : failed ? (
            <li className="px-3 py-2 text-[0.75rem] text-red-600 dark:text-red-400">
              {t('picker.failed')}
            </li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-[0.75rem] text-muted-foreground">
              {t('picker.noMatches')}
            </li>
          ) : (
            <>
              {options.map((option, i) => (
                <li
                  key={option.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={option.id === value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(option)}
                  onMouseEnter={() => setActive(i)}
                  className={`cursor-pointer px-3 py-1.5 text-[0.8rem] max-lg:py-2.5 ${
                    i === active ? 'bg-[var(--surface-3)]' : ''
                  } ${option.id === value ? 'font-semibold' : ''}`}
                >
                  <span className="block text-foreground">{option.label}</span>
                  {option.detail && (
                    <span className="block text-[0.7rem] text-muted-foreground">
                      {option.detail}
                    </span>
                  )}
                </li>
              ))}
              {options.length >= PICK_LIMIT && (
                <li className="px-3 py-1.5 text-[0.7rem] text-muted-foreground">
                  {t('picker.more')}
                </li>
              )}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
