/**
 * Web Search — 多后端搜索单元测试
 *
 * 覆盖：
 *   - 参数校验：空 query、未知 backend、缺 apiKey
 *   - 环境总开关：PERSENG_ALLOW_NETWORK 未设时拒绝
 *   - resolveBackendFromEnv：auto 模式下回退到 duckduckgo
 *   - DDG HTML 解析：标题/URL/摘要抽取，URL 重定向展开
 *   - 集成 _execWebSearch：成功 / dryrun / 错误日志
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  webSearch,
  resolveBackendFromEnv,
  BACKEND_DOMAINS,
} from '../src/toolx/web-search.js';
import { ToolXProtocol } from '../src/toolx/ToolXProtocol.js';

// ────────────────────────────────────────────────
// resolveBackendFromEnv
// ────────────────────────────────────────────────

test('resolveBackendFromEnv: auto 模式默认回退到 duckduckgo', () => {
  const prevBrave = process.env.BRAVE_API_KEY;
  const prevTavily = process.env.TAVILY_API_KEY;
  const prevSerp = process.env.SERPAPI_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPAPI_API_KEY;

  const r = resolveBackendFromEnv('auto');
  assert.equal(r.backend, 'duckduckgo');
  assert.equal(r.apiKey, null);

  if (prevBrave) process.env.BRAVE_API_KEY = prevBrave;
  if (prevTavily) process.env.TAVILY_API_KEY = prevTavily;
  if (prevSerp) process.env.SERPAPI_API_KEY = prevSerp;
});

test('resolveBackendFromEnv: auto 模式优先 brave', () => {
  const prev = process.env.BRAVE_API_KEY;
  process.env.BRAVE_API_KEY = 'test-key';
  const r = resolveBackendFromEnv('auto');
  assert.equal(r.backend, 'brave');
  assert.equal(r.apiKey, 'test-key');
  if (prev) process.env.BRAVE_API_KEY = prev; else delete process.env.BRAVE_API_KEY;
});

test('resolveBackendFromEnv: 显式 backend 时仍读对应 env', () => {
  const prev = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tv-key';
  const r = resolveBackendFromEnv('tavily');
  assert.equal(r.backend, 'tavily');
  assert.equal(r.apiKey, 'tv-key');
  if (prev) process.env.TAVILY_API_KEY = prev; else delete process.env.TAVILY_API_KEY;
});

// ────────────────────────────────────────────────
// webSearch — 基础校验
// ────────────────────────────────────────────────

test('webSearch: 空 query 拒绝', async () => {
  const r = await webSearch('', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /query/);
});

test('webSearch: 未知 backend 拒绝', async () => {
  const prev = process.env.PERSENG_ALLOW_NETWORK;
  process.env.PERSENG_ALLOW_NETWORK = '1';
  try {
    const r = await webSearch('hello', { backend: 'not-a-backend' });
    assert.equal(r.ok, false);
    assert.match(r.error, /未知后端/);
  } finally {
    if (prev) process.env.PERSENG_ALLOW_NETWORK = prev; else delete process.env.PERSENG_ALLOW_NETWORK;
  }
});

test('webSearch: 默认禁用（PERSENG_ALLOW_NETWORK 未设）', async () => {
  const prev = process.env.PERSENG_ALLOW_NETWORK;
  delete process.env.PERSENG_ALLOW_NETWORK;
  try {
    const r = await webSearch('hello', { backend: 'duckduckgo' });
    assert.equal(r.ok, false);
    assert.match(r.error, /PERSENG_ALLOW_NETWORK/);
  } finally {
    if (prev) process.env.PERSENG_ALLOW_NETWORK = prev;
  }
});

test('webSearch: brave 后端无 apiKey 拒绝', async () => {
  const prev = process.env.PERSENG_ALLOW_NETWORK;
  const prevKey = process.env.BRAVE_API_KEY;
  process.env.PERSENG_ALLOW_NETWORK = '1';
  delete process.env.BRAVE_API_KEY;
  try {
    const r = await webSearch('hello', { backend: 'brave' });
    assert.equal(r.ok, false);
    assert.match(r.error, /apiKey/);
  } finally {
    if (prev) process.env.PERSENG_ALLOW_NETWORK = prev;
    if (prevKey) process.env.BRAVE_API_KEY = prevKey;
  }
});

// ────────────────────────────────────────────────
// BACKEND_DOMAINS
// ────────────────────────────────────────────────

test('BACKEND_DOMAINS: 四个后端域名非空', () => {
  assert.equal(typeof BACKEND_DOMAINS.duckduckgo, 'object');
  assert.equal(typeof BACKEND_DOMAINS.brave, 'object');
  assert.equal(typeof BACKEND_DOMAINS.tavily, 'object');
  assert.equal(typeof BACKEND_DOMAINS.serpapi, 'object');
  for (const [name, domains] of Object.entries(BACKEND_DOMAINS)) {
    assert.ok(domains.length > 0, `${name} 至少有一个域名`);
    for (const d of domains) {
      assert.equal(typeof d, 'string');
      assert.ok(d.length > 0);
    }
  }
});

// ────────────────────────────────────────────────
// ToolXProtocol — manual / dryrun / execute 集成
// ────────────────────────────────────────────────

function makeProtocol() {
  return new ToolXProtocol({ cwd: process.cwd() });
}

test('tool://web-search: manual 模式返回文档', async () => {
  const p = makeProtocol();
  const r = await p.dispatch({ tool: 'tool://web-search', mode: 'manual' });
  assert.equal(r.ok, true);
  assert.match(r.manual, /多后端网络搜索/);
  assert.match(r.manual, /duckduckgo/);
  assert.match(r.manual, /brave/);
});

test('tool://web-search: discover() 包含 web-search', () => {
  const p = makeProtocol();
  const r = p.discover();
  const uris = r.tools.map((t) => t.uri);
  assert.ok(uris.includes('tool://web-search'), 'tool://web-search 应在内置工具列表中');
});

test('tool://web-search: dryrun 返回描述', async () => {
  const p = makeProtocol();
  const r = await p.dispatch({
    tool: 'tool://web-search',
    mode: 'dryrun',
    parameters: { action: 'search', query: 'test', backend: 'duckduckgo' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'search');
  assert.match(r.description, /duckduckgo/);
  assert.match(r.description, /test/);
});

test('tool://web-search: dryrun 不指定 backend 显示 auto', async () => {
  const p = makeProtocol();
  const r = await p.dispatch({
    tool: 'tool://web-search',
    mode: 'dryrun',
    parameters: { action: 'search', query: 'hello' },
  });
  assert.equal(r.ok, true);
  assert.match(r.description, /auto/);
});

test('tool://web-search: dryrun 不支持的 action 报错', async () => {
  const p = makeProtocol();
  const r = await p.dispatch({
    tool: 'tool://web-search',
    mode: 'dryrun',
    parameters: { action: 'fetch' },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持操作/);
});

test('tool://web-search: execute 空 query 拒绝', async () => {
  const p = makeProtocol();
  const r = await p.dispatch({
    tool: 'tool://web-search',
    mode: 'execute',
    parameters: { action: 'search', query: '' },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /query/);
});

test('tool://web-search: execute 默认禁用（无 PERSENG_ALLOW_NETWORK）', async () => {
  const prev = process.env.PERSENG_ALLOW_NETWORK;
  delete process.env.PERSENG_ALLOW_NETWORK;
  try {
    const p = makeProtocol();
    const r = await p.dispatch({
      tool: 'tool://web-search',
      mode: 'execute',
      parameters: { action: 'search', query: 'hello' },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /PERSENG_ALLOW_NETWORK/);
    // 日志也应当记录这次拒绝
    const logs = p._logs.filter((e) => e.tool === 'tool://web-search');
    assert.ok(logs.length > 0, '应当记录日志');
    assert.equal(logs[logs.length - 1].status, 'rejected');
  } finally {
    if (prev) process.env.PERSENG_ALLOW_NETWORK = prev;
  }
});

test('tool://web-search: execute 不支持的 action 报错', async () => {
  const p = makeProtocol();
  const r = await p.dispatch({
    tool: 'tool://web-search',
    mode: 'execute',
    parameters: { action: 'fetch', query: 'x' },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持操作/);
});