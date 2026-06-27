import { useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { api } from '../lib/api';
import { asArray } from '../lib/collections';
import { useRoleCatalog } from '../hooks/useRoleCatalog';
import { useChatStore } from '../store/chat';
import type { MemoryListResponse } from '../lib/types';

export function Memory() {
  const [role, setRole] = useState<string>('');
  const [data, setData] = useState<MemoryListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const addSystemMessage = useChatStore.getState().addSystemMessage;
  const { roleItems, defaultRoleId, error: rolesError } = useRoleCatalog();
  const engramItems = asArray(data?.engrams);

  useEffect(() => {
    if (!role && defaultRoleId) setRole(defaultRoleId);
  }, [role, defaultRoleId]);

  const load = async () => {
    if (!role) return;
    setLoading(true);
    setErr('');
    try {
      const d = await api.memory(role, 100, 0);
      setData(d);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [role]);

  const doForget = async (id: string) => {
    try {
      const r = await api.forget(role, id);
      if (r.deleted) {
        addSystemMessage(`已删除记忆 ${id}`);
        load();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setConfirmDel(null);
    }
  };

  return (
    <div className="max-w-5xl">
      <h1 className="text-xl font-semibold mb-4">记忆管理</h1>

      <ErrorBanner message={err || rolesError} className="mb-3" />

      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm text-slate-600">角色</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="border border-slate-300 rounded px-2 py-1 text-sm"
        >
          {roleItems.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name || r.id}
            </option>
          ))}
        </select>
        <button
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
          onClick={load}
          disabled={loading}
        >
          刷新
        </button>
        <span className="text-xs text-slate-500">
          {data ? `共 ${data.count} 条` : ''}
        </span>
      </div>

      <div className="bg-white border border-slate-200 rounded">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-xs">
            <tr>
              <th className="text-left px-4 py-2 w-32">ID</th>
              <th className="text-left px-4 py-2 w-20">类型</th>
              <th className="text-left px-4 py-2">内容</th>
              <th className="text-left px-4 py-2 w-32">强度</th>
              <th className="px-4 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {engramItems.map((e) => (
              <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-2 font-mono text-xs text-slate-500">{e.id.slice(0, 12)}</td>
                <td className="px-4 py-2 text-xs">{e.type || '—'}</td>
                <td className="px-4 py-2 text-slate-700 truncate max-w-xl" title={e.content}>
                  {e.content || '—'}
                </td>
                <td className="px-4 py-2 text-xs">{e.strength || '—'}</td>
                <td className="px-4 py-2 text-right">
                  <button
                    className="text-red-600 hover:underline text-xs"
                    onClick={() => setConfirmDel(e.id)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {engramItems.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  该角色暂无记忆
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {confirmDel && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded p-6 max-w-sm w-full mx-4">
            <h3 className="font-semibold mb-2">确认删除</h3>
            <p className="text-sm text-slate-600 mb-4">
              永久删除记忆 <code>{confirmDel.slice(0, 16)}</code>？此操作不可撤销。
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
                onClick={() => setConfirmDel(null)}
              >
                取消
              </button>
              <button
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                onClick={() => doForget(confirmDel)}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
