// 聊天状态：tabId 存 sessionStorage（每个浏览器 tab 独立），
// messages 按 tabId 分桶（虽然 v1 单会话，预留多 tab 扩展位）。

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean; // assistant 消息是否正在流式追加
  ts: number;
}

interface ChatState {
  tabId: string;
  currentRole: string;
  streaming: boolean;
  messagesByTab: Record<string, ChatMessage[]>;

  setTabId: (id: string) => void;
  setCurrentRole: (r: string) => void;
  setStreaming: (s: boolean) => void;

  appendUserMessage: (text: string) => string; // 返回 messageId
  startAssistantMessage: () => string;
  appendToAssistant: (text: string) => void;
  finalizeAssistant: () => void;
  addSystemMessage: (text: string) => void;

  reset: () => void;
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const tabStorage = {
  getItem: (key: string): string | null => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  removeItem: (key: string) => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      tabId: newId(),
      currentRole: '',
      streaming: false,
      messagesByTab: {},

      setTabId: (tabId) => set({ tabId }),
      setCurrentRole: (currentRole) => set({ currentRole }),
      setStreaming: (streaming) => set({ streaming }),

      appendUserMessage: (text) => {
        const id = newId();
        const msg: ChatMessage = { id, role: 'user', content: text, ts: Date.now() };
        const tabId = get().tabId;
        set((s) => ({
          messagesByTab: {
            ...s.messagesByTab,
            [tabId]: [...(s.messagesByTab[tabId] || []), msg],
          },
        }));
        return id;
      },

      startAssistantMessage: () => {
        const id = newId();
        const msg: ChatMessage = {
          id,
          role: 'assistant',
          content: '',
          streaming: true,
          ts: Date.now(),
        };
        const tabId = get().tabId;
        set((s) => ({
          messagesByTab: {
            ...s.messagesByTab,
            [tabId]: [...(s.messagesByTab[tabId] || []), msg],
          },
          streaming: true,
        }));
        return id;
      },

      appendToAssistant: (text) => {
        const tabId = get().tabId;
        set((s) => {
          const arr = s.messagesByTab[tabId] || [];
          if (arr.length === 0) return s;
          const last = arr[arr.length - 1];
          if (last.role !== 'assistant' || !last.streaming) return s;
          const updated = [...arr];
          updated[updated.length - 1] = { ...last, content: last.content + text };
          return {
            messagesByTab: { ...s.messagesByTab, [tabId]: updated },
          };
        });
      },

      finalizeAssistant: () => {
        const tabId = get().tabId;
        set((s) => {
          const arr = s.messagesByTab[tabId] || [];
          if (arr.length === 0) return s;
          const last = arr[arr.length - 1];
          if (last.role !== 'assistant') return s;
          const updated = [...arr];
          updated[updated.length - 1] = { ...last, streaming: false };
          return {
            messagesByTab: { ...s.messagesByTab, [tabId]: updated },
            streaming: false,
          };
        });
      },

      addSystemMessage: (text) => {
        const tabId = get().tabId;
        const msg: ChatMessage = { id: newId(), role: 'system', content: text, ts: Date.now() };
        set((s) => ({
          messagesByTab: {
            ...s.messagesByTab,
            [tabId]: [...(s.messagesByTab[tabId] || []), msg],
          },
        }));
      },

      reset: () => {
        const tabId = get().tabId;
        set((s) => ({
          messagesByTab: { ...s.messagesByTab, [tabId]: [] },
          streaming: false,
        }));
      },
    }),
    {
      name: 'perseng.chat',
      storage: createJSONStorage(() => tabStorage),
      partialize: (s) => ({
        tabId: s.tabId,
        currentRole: s.currentRole,
        messagesByTab: s.messagesByTab,
      }),
    }
  )
);
