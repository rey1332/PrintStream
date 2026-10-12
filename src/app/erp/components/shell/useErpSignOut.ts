'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';

export function useErpSignOut() {
  const router = useRouter();
  const { signOut } = useAuth();
  return useCallback(async () => {
    try {
      await signOut();
      router.replace('/erp/login');
    } catch {
      // Keep the current page if sign-out fails.
    }
  }, [router, signOut]);
}
