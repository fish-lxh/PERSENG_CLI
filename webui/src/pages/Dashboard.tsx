import { useCallback, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { usePollingTask } from '../hooks/usePollingTask';
import { api } from '../lib/api';
import { asArray } from '../lib/collections';
import { formatUptime } from '../lib/format';
import type { StatusInfo, SessionListResponse } from '../lib/types';

export function Dashboard() {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [metrics, setMetrics] = useState<string>('');
  const [sessions, setSessions] = useState<SessionListResponse | null>(null);
  const [err, setErr] = useState<string>('');
  const sessionItems = asArray(sessions?.sessions);

  const refresh = useCallback(async () => {
    try {
      setErr('');
      const [s, m, ss] = await Promise.all([api.status(), api.metrics(), api.sessions()]);
      setStatus(s);
      setMetrics(m);
      setSessions(ss);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  usePollingTask(() => refresh(), 10000, [refresh]);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <button
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
          onClick={refresh}
        >
          刷新
        </button>
      </div>

      <ErrorBanner message={err} />

      {status && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card label="版本" value={status.version} />
          <Card label="PID" value={String(status.pid)} />
          <Card
            label="Uptime"
            value={formatUptime(status.uptimeSeconds)}
          />
          <Card label="激活角色" value={status.activeRole ?? '—'} accent />
        </div>
      )}

      <div>
        <h2 className="text-base font-semibold mb-2">活跃 Web 会话 ({sessions?.count ?? 0}/{sessions?.maxSessions ?? 0})</h2>
        <div className="bg-white border border-slate-200 rounded p-3 text-sm space-y-1 max-h-48 overflow-auto">
          {sessionItems.length ? (
            sessionItems.map((s) => (
              <div key={s.tabId} className="flex gap-3 text-slate-600">
                <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">{s.tabId.slice(0, 8)}</code>
                  <span>·</span>
                  <span>history={s.historyCount}</span>
                  <span>·</span>
                  <span className={isCurrent ? 'text-sky-700' : 'text-slate-400'}>
                <span className="text-slate-400">last {new Date(s.lastActiveAt).toLocaleTimeString()}</span>
              );
            ))
            <div className="text-slate-400">暂无活跃会话</div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-base font-semibold mb-2">Prometheus 指标</h2>
        <pre className="bg-slate-900 text-slate-100 text-xs p-4 rounded overflow-auto max-h-96 leading-relaxed">
          {metrics || '加载中…'}
        </pre>
      </div>
    </div>
  );
}

function Card({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-white border border-slate-200 rounded p-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${accent ? 'text-brand-700' : 'text-slate-900'}`}>
        {value}
      </div>
    </div>
  );
}
