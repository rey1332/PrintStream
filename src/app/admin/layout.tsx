import React from 'react';
// The admin panel's words: loaded here only, not sent to other pages.
import '@/lib/i18n/messages/admin';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { adminBase } from '@/lib/adminPath';
import { adminFromCookies } from '@/server/admin/request';
import { sessionFromCookies } from '@/server/auth/request';
import { termsStatus } from '@/server/auth/service';
import { getAuthDeps } from '@/server/config';
import { AdminShell } from './components/AdminShell';

export const dynamic = 'force-dynamic';

// The internal admin panel. Anyone without a platform admin role gets the
// ordinary 404 page; every API route behind it checks the role again, and the
// database checks it a third time.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Closed (ETNA_ADMIN_PATH not valid): a 404 even here.
  const base = adminBase();
  if (!base) notFound();
  const jar = await cookies();
  // Like every page: the current Terms & Conditions first (the database
  // refuses everything else until then, the admin role included).
  const session = await sessionFromCookies(jar);
  if (session && (await termsStatus(getAuthDeps(), session)).required)
    redirect(`/terms?next=${encodeURIComponent(base)}`);
  const admin = await adminFromCookies(jar);
  if (!admin) notFound();
  return (
    <AdminShell
      email={admin.session.email}
      role={admin.role}
      base={base}
      twoFactor={admin.session.aal === 'aal2'}
    >
      {children}
    </AdminShell>
  );
}
