'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [mounted, setMounted] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();

  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className="w-[70px] h-[28px]" />;

  // ✅ Pakai resolvedTheme, bukan theme — resolusi actual class yang kepasang
  const isDark = resolvedTheme === 'dark';

  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[0.72rem] font-medium border transition-colors"
      style={{
        background: 'var(--surface-3)',
        borderColor: 'var(--border)',
        color: 'var(--foreground)',
      }}
      title={t('shell.toggleTheme')}
    >
      {isDark ? <Sun size={12} /> : <Moon size={12} />}
      {!compact && <span>{isDark ? t('shell.light') : t('shell.dark')}</span>}
    </button>
  );
}
