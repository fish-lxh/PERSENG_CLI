/**
 * serve-http — HTTP + WebSocket 管理与聊天面板 (M3.5 + WebUI)
 *
 * 用 Node 内置 http 模块（仅 ws 依赖），三合一服务：
 *
 * HTTP REST API：
 *   GET  /status              健康检查 + 概要信息
 *   GET  /metrics             Prometheus 格式指标
 *   GET  /roles               列出所有角色 + 激活状态
 *   GET  /roles/:id           单个角色详情
 *   GET  /memory?role=X       列出某角色的记忆
 *   GET  /memory/stats?role=X 记忆统计
 *   GET  /memory/:id?role=X   单条记忆详情
 *   POST /memory/:id/forget?role=X  删除一条记忆
 *   GET  /sessions            列出 WebUI 活跃会话
 *
 * WebSocket：
 *   /ws/chat                  与 agent 流式对话
 *
 * 静态资源：
 *   GET /*  fallback          serve webui/dist/ SPA
 *
 * 安全：
 *   - 默认仅 127.0.0.1 监听（避免暴露到公网）
 *   - 简单 token 鉴权（PERSENG_HTTP_TOKEN 环境变量；非空时强制）
 *   - HTTP：Authorization: Bearer <token>
 *   - WS 浏览器：Sec-WebSocket-Protocol: perseng-token, <token>
 *   - WS 非浏览器：?token=<token>
 */

import http from 'http';
import { URL } from 'url';
import { getConfig } from '../config.js';
import pkg from '../package-wrapper.js';
import { listRolesAsync, loadRole, getRolesDir } from '../role-loader.js';
import { readActiveRoleId } from '../rolex/ActiveRoleStore.js';
import { listEngrams, getEngram, forget, getMemoryStats } from '../cognition/MemoryStore.js';
import { collectMetrics } from './metrics.js';
import { TaskEngine } from '../task-engine.js';
import { attachWs } from '../web/WsHub.js';
import { WebSessionStore } from '../web/WebSessionStore.js';
import { serveStatic } from '../web/static.js';
import { extractToken } from '../web/auth.js';

const APP_START_TIME = Date.now();

/** 模块级 WebSessionStore 引用，handle() 需要读取它来响应 /sessions */
let webSessionStore = null;

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body, null, 2), 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function notFound(res, msg = 'Not Found') {
  json(res, 404, { error: msg });
}

function badRequest(res, msg) {
  json(res, 400, { error: msg });
}

function checkAuth(req, res) {
  const required = getConfig().httpToken;
  if (!required) return true; // 没配置 token = 任何人都能访问（仅 127.0.0.1）

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== required) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * 路由处理
 */
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const rawPath = url.pathname.replace(/\/+$/, '') || '/';
  const path = rawPath === '/api' ? '/' : rawPath.startsWith('/api/') ? (rawPath.slice(4) || '/') : rawPath;
  const method = req.method || 'GET';

  // 静态文件 / SPA fallback（不需要 token，让用户先看到 UI 再输）
  if (method === 'GET' || method === 'HEAD') {
    // 不要让 API 路径走到 SPA fallback
    if (rawPath !== '/api' && !rawPath.startsWith('/api/') && !isApiPath(rawPath)) {
      if (serveStatic(req, res, url)) return null;
    }
  }

  // 以下都是 API 路由，必须鉴权
  if (!checkAuth(req, res)) return;

  // /status
  if (path === '/' || path === '/status') {
    if (method !== 'GET') return badRequest(res, 'GET only');
    const activeId = readActiveRoleId();
    return json(res, 200, {
      name: 'perseng-cli',
      version: pkg.version,
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - APP_START_TIME) / 1000),
      activeRole: activeId,
      dataDir: getConfig().dataDir,
      timestamp: new Date().toISOString(),
    });
  }

  // /metrics
  if (path === '/metrics') {
    if (method !== 'GET') return badRequest(res, 'GET only');
    const allMetrics = await collectMetrics({
      include: url.searchParams.get('include') || undefined,
    });
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(toPrometheusText(allMetrics));
    return;
  }

  // /roles
  if (path === '/roles') {
    if (method !== 'GET') return badRequest(res, 'GET only');
    const roles = await listRolesAsync();
    const activeId = readActiveRoleId();
    return json(res, 200, {
      rolesDir: getRolesDir(),
      active: activeId,
      count: roles.length,
      roles,
    });
  }

  // /roles/:id
  const roleMatch = path.match(/^\/roles\/([\w-]+)$/);
  if (roleMatch) {
    if (method !== 'GET') return badRequest(res, 'GET only');
    try {
      const role = loadRole(roleMatch[1]);
      return json(res, 200, role);
    } catch (err) {
      return notFound(res, err.userMessage || err.message);
    }
  }

  // /memory
  if (path === '/memory') {
    if (method !== 'GET') return badRequest(res, 'GET only');
    const roleId = url.searchParams.get('role') || readActiveRoleId() || getConfig().role;
    if (!roleId) return badRequest(res, 'role parameter required');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 500);
    const engrams = await listEngrams(roleId, { limit });
    return json(res, 200, { roleId, count: engrams.length, engrams });
  }

  // /memory/stats
  if (path === '/memory/stats') {
    if (method !== 'GET') return badRequest(res, 'GET only');
    const roleId = url.searchParams.get('role') || readActiveRoleId() || getConfig().role;
    if (!roleId) return badRequest(res, 'role parameter required');
    const stats = await getMemoryStats(roleId);
    if (!stats) return notFound(res, 'stats unavailable');
    return json(res, 200, stats);
  }

  // /memory/:id
  const memoryMatch = path.match(/^\/memory\/([\w_-]+)$/);
  if (memoryMatch) {
    if (method !== 'GET') return badRequest(res, 'GET only');
    const roleId = url.searchParams.get('role') || readActiveRoleId() || getConfig().role;
    if (!roleId) return badRequest(res, 'role parameter required');
    const engram = await getEngram(roleId, memoryMatch[1]);
    if (!engram) return notFound(res, `engram ${memoryMatch[1]} not found`);
    return json(res, 200, engram);
  }

  // POST /memory/:id/forget
  const forgetMatch = path.match(/^\/memory\/([\w_-]+)\/forget$/);
  if (forgetMatch) {
    if (method !== 'POST') return badRequest(res, 'POST only');
    const roleId = url.searchParams.get('role') || readActiveRoleId() || getConfig().role;
    if (!roleId) return badRequest(res, 'role parameter required');
    const result = await forget(roleId, forgetMatch[1]);
    return json(res, result.deleted ? 200 : 404, result);
  }

  // GET /sessions — 列出 WebUI 活跃会话（用于 Dashboard 调试）
  if (path === '/sessions') {
    if (method !== 'GET') return badRequest(res, 'GET only');
    const sessions = webSessionStore ? webSessionStore.allSessions() : [];
    return json(res, 200, {
      count: sessions.length,
      maxSessions: webSessionStore ? webSessionStore.maxSessions : 0,
      sessions,
    });
  }

  return notFound(res, `No route for ${method} ${path}`);
}

