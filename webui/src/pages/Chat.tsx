import { useEffect, useRef, useState } from 'react';
import { ErrorBanner } from '../components/ErrorBanner';
import { useRoleCatalog } from '../hooks/useRoleCatalog';
import { wsBus } from '../lib/ws';
import { WS_TYPE } from '../lib/types';
import { useChatStore } from '../store/chat';

const EMPTY_MESSAGES = [] as const;

export function Chat() {
  const tabId = useChatStore((s) => s.tabId);
  const messages = useChatStore((s) => s.messagesByTab[tabId] ?? EMPTY_MESSAGES);
  const streaming = useChatStore((s) => s.streaming);
  const currentRole = useChatStore((s) => s.currentRole);
  const setCurrentRole = useChatStore((s) => s.setCurrentRole);
  const appendUserMessage = useChatStore((s) => s.appendUserMessage);
  const startAssistantMessage = useChatStore((s) => s.startAssistantMessage);
  const appendToAssistant = useChatStore((s) => s.appendToAssistant);
  const finalizeAssistant = useChatStore((s) => s.finalizeAssistant);
  const addSystemMessage = useChatStore((s) => s.addSystemMessage);
  const reset = useChatStore((s) => s.reset);

  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { roleItems, defaultRoleId, error: rolesError } = useRoleCatalog();

  useEffect(() => {
    if (!currentRole && defaultRoleId) setCurrentRole(defaultRoleId);
  }, [currentRole, defaultRoleId, setCurrentRole]);

  // 自动滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // 订阅 WS 消息
  useEffect(() => {
    const off = wsBus.subscribe((m) => {
      if (m.type === WS_TYPE.TEXT && m.tabId === tabId) {
        appendToAssistant(m.chunk);
      } else if (m.type === WS_TYPE.DONE && m.tabId === tabId) {
        finalizeAssistant();
      } else if (m.type === WS_TYPE.ERROR && m.tabId === tabId) {
        finalizeAssistant();
        addSystemMessage(`[error] ${m.message}`);
      } else if (m.type === WS_TYPE.CANCELLED && m.tabId === tabId) {
        finalizeAssistant();
        addSystemMessage('已取消');
      } else if (m.type === WS_TYPE.ROLE_LOADED && m.tabId === tabId) {
        setCurrentRole(m.roleId);
        addSystemMessage(`角色已切换为 ${m.roleId}`);
      } else if (m.type === WS_TYPE.TOOL_USE && m.tabId === tabId) {
        addSystemMessage(`[tool] ${m.tool}`);
      }
    });
    return off;
  }, [tabId]);

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    appendUserMessage(text);
    setInput('');
    startAssistantMessage();
    wsBus.sendMessage(tabId, text, currentRole || undefined);
  };

  const onCancel = () => {
    wsBus.cancel(tabId);
  };

  const onReset = () => {
    if (streaming) wsBus.cancel(tabId);
    reset();
  };

  const onSwitchRole = (rid: string) => {
    if (rid === currentRole) return;
    if (streaming) {
      addSystemMessage('请先取消或等待当前任务完成');
      return;
    }
    setCurrentRole(rid);
    wsBus.setRole(tabId, rid);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] max-w-4xl">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-semibold">Chat</h1>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">角色</label>
          <select
            value={currentRole}
            onChange={(e) => onSwitchRole(e.target.value)}
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
            onClick={onReset}
            title="清空当前会话历史"
          >
            Reset
          </button>
        </div>
      </div>

      <ErrorBanner message={err || rolesError} className="mb-3" />

      <div
        ref={scrollRef}
        className="flex-1 overflow-auto bg-white border border-slate-200 rounded p-4 space-y-3"
      >
        {messages.length === 0 && (
          <div className="text-center text-slate-400 text-sm py-12">
            输入消息开始与 {currentRole || 'agent'} 对话
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
            <div
              className={`max-w-[80%] inline-block px-3 py-2 rounded text-sm whitespace-pre-wrap break-words ${
                m.role === 'user'
                  ? 'bg-brand-500 text-white'
                  : m.role === 'system'
                    ? 'bg-amber-50 text-amber-900 text-xs border border-amber-200'
                    : 'bg-slate-100 text-slate-800'
              }`}
            >
              {m.streaming && !m.content && <span className="text-slate-400">…</span>}
              {m.content}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="输入消息，回车发送，Shift+Enter 换行"
          rows={2}
          className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm resize-none focus:outline-none focus:border-brand-500"
        />
        <div className="flex flex-col gap-1">
          {streaming ? (
            <button
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
              onClick={onCancel}
            >
              停止
            </button>
          ) : (
            <button
              className="px-4 py-2 bg-brand-600 text-white rounded hover:bg-brand-700 text-sm disabled:opacity-50"
              onClick={send}
              disabled={!input.trim()}
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
