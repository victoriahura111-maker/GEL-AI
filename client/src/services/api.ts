import { supabase } from './supabase';
import type { MeResponse, UpdateProfilePayload, UserProfile } from '../types';

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers);

  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(path, { ...options, headers });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}

export function fetchMe(): Promise<MeResponse> {
  return apiRequest<MeResponse>('/api/auth/me');
}

export function patchProfile(payload: UpdateProfilePayload): Promise<UserProfile> {
  return apiRequest<UserProfile>('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}