/**
 * 判断路径是否属于 API 路由（避免被 SPA fallback 抢走）
 */
function isApiPath(path) {
  return (
    path === '/status' ||
    path === '/metrics' ||
    path === '/sessions' ||
    path.startsWith('/roles') ||
    path.startsWith('/memory')
  );
}

/**
 * Prometheus 文本序列化（与 metrics.js 同源）
 */
function toPrometheusText(data) {
  if (!data || !data.metrics) return '';
  const lines = [];
  const seen = new Set();
  for (const [key, m] of Object.entries(data.metrics)) {
    const baseName = key.split('{')[0];
    if (!seen.has(baseName)) {
      seen.add(baseName);
      if (m.help) lines.push(`# HELP ${baseName} ${m.help}`);
      if (m.type) lines.push(`# TYPE ${baseName} ${m.type}`);
    }
    if (m.labels) {
      const labelsStr = Object.entries(m.labels)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
        .join(',');
      lines.push(`${baseName}{${labelsStr}} ${m.value}`);
    } else {
      lines.push(`${key} ${m.value}`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function serveHttpCommand(options) {
  const config = getConfig();
  const port = parseInt(options.port || String(config.httpPort), 10);
  const host = options.host || config.httpHost;

  // ---- 初始化 WebSessionStore（每个 tabId 一个独立 TaskEngine） ----
  webSessionStore = new WebSessionStore({
    maxSessions: config.httpMaxSessions,
    engineFactory: (tabId, roleId) => new TaskEngine({ roleId }),
  });
  webSessionStore.startSweep();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // 全局错误兜底
      try {
        const buf = Buffer.from(JSON.stringify({ error: err.message }), 'utf-8');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(buf);
      } catch {
        try { res.destroy(); } catch { /* ignore */ }
      }
    });
  });

  // ---- 绑定 WebSocket 升级（/ws/chat） ----
  attachWs(server, {
    sessionStore: webSessionStore,
    resolveRoleId: async () => readActiveRoleId() || getConfig().role,
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  process.stderr.write(`perseng-cli HTTP server listening on http://${host}:${port}\n`);
  process.stderr.write(`REST:     GET  /status /metrics /roles /roles/:id /memory /memory/stats /memory/:id\n`);
  process.stderr.write(`          POST /memory/:id/forget\n`);
  process.stderr.write(`          GET  /sessions\n`);
  process.stderr.write(`WS:       /ws/chat  (Sec-WebSocket-Protocol: perseng-token,<token>)\n`);
  process.stderr.write(`Static:   webui/dist/  (SPA fallback to index.html)\n`);
  if (config.httpToken) {
    process.stderr.write(`Auth: Bearer / WS subprotocol / ?token=  (PERSENG_HTTP_TOKEN required)\n`);
  } else {
    process.stderr.write(`Auth: disabled (no PERSENG_HTTP_TOKEN set; only safe on 127.0.0.1)\n`);
  }

  // 优雅退出
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`Received ${signal}, shutting down...\n`);
    // 取消所有活跃的 agent run
    try { webSessionStore?.clear(); } catch { /* ignore */ }
    try { webSessionStore?.stopSweep(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 保持进程存活
  await new Promise(() => {});
}
