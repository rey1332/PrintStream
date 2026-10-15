import React from 'react';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import '../styles/tailwind.css';
import { Toaster } from 'sonner';
import { ThemeProvider } from 'next-themes';
import { AuthProvider } from '@/contexts/AuthContext';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { LOCALE_BOOT_SCRIPT } from '@/lib/i18n/config';
import { UI_BOOT_SCRIPT } from '@/lib/ui/mode';
import { UiModeProvider } from '@/lib/ui/UiModeProvider';
import { ConsoleProvider } from '@/components/console/ConsoleHost';
import { TermsGate } from '@/components/terms/TermsGate';
import { SharedComputerGuard } from '@/components/auth/SharedComputerGuard';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets the refined UI pad for notches and home indicators (env(safe-area-inset-*)).
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'PrintStream',
  description: 'PrintStream by ETNA: enterprise data integration and intelligence.',
  icons: {
    icon: [{ url: '/favicon.ico', type: 'image/x-icon' }],
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // This request's script nonce (src/middleware.ts): inline scripts run only with it.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Browsers hide a nonce from the page once loaded (nonce=""), so React
            would report a mismatch here on every load. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: LOCALE_BOOT_SCRIPT }}
        />
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: UI_BOOT_SCRIPT }}
        />
      </head>
      <body className="bg-background text-foreground antialiased">
        <ThemeProvider
          nonce={nonce}
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
          storageKey="etna-theme"
        >
          <I18nProvider>
            <AuthProvider>
              <UiModeProvider>
                <TermsGate />
                <SharedComputerGuard />
                <ConsoleProvider>{children}</ConsoleProvider>
              </UiModeProvider>
            </AuthProvider>
          </I18nProvider>
        </ThemeProvider>

        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'var(--card)',
              border: '1px solid var(--border)',
              color: 'var(--foreground)',
              fontSize: '0.8125rem',
              fontFamily: 'var(--font-sans)',
            },
          }}
        />
      </body>
    </html>
  );
}
