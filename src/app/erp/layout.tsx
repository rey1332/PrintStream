'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { WorkspaceProvider } from './lib/WorkspaceContext';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import { RefinedShell } from './components/shell/RefinedShell';
import { LegacyShell } from './components/shell/LegacyShell';
import { SuspendedNotice } from './components/shell/SuspendedNotice';
import { AnnouncementBanner } from './components/shell/AnnouncementBanner';
import { GovernanceBanner } from './components/shell/GovernanceBanner';

export default function ERPLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { effective } = useUiMode();

  if (pathname === '/erp/login') {
    return <>{children}</>;
  }
  // Printable documents: the ERP, without the menus.
  if (pathname.startsWith('/erp/print/')) {
    return <WorkspaceProvider>{children}</WorkspaceProvider>;
  }

  const Shell = effective === 'legacy' ? LegacyShell : RefinedShell;
  return (
    <WorkspaceProvider>
      <Shell pathname={pathname}>
        <AnnouncementBanner />
        <GovernanceBanner />
        <SuspendedNotice pathname={pathname}>{children}</SuspendedNotice>
      </Shell>
    </WorkspaceProvider>
  );
}
