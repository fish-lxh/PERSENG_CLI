/**
 * 统一鉴权辅助（HTTP + WebSocket 共用）
 *
 * token 来源优先级：
 *   1) Authorization: Bearer <token>        （HTTP 主流）
 *   2) Sec-WebSocket-Protocol: perseng-token, <token>   （浏览器 WS 唯一可设 header）
 *   3) ?token=<token>                       （非浏览器 WS 客户端，如 wscat）
 *
 * 当 PERSENG_HTTP_TOKEN 未配置时，HTTP 不强制鉴权（默认仅监听 127.0.0.1）。
 */

import { WS_SUBPROTOCOL } from './protocol.js';
import { getConfig } from '../config.js';

/**
 * 从任意请求（HTTP 或 WS upgrade）中提取 token。
 * @param {import('http').IncomingMessage} req
 * @returns {string} 提取到的 token，没有则返回空字符串
 */
export function extractToken(req) {
  // 1) Authorization: Bearer
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }

  // 2) Sec-WebSocket-Protocol: perseng-token, <token>
  const protoHeader = req.headers['sec-websocket-protocol'];
  if (typeof protoHeader === 'string') {
    // 形如 "perseng-token, abcdef" 或 "perseng-token, abcdef, other"
    const parts = protoHeader.split(',').map((s) => s.trim());
    const idx = parts.indexOf(WS_SUBPROTOCOL);
    if (idx !== -1 && idx + 1 < parts.length) {
      const t = parts[idx + 1];
      if (t) return t;
    }
  }

  // 3) ?token=
  try {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);
    const t = url.searchParams.get('token');
    if (t) return t;
  } catch {
    /* ignore */
  }

  return '';
}

/**
 * 校验请求是否通过鉴权。
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
export function checkAuth(req) {
  const required = getConfig().httpToken;
  if (!required) return true; // 未配置 token → 不强制
  return extractToken(req) === required;
}

/**
 * 在 WS 升级握手时使用：拒绝非法请求并关闭 socket。
 * 返回 true 表示通过；false 表示已发送 401 并关闭 socket（caller 不应继续 upgrade）。
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('net').Socket} socket
 * @returns {boolean}
 */
export function checkAuthUpgrade(req, socket) {
  if (checkAuth(req)) return true;
  try {
    const body = 'Unauthorized';
    socket.write(
      `HTTP/1.1 401 Unauthorized\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n` +
        `\r\n${body}`
    );
  } catch {
    /* ignore */
  }
  try {
    socket.destroy();
  } catch {
    /* ignore */
  }
  return false;
}
