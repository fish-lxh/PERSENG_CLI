/**
 * static.js — SPA 静态文件服务
 *
 * 路径：../../webui/dist（相对于 src/web/）
 * 路径遍历防护：
 *   - decoded 必须不含 '..' 或 '\0'
 *   - abs 必须以 DIST 为前缀
 * SPA fallback：找不到文件或目录 → 退回 index.html
 * Cache-Control：
 *   - hashed assets（/assets/index-AbCd1234.js） → public, max-age=31536000, immutable
 *   - index.html                                  → no-cache, must-revalidate
 *   - 其它                                        → public, max-age=300
 *
 * 如果 DIST 不存在：返回友好的"WebUI 未构建"页面。
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, extname, join, resolve, sep } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIST = resolve(__dirname, '..', '..', 'webui', 'dist');
const INDEX_HTML = join(DIST, 'index.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

function isHashedAsset(filename) {
  // Vite 默认输出形如 index-AbCd1234.js / index-AbCd1234.css
  return /-[A-Za-z0-9_-]{6,}\.[a-z]+$/.test(filename);
}

function buildNotBuiltHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>PersEng WebUI — 未构建</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 64px auto; padding: 0 16px; color: #1a1a1a; }
    h1 { color: #b91c1c; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; }
    pre { background: #0f172a; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; }
    .muted { color: #6b7280; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>PersEng WebUI 未构建</h1>
  <p>检测到 <code>webui/dist/</code> 不存在。请在部署主机上构建前端：</p>
  <pre>cd webui
npm install
npm run build</pre>
  <p class="muted">构建产物会被 <code>serve-http.js</code> 自动 serve 到 <code>/</code>。</p>
</body>
</html>`;
}

/**
 * 处理 GET 静态文件请求。
 * @returns {boolean} true 表示已写入响应；false 表示请求不是静态资源（让上层走 404）
 */
export function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // 仅处理 / 下的请求（API 路由已经在更上层匹配过）
  if (!url.pathname.startsWith('/')) return false;

  // DIST 不存在 → 返回友好页面
  if (!existsSync(DIST)) {
    const html = buildNotBuiltHtml();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Cache-Control': 'no-store',
    });
    res.end(html);
    return true;
  }

  // 路径遍历防护
  let decoded;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  // 防御深度：同时检查原始 req.url 的解码版本
  // （Node WHATWG URL 会自动解码 %2e%2e → ..，所以 pathname 上看不出原始编码）
  const rawUrl = req.url || '';
  let rawDecoded;
  try {
    rawDecoded = decodeURIComponent(rawUrl);
  } catch {
    rawDecoded = rawUrl;
  }
  if (decoded.includes('..') || decoded.includes('\0') ||
      rawDecoded.includes('..') || rawDecoded.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return true;
  }

  // 计算绝对路径
  const rel = decoded.replace(/^\/+/, '');
  const abs = resolve(DIST, rel);

  // 必须仍在 DIST 之内
  if (!abs.startsWith(DIST + sep) && abs !== DIST) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return true;
  }

  let target = abs;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    // SPA fallback
    target = INDEX_HTML;
    if (!existsSync(target)) {
      // index.html 也不存在（dist 里有别的但没 index）
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html missing');
      return true;
    }
  }

  // 读文件
  let buf;
  try {
    buf = readFileSync(target);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Read error: ${err.message}`);
    return true;
  }

  const filename = target.split(/[/\\]/).pop() || '';
  const ext = extname(filename).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  // Cache-Control
  let cacheControl;
  if (filename === 'index.html') {
    cacheControl = 'no-cache, must-revalidate';
  } else if (isHashedAsset(filename)) {
    cacheControl = 'public, max-age=31536000, immutable';
  } else {
    cacheControl = 'public, max-age=300';
  }

  const headers = {
    'Content-Type': contentType,
    'Content-Length': buf.length,
    'Cache-Control': cacheControl,
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
  } else {
    res.writeHead(200, headers);
    res.end(buf);
  }
  return true;
}

/** 暴露 DIST 路径供调试/文档使用 */
export const DIST_PATH = DIST;
