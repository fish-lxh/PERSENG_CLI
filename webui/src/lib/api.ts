// fetch 封装：自动注入 Bearer token，统一错误处理

import { useAuthStore } from '../store/auth';
import type {
  StatusInfo,
  RoleListResponse,
  MemoryListResponse,
  SessionListResponse,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

function authHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const API_BASE = '/api';

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) };
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, body);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export const api = {
  status: () => req<StatusInfo>('/status'),
  metrics: async (): Promise<string> => {
    const res = await fetch(`${API_BASE}/metrics`, { headers: authHeaders() });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return await res.text();
  },
  roles: () => req<RoleListResponse>('/roles'),
  role: (id: string) => req<Record<string, unknown>>(`/roles/${encodeURIComponent(id)}`),
  memory: (role: string, limit = 50, offset = 0) =>
    req<MemoryListResponse>(
      `/memory?role=${encodeURIComponent(role)}&limit=${limit}&offset=${offset}`
    ),
  memoryStats: (role: string) =>
    req<Record<string, unknown>>(`/memory/stats?role=${encodeURIComponent(role)}`),
  forget: (role: string, id: string) =>
    req<{ deleted: boolean; [k: string]: unknown }>(
      `/memory/${encodeURIComponent(id)}/forget?role=${encodeURIComponent(role)}`,
      { method: 'POST' }
    ),
  sessions: () => req<SessionListResponse>('/sessions'),
};
