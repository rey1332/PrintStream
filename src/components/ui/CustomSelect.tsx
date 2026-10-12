'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface Option {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
}

export function CustomSelect({
  value,
  onChange,
  options,
  placeholder = 'Select...',
  className = '',
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-[0.8rem] outline-none transition-colors"
        style={{
          minWidth: '140px',
          background: 'var(--card)',
          borderColor: 'var(--border)',
          color: 'var(--foreground)',
        }}
      >
        <span className="truncate">{selected?.label || placeholder}</span>
        <ChevronDown
          size={12}
          className="flex-shrink-0 transition-transform duration-150"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-[999] rounded-lg border shadow-xl overflow-hidden max-h-64 overflow-y-auto"
          style={{
            minWidth: '100%',
            // Long options never push the menu past the screen edge on phones.
            maxWidth: 'calc(100vw - 1.5rem)',
            // ✅ FORCE 100% OPAQUE — pakai warna solid, bukan CSS variable yang mungkin punya alpha
            background: 'var(--card)',
            backgroundColor: 'var(--card)',
            borderColor: 'var(--border)',
            backdropFilter: 'none',
            isolation: 'isolate',
          }}
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-[0.8rem] transition-colors"
                style={{
                  // ✅ Ganti surface-3 dengan color-mix atau hardcoded sesuai tema
                  background: isSelected ? 'var(--muted)' : 'var(--card)',
                  color: 'var(--foreground)',
                  fontWeight: isSelected ? 500 : 400,
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'var(--muted)';
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = 'var(--card)';
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
