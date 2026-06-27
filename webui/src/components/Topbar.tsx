import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatUptime } from '../lib/format';
import { useAuthStore } from '../store/auth';
import { useChatStore } from '../store/chat';
import { usePollingTask } from '../hooks/usePollingTask';
import { wsBus } from '../lib/ws';

export function Topbar() {
  const token = useAuthStore((s) => s.token);
  const tabId = useChatStore((s) => s.tabId);
  const currentRole = useChatStore((s) => s.currentRole);
  const [uptime, setUptime] = useState<number | null>(null);
  const [version, setVersion] = useState<string>('');
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const [sessionRole, setSessionRole] = useState<string>('');
  const [wsConnected, setWsConnected] = useState(false);

  const refreshStatus = useCallback(async (isActive: () => boolean) => {
    try {
      const [s, sessions] = await Promise.all([api.status(), api.sessions()]);
      if (!isActive()) return;
      const matched = sessions.sessions.find((session) => session.tabId === tabId) ?? null;
      setUptime(s.uptimeSeconds);
      setVersion(s.version);
      setActiveRole(s.activeRole);
      setSessionRole(matched?.roleId ?? currentRole ?? '');
    } catch {
      /* token 失效时不显示 */
    }
  }, [currentRole, tabId, token]);

  usePollingTask(refreshStatus, 5000, [refreshStatus]);

  useEffect(() => {
    const off = wsBus.subscribe((m) => {
      if (m.type === 'hello' || m.type === 'pong') setWsConnected(true);
    });
    return () => {
      off();
    };
  }, []);

  return (
    <header className="h-12 shrink-0 border-b border-slate-200 bg-white flex items-center px-4 text-sm">
      <div className="flex-1 text-slate-600">
        {version ? `v${version}` : '…'} · 全局角色：
        <span className={activeRole ? 'text-brand-700' : 'text-slate-400'}>
          {activeRole || '未激活'}
        </span>
        {' · '}当前会话：
        <span className={sessionRole ? 'text-sky-700' : 'text-slate-400'}>
          {sessionRole || '未选择'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            wsConnected ? 'bg-green-500' : 'bg-slate-300'
          }`}
          title={wsConnected ? 'WebSocket connected' : 'WebSocket disconnected'}
        />
        <span className="text-slate-500 text-xs">
          {formatUptime(uptime)}
        </span>
      </div>
    </header>
  );
}
