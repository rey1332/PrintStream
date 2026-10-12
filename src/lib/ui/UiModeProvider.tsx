'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { useAuth } from '@/contexts/AuthContext';
import {
  DEFAULT_UI,
  DESKTOP_QUERY,
  effectiveUi,
  readUiPreference,
  rememberLastUi,
  writeUiPreference,
  type UiVersion,
} from './mode';

interface UiModeValue {
  preference: UiVersion;
  effective: UiVersion;
  isDesktop: boolean;
  setPreference: (value: UiVersion) => boolean;
}

const UiModeContext = createContext<UiModeValue | null>(null);

export function UiModeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userId: string | null = user?.id ?? null;
  const [preference, setPreferenceState] = useState<UiVersion>(DEFAULT_UI);
  const [isDesktop, setIsDesktop] = useState(true);

  useLayoutEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useLayoutEffect(() => {
    // Before sign-in state is known, use the last choice in this browser.
    const saved = userId ? readUiPreference(userId) : readUiPreference(null);
    const next = saved ?? DEFAULT_UI;
    setPreferenceState(next);
    if (userId) rememberLastUi(next);
  }, [userId]);

  const effective = effectiveUi(preference, isDesktop);

  useLayoutEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-ui', effective);
    html.removeAttribute('data-ui-pending');
  }, [effective]);

  const setPreference = useCallback(
    (value: UiVersion) => {
      if (!userId) return false;
      const stored = writeUiPreference(userId, value);
      setPreferenceState(value);
      return stored;
    },
    [userId]
  );

  const value = useMemo(
    () => ({ preference, effective, isDesktop, setPreference }),
    [preference, effective, isDesktop, setPreference]
  );

  return <UiModeContext.Provider value={value}>{children}</UiModeContext.Provider>;
}

export function useUiMode(): UiModeValue {
  const value = useContext(UiModeContext);
  if (!value) throw new Error('useUiMode must be used within UiModeProvider');
  return value;
}
