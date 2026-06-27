/**
 * WsHub — WebSocket 端点 /ws/chat
 *
 * - 使用 noServer: true 复用 HTTP server 的 upgrade 事件
 * - 仅接受 /ws/chat 路径的升级，其它路径 destroy
 * - 鉴权复用 auth.js（与 HTTP 共用 token 提取）
 * - 消息分发：MESSAGE → TaskEngine.run + 流式 onText → text 事件
 * - onText 用 try/catch 包裹（防止回调异常打断 LLM 流）
 * - WebSocket 关闭时清空所有 session 的 abortCtl
 */

import { WebSocketServer } from 'ws';
import { checkAuthUpgrade } from './auth.js';
import { WS_TYPE } from './protocol.js';

const WS_PATH = '/ws/chat';

/**
 * 绑定 WebSocket 服务到已有 HTTP server。
 *
 * @param {import('http').Server} httpServer
 * @param {object} deps
 * @param {import('./WebSessionStore.js').WebSessionStore} deps.sessionStore
 * @param {(roleId: string) => Promise<string>} deps.resolveRoleId  - 默认角色解析（来自 readActiveRoleId）
 * @returns {WebSocketServer}
 */
export function attachWs(httpServer, { sessionStore, resolveRoleId }) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let path = '/';
    try {
      const host = req.headers.host || 'localhost';
      path = new URL(req.url || '/', `http://${host}`).pathname;
    } catch {
      /* ignore */
    }

    if (path !== WS_PATH) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }

    if (!checkAuthUpgrade(req, socket)) {
      return; // 401 已发出
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, { sessionStore, resolveRoleId });
    });
  });

  return wss;
}

/**
 * 处理单个 WebSocket 连接
 */
function onConnection(ws, { sessionStore, resolveRoleId }) {
  // 心跳：服务端 ping 每 30s；客户端 pong 触发 ws 自动响应（无需处理）
  let alive = true;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  const heartbeat = setInterval(() => {
    if (!alive) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      clearInterval(heartbeat);
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }, 30_000);
  heartbeat.unref?.();

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendError(ws, null, 'Invalid JSON');
      return;
    }

    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      sendError(ws, null, 'Missing type');
      return;
    }

    try {
      switch (msg.type) {
        case WS_TYPE.PING:
          ws.send(JSON.stringify({ type: WS_TYPE.PONG, ts: Date.now() }));
          break;

        case WS_TYPE.MESSAGE:
          await handleMessage(ws, sessionStore, resolveRoleId, msg);
          break;

        case WS_TYPE.CANCEL:
          handleCancel(ws, sessionStore, msg);
          break;

        case WS_TYPE.SET_ROLE:
          await handleSetRole(ws, sessionStore, msg);
          break;

        default:
          sendError(ws, msg.tabId, `Unknown type: ${msg.type}`);
      }
    } catch (err) {
      sendError(ws, msg.tabId, err?.userMessage || err?.message || String(err));
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    // 不清空 session：浏览器刷新后会重连，session 仍可复用
  });

  ws.on('error', (err) => {
    process.stderr.write(`[ws] error: ${err.message}\n`);
  });

  // 欢迎消息
  try {
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  } catch {
    /* ignore */
  }
}

/**
 * 处理 message：执行一次 agent run
 */
async function handleMessage(ws, sessionStore, resolveRoleId, msg) {
  const tabId = msg.tabId;
  const prompt = msg.prompt;
  if (!tabId || typeof tabId !== 'string') {
    sendError(ws, tabId, 'tabId required');
    return;
  }
  if (!prompt || typeof prompt !== 'string') {
    sendError(ws, tabId, 'prompt required');
    return;
  }

  const roleId = msg.roleId || (await resolveRoleId());
  const session = sessionStore.getOrCreate(tabId, roleId);

  // 取消上一次 in-flight 任务（如有）
  if (session.abortCtl) {
    session.abortCtl.abort('superseded by new message');
  }
  const abortCtl = new AbortController();
  session.abortCtl = abortCtl;

  // 推流式 chunk
  const safeSend = (obj) => {
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      process.stderr.write(`[ws] send failed: ${err.message}\n`);
      try {
        abortCtl.abort('send failed');
      } catch {
        /* ignore */
      }
    }
  };

  const onText = (chunk) => {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    safeSend({ type: WS_TYPE.TEXT, tabId, chunk });
  };

  try {
    const result = await session.taskEngine.run(prompt, {
      roleId,
      signal: abortCtl.signal,
      onText,
    });

    // 保存到 history（用于未来 v2 的回放）
    session.history.push({ role: 'user', content: prompt, ts: new Date().toISOString() });
    if (typeof result === 'string' && result && result !== '(No output generated)') {
      session.history.push({ role: 'assistant', content: result, ts: new Date().toISOString() });
    }

    session.lastActiveAt = new Date();
    safeSend({ type: WS_TYPE.DONE, tabId });
  } catch (err) {
    if (abortCtl.signal.aborted) {
      // 用户取消或被新消息覆盖
      return;
    }
    sendError(ws, tabId, err?.userMessage || err?.message || String(err));
  } finally {
    if (session.abortCtl === abortCtl) {
      session.abortCtl = null;
    }
  }
}

/**
 * 处理 cancel
 */
function handleCancel(ws, sessionStore, msg) {
  const tabId = msg.tabId;
  if (!tabId) {
    sendError(ws, tabId, 'tabId required');
    return;
  }
  const session = sessionStore.get(tabId);
  if (session?.abortCtl) {
    session.abortCtl.abort('user cancel');
  }
  try {
    ws.send(JSON.stringify({ type: WS_TYPE.CANCELLED, tabId }));
  } catch {
    /* ignore */
  }
}

/**
 * 处理 set_role
 */
async function handleSetRole(ws, sessionStore, msg) {
  const tabId = msg.tabId;
  const roleId = msg.roleId;
  if (!tabId || !roleId) {
    sendError(ws, tabId, 'tabId and roleId required');
    return;
  }
  // setRole 会 evict 并 abort 任何 in-flight
  const session = sessionStore.setRole(tabId, roleId);
  try {
    ws.send(JSON.stringify({ type: WS_TYPE.ROLE_LOADED, tabId, roleId: session.roleId }));
  } catch {
    /* ignore */
  }
}

/**
 * 发送 error 帧（不抛异常，避免影响后续消息处理）
 */
function sendError(ws, tabId, message) {
  try {
    ws.send(
      JSON.stringify({
        type: WS_TYPE.ERROR,
        tabId: tabId || null,
        message: String(message),
      })
    );
  } catch {
    /* ignore */
  }
}
