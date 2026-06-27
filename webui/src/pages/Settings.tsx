import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth';
import { wsBus } from '../lib/ws';

export function Settings() {
  const token = useAuthStore((s) => s.token);
  const setToken = useAuthStore((s) => s.setToken);
  const clear = useAuthStore((s) => s.clear);
  const [draft, setDraft] = useState(token);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(token);
  }, [token]);

  const save = () => {
    setToken(draft.trim());
    setSaved(true);
    // token 变化后主动重建连接
    wsBus.reconnect();
    setTimeout(() => setSaved(false), 1500);
  };

  const clearToken = () => {
    setDraft('');
    clear();
    wsBus.reconnect();
  };

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-xl font-semibold">Settings</h1>

      <section className="bg-white border border-slate-200 rounded p-5 space-y-3">
        <h2 className="font-medium">PERSENG_HTTP_TOKEN</h2>
        <p className="text-sm text-slate-600">
          如果后端配置了 <code className="bg-slate-100 px-1 rounded">PERSENG_HTTP_TOKEN</code>，
          在此填入相同值（不需要包含 <code>Bearer</code> 前缀）。
        </p>
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="（空 = 不鉴权）"
          className="w-full border border-slate-300 rounded px-3 py-2 text-sm font-mono"
        />
        <div className="flex items-center gap-2">
          <button
            className="px-4 py-1.5 bg-brand-600 text-white rounded text-sm hover:bg-brand-700"
            onClick={save}
          >
            保存
          </button>
          <button
            className="px-4 py-1.5 border border-slate-300 rounded text-sm hover:bg-slate-50"
            onClick={clearToken}
          >
            清空
          </button>
          {saved && <span className="text-xs text-green-600">已保存</span>}
        </div>
      </section>

      <section className="bg-white border border-slate-200 rounded p-5 space-y-2 text-sm text-slate-600">
        <h2 className="font-medium text-slate-800">关于</h2>
        <p>
          本 WebUI 通过浏览器与本地 <code>127.0.0.1:7717</code> 的 perseng-cli 服务通信。
          聊天使用 WebSocket ( <code>/ws/chat</code> )，管理 API 使用 HTTP REST。
        </p>
        <p className="text-xs text-slate-400">
          仅在受信网络使用；如需公网访问请配置反向代理 + TLS + 强 token。
        </p>
      </section>
    </div>
  );
}
