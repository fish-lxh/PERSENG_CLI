// WebSocket 单例：自动重连 + 心跳 + Bearer token via subprotocol

import { useAuthStore } from '../store/auth';
import type { ClientMessage, ServerMsg } from './types';
import { WS_TYPE } from './types';

type Listener = (m: ServerMsg) => void;

function resolveWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';

  if (import.meta.env.DEV && __PERSENG_DEV_BACKEND_URL__) {
    try {
      const url = new URL(__PERSENG_DEV_BACKEND_URL__);
      url.protocol = proto;
      url.pathname = '/ws/chat';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      // ignore invalid dev backend URL and fall back to same-origin
    }
  }

  return `${proto}//${location.host}/ws/chat`;
}

class WebSocketBus {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  private heartbeatTimer: number | null = null;
  private closed = false;

  connect() {
    if (this.ws || this.closed) return;
    const token = useAuthStore.getState().token;
    const url = resolveWsUrl();
    const sub = token ? ['perseng-token', token] : undefined;

    try {
      this.ws = sub ? new WebSocket(url, sub) : new WebSocket(url);
    } catch (err) {
      console.error('[ws] connect failed', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMsg;
        this.listeners.forEach((l) => {
          try {
            l(msg);
          } catch (err) {
            console.error('[ws] listener error', err);
          }
        });
      } catch (err) {
        console.error('[ws] bad JSON', err);
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      if (!this.closed) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // 浏览器 error 事件不暴露有效细节；由 onclose 负责重连即可。
    };
  }

  close() {
    this.closed = true;
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  reconnect() {
    this.closed = false;
    this.closeSocketOnly();
    this.connect();
  }

  send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('[ws] send dropped, not open');
    }
  }

  sendMessage(tabId: string, prompt: string, roleId?: string) {
    this.send({ type: WS_TYPE.MESSAGE, tabId, prompt, roleId });
  }

  cancel(tabId: string) {
    this.send({ type: WS_TYPE.CANCEL, tabId });
  }

  setRole(tabId: string, roleId: string) {
    this.send({ type: WS_TYPE.SET_ROLE, tabId, roleId });
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private scheduleReconnect() {
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), delay);
  }

  private closeSocketOnly() {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: WS_TYPE.PING });
      }
    }, 25000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer != null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export const wsBus = new WebSocketBus();
