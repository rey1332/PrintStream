'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { createClient } from '@/lib/data/client';

const AuthContext = createContext<any>({});

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const db = createClient();

  useEffect(() => {
    let mounted = true;

    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;

      if (process.env.NODE_ENV === 'development') {
        console.log('[Auth]', event, session?.user ? 'signed-in' : 'no-user');
      }

      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Safety: kalau INITIAL_SESSION gak fire dalam 3 detik, matiin loading
    const t = setTimeout(() => {
      if (mounted) setLoading(false);
    }, 3000);

    return () => {
      mounted = false;
      clearTimeout(t);
      subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No sign-up: accounts are created by an administrator on request.
  const signIn = async (email: string, password: string, shared = false) => {
    const { data, error } = await db.auth.signInWithPassword({
      email,
      password,
      shared,
    });
    if (error) throw error;
    if (data.session) {
      setSession(data.session);
      setUser(data.session.user);
      setLoading(false);
    }
    return data;
  };

  const signOut = async () => {
    const { error } = await db.auth.signOut();
    if (error) throw error;
  };

  const getCurrentUser = async () => {
    const {
      data: { user },
      error,
    } = await db.auth.getUser();
    if (error) throw error;
    return user;
  };

  const isEmailVerified = () => {
    return user?.email_confirmed_at !== null;
  };

  const getUserProfile = async () => {
    if (!user) return null;
    const { data, error } = await db.from('user_profiles').select('*').eq('id', user.id).single();
    if (error) throw error;
    return data;
  };

  const value = {
    user,
    session,
    db,
    loading,
    signIn,
    signOut,
    getCurrentUser,
    isEmailVerified,
    getUserProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
