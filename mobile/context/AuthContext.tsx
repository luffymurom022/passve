import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { apiRequest, getApiUrl } from '@/lib/query-client';
import { queryClient } from '@/lib/query-client';

interface User {
  id: number;
  name: string;
  phone: string;
  email?: string;
  avatar_url?: string;
  is_seller?: boolean;
  is_verified?: boolean;
  trust_score?: number;
  wallet_balance?: number;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  login: (phone: string, password: string) => Promise<void>;
  register: (name: string, phone: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

async function saveToken(token: string) {
  if (Platform.OS === 'web') {
    localStorage.setItem('sp_token', token);
  } else {
    await SecureStore.setItemAsync('sp_token', token);
  }
}

async function clearToken() {
  if (Platform.OS === 'web') {
    localStorage.removeItem('sp_token');
  } else {
    await SecureStore.deleteItemAsync('sp_token');
  }
}

async function loadToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return typeof localStorage !== 'undefined' ? localStorage.getItem('sp_token') : null;
  }
  return SecureStore.getItemAsync('sp_token');
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchMe = useCallback(async () => {
    try {
      const data = await apiRequest<{ user: User }>('/api/users/me');
      setUser(data.user);
    } catch {
      setUser(null);
      await clearToken();
      setToken(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const stored = await loadToken();
      if (stored) {
        setToken(stored);
        await fetchMe();
      }
      setIsLoading(false);
    })();
  }, []);

  const login = async (phone: string, password: string) => {
    const data = await apiRequest<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password }),
    });
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
  };

  const register = async (name: string, phone: string, password: string) => {
    const data = await apiRequest<{ token: string; user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, phone, password }),
    });
    await saveToken(data.token);
    setToken(data.token);
    setUser(data.user);
  };

  const logout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {}
    await clearToken();
    setToken(null);
    setUser(null);
    queryClient.clear();
  };

  const refreshUser = async () => {
    await fetchMe();
  };

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
