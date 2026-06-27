import { useEffect, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { api } from '../lib/api';
import { useRoleCatalog } from '../hooks/useRoleCatalog';

export function Roles() {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState('');
  const { roles, roleItems, error: rolesError, reloadRoles } = useRoleCatalog();

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    api
      .role(selected)
      .then(setDetail)
      .catch((e) => setErr((e as Error).message));
  }, [selected]);

  return (
    <div className="max-w-6xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">角色管理</h1>
        <button
          className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
          onClick={() => reloadRoles().catch(() => {})}
        >
          刷新
        </button>
      </div>

      <ErrorBanner message={err || rolesError} className="mb-3" />

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-5 bg-white border border-slate-200 rounded">
          <div className="px-4 py-2 border-b border-slate-200 text-xs text-slate-500">
            共 {roles?.count ?? 0} 个角色
          </div>
          <ul>
            {roleItems.map((r) => (
              <li key={r.id}>
                <button
                  className={`w-full text-left px-4 py-2 hover:bg-slate-50 flex items-center justify-between ${
                    selected === r.id ? 'bg-brand-50' : ''
                  }`}
                  onClick={() => setSelected(r.id)}
                >
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      {r.name || r.id}
                      {roles?.active === r.id && (
                        <span className="ml-2 text-xs text-brand-700">● 激活</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">{r.id}</div>
                  </div>
                </button>
              </li>
            ))}
            {roleItems.length === 0 && (
              <li className="px-4 py-6 text-center text-slate-400 text-sm">没有角色</li>
            )}
          </ul>
        </div>

        <div className="col-span-7 bg-white border border-slate-200 rounded">
          <div className="px-4 py-2 border-b border-slate-200 text-xs text-slate-500">
            详情
          </div>
          <pre className="p-4 text-xs overflow-auto max-h-[60vh] text-slate-700">
            {detail ? JSON.stringify(detail, null, 2) : '选择一个角色查看详情'}
          </pre>
        </div>
      </div>
    </div>
  );
}
