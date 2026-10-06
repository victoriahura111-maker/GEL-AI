import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { fetchMe, patchProfile } from '../services/api';
import type { UpdateProfilePayload, UserProfile } from '../types';

interface AuthContextValue {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signUp: (email: string, password: string, fullName?: string) => Promise<boolean>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  updateProfile: (updates: UpdateProfilePayload) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async () => {
    try {
      const data = await fetchMe();
      setProfile(data.profile);
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    let active = true;

    const initialize = async () => {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setUser(data.session?.user ?? null);
      if (data.session?.user) {
        await loadProfile();
      }
      setLoading(false);
    };

    void initialize();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null;
      setUser(nextUser);
      if (nextUser) {
        void loadProfile();
      } else {
        setProfile(null);
      }
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signUp = useCallback(
    async (email: string, password: string, fullName?: string) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: fullName ? { full_name: fullName } : undefined,
        },
      });

      if (error) throw error;

      const sessionStarted = Boolean(data.session);

      if (sessionStarted) {
        setUser(data.session?.user ?? null);
        if (fullName) {
          await patchProfile({ full_name: fullName }).catch(() => undefined);
        }
        await loadProfile();
      }

      return sessionStarted;
    },
    [loadProfile]
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) throw error;

      setUser(data.session?.user ?? null);
      if (data.session?.user) {
        await loadProfile();
      }
    },
    [loadProfile]
  );

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setUser(null);
    setProfile(null);
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) throw error;
  }, []);

  const updatePassword = useCallback(async (newPassword: string) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }, []);

  const updateProfile = useCallback(async (updates: UpdateProfilePayload) => {
    const updated = await patchProfile(updates);
    setProfile(updated);
  }, []);

  const value = useMemo(
    () => ({
      user,
      profile,
      loading,
      signUp,
      signIn,
      signOut,
      resetPassword,
      updatePassword,
      updateProfile,
    }),
    [user, profile, loading, signUp, signIn, signOut, resetPassword, updatePassword, updateProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
