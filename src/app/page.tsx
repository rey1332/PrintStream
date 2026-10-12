'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from '@/components/Sidebar';
import { createClient } from '@/lib/data/client';
import { dashboardService } from './erp/lib/erpService';
import { accountingService } from './erp/lib/accountingService';
import { realtimeFilter } from './erp/lib/workspace';
import { useAuth } from '@/contexts/AuthContext';
import Link from 'next/link';
import { Settings } from 'lucide-react';
import { consoleLogger } from '@/lib/console-logger';
import { useConsolePageContext } from '@/lib/console/bridge';
import { ConsoleButton } from '@/components/console/ConsoleHost';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import { AsciiLogo } from '@/components/brand/AsciiLogo';
import { HomeWidgets } from '@/components/home/HomeWidgets';

// ─── Types ─────────────────────────────────────────────────────────────────────
interface Metrics {
  totalRevenue: number;
  totalExpenses: number;
  cashBalance: number;
  inventoryValue: number;
  accountsReceivable: number;
  accountsPayable: number;
}

// ─── Dashboard Page ────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { user } = useAuth();
  const { t, fmt, setCurrency } = useI18n();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const refined = useUiMode().effective === 'refined';
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);
  const [metrics, setMetrics] = useState<Metrics>({
    totalRevenue: 0,
    totalExpenses: 0,
    cashBalance: 0,
    inventoryValue: 0,
    accountsReceivable: 0,
    accountsPayable: 0,
  });
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // ✅ FIX: pakai ref untuk timer debounce
  const fetchTimerRef = useRef<NodeJS.Timeout | null>(null);
  const channelRef = useRef<any>(null);

  // ✅ FIX: gunakan user.id (string) sebagai dep, bukan user object
  const userId = user?.id;

  const exportERPData = async () => {
    const tables = [
      'erp_customers',
      'erp_suppliers',
      'erp_products',
      'erp_invoices',
      'erp_payments',
      'erp_transactions',
      'erp_purchase_orders',
      'erp_sales_orders',
    ];
    // Export the workspace last selected in the ERP (the server checks access).
    let workspaceId: string | null = null;
    try {
      workspaceId = window.localStorage.getItem('etna.erp.activeWorkspace');
    } catch {
      workspaceId = null;
    }
    try {
      const workbook = XLSX.utils.book_new();
      for (const table of tables) {
        const response = await fetch('/api/erp/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table, format: 'json', workspaceId }),
        });
        const result = await response.json();
        if (!response.ok || !result.success)
          throw new Error(result.error || t('home.exportFailedTable', { table }));
        const rows = JSON.parse(result.data.content || '[]');
        XLSX.utils.book_append_sheet(
          workbook,
          XLSX.utils.json_to_sheet(rows),
          table.replace('erp_', '').slice(0, 31)
        );
      }
      XLSX.writeFile(workbook, `etna-erp-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success(t('home.exported'));
    } catch (error) {
      console.error('[exportERPData]', error);
      toast.error(error instanceof Error ? error.message : t('home.exportFailed'));
    }
  };

  // Log data fetch status
  useEffect(() => {
    if (loading) {
      consoleLogger.info('Loading dashboard metrics...');
    } else if (!user) {
      consoleLogger.warn('Not authenticated');
    } else if (metrics.totalRevenue > 0) {
      consoleLogger.success(`Dashboard loaded - Revenue: ${fmt.money(metrics.totalRevenue)}`);
    }
  }, [loading, user, metrics.totalRevenue, fmt]);

  // Log data updates
  useEffect(() => {
    if (lastUpdated && !loading) {
      const time = lastUpdated.toLocaleTimeString();
      consoleLogger.debug(`Data synchronized at ${time}`);
    }
  }, [lastUpdated, loading]);

  // ✅ FIX: fetchData TIDAK set loading, hanya update data
  const fetchData = useCallback(
    async (uid: string) => {
      try {
        // Not shown on Home any more; kept for the app-wide console's page context.
        setMetrics(await dashboardService.getMetrics(uid));
        setLastUpdated(new Date());
      } catch {
        // Continue showing the last successfully loaded dashboard snapshot.
      }
      accountingService
        .settings()
        .then((s) => setCurrency(s.baseCurrency))
        .catch(() => {});
    },
    [setCurrency]
  );

  // The app-wide console (ConsoleHost) shows these metrics and refreshes after data commands.
  const refreshForConsole = useCallback(() => {
    if (user?.id) fetchData(user.id);
  }, [user?.id, fetchData]);
  useConsolePageContext({ metrics, onDataChange: refreshForConsole });

  // ✅ FIX: debounce fetch dari realtime events
  const debouncedFetch = useCallback(
    (uid: string) => {
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
      fetchTimerRef.current = setTimeout(() => fetchData(uid), 400);
    },
    [fetchData]
  );

  useEffect(() => {
    // ✅ pakai userId bukan user object
    if (!userId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    fetchData(userId).finally(() => {
      if (!cancelled) setLoading(false);
    });

    const db = createClient();
    // Same scope as the metrics query (the workspace when one is active).
    const scopeFilter = realtimeFilter(userId);
    const channel = db
      .channel('dashboard_erp_metrics')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_invoices', filter: scopeFilter },
        () => debouncedFetch(userId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_payments', filter: scopeFilter },
        () => debouncedFetch(userId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_transactions', filter: scopeFilter },
        () => debouncedFetch(userId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'erp_products', filter: scopeFilter },
        () => debouncedFetch(userId)
      )
      .subscribe();

    channelRef.current = channel;
    return () => {
      cancelled = true;
      if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
      db.removeChannel(channel);
    };
  }, [userId, fetchData, debouncedFetch]);

  return (
    <div
      className={`flex ${refined ? 'h-[100dvh]' : 'h-screen'} w-full overflow-hidden`}
      style={{ background: 'var(--background)' }}
    >
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        activeRoute="/"
        mobileOpen={mobileMenuOpen}
        onMobileClose={closeMobileMenu}
        refined={refined}
        restoreFocusTo={menuButtonRef}
        fileActions={{ onExport: exportERPData }}
      />

      <div
        className={
          refined
            ? 'ui-refined relative flex flex-col flex-1 min-w-0 overflow-hidden bg-background text-foreground'
            : 'relative flex flex-col flex-1 min-w-0 overflow-hidden'
        }
      >
        <button
          ref={menuButtonRef}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={t('shell.openMenu')}
          aria-expanded={refined ? mobileMenuOpen : undefined}
          aria-controls={refined ? 'home-navigation' : undefined}
          className="absolute left-2 z-10 inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-surface-3 hover:text-foreground lg:hidden"
          style={{ top: 'calc(0.5rem + env(safe-area-inset-top))' }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div
          className="absolute right-2 z-10 flex items-center gap-1"
          style={{ top: 'calc(0.5rem + env(safe-area-inset-top))' }}
        >
          <ConsoleButton />
          <Link
            href="/erp/settings"
            className="inline-flex h-11 w-11 lg:h-8 lg:w-8 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:bg-surface-3 hover:text-foreground"
            title={t('shell.settings')}
            aria-label={t('shell.settings')}
          >
            <Settings size={15} />
          </Link>
        </div>

        <div
          className={
            refined
              ? 'flex-1 overflow-y-auto overscroll-contain px-3 pt-16 sm:px-6 lg:px-10 lg:pt-12 space-y-5 sm:space-y-6'
              : 'flex-1 overflow-y-auto px-5 pt-16 lg:px-10 lg:pt-12 pb-5 space-y-6'
          }
          style={
            refined ? { paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom))' } : undefined
          }
        >
          <div className="space-y-2">
            <h1 className="sr-only">{t('home.welcome')}</h1>
            <p
              className="text-[0.95rem] sm:text-[1.1rem]"
              style={{ color: 'var(--muted-foreground)' }}
              aria-hidden
            >
              {t('home.welcomeTo')}
            </p>
            <div style={{ color: 'var(--foreground)' }} aria-hidden>
              <AsciiLogo maxFontPx={38} />
            </div>
            <p className="text-[0.8rem] pt-1" style={{ color: 'var(--muted-foreground)' }}>
              {t('home.subtitle')}
            </p>
          </div>

          {!user && !loading && (
            <div
              className="rounded-xl border px-4 py-3 text-[0.8rem]"
              style={{
                background: 'var(--card)',
                borderColor: 'var(--border)',
                color: 'var(--muted-foreground)',
              }}
            >
              <Link href="/erp/login" className="underline underline-offset-2">
                {t('home.signIn')}
              </Link>{' '}
              {t('home.signInSuffix')}
            </div>
          )}

          <HomeWidgets userId={userId} />
        </div>
      </div>
    </div>
  );
}
