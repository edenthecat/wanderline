import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  fetchSetupStatus,
  type AuthUser,
} from '../api/client';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  needsSetup: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: AuthUser) => void;
  clearSetup: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    needsSetup: false,
    error: null,
  });

  // Check session + setup status on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Check if first-time setup is needed
        const { needsSetup } = await fetchSetupStatus();
        if (cancelled) return;

        if (needsSetup) {
          setState({ user: null, loading: false, needsSetup: true, error: null });
          return;
        }

        // Try to resume existing session
        const { user } = await fetchMe();
        if (cancelled) return;
        setState({ user, loading: false, needsSetup: false, error: null });
      } catch {
        if (cancelled) return;
        // 401 is expected when not logged in — clear any stale error
        setState((prev) => ({ ...prev, user: null, loading: false, error: null }));
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      const { user } = await apiLogin(email, password);
      setState({ user, loading: false, needsSetup: false, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setState((prev) => ({ ...prev, error: message }));
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setState({ user: null, loading: false, needsSetup: false, error: null });
    }
  }, []);

  const setUser = useCallback((user: AuthUser) => {
    setState({ user, loading: false, needsSetup: false, error: null });
  }, []);

  const clearSetup = useCallback(() => {
    setState((prev) => ({ ...prev, needsSetup: false }));
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, setUser, clearSetup }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
