/**
 * doctor.js LLM 可用性 ping 回归测试
 *
 * 覆盖 pingLlmProvider 的所有返回路径：
 *   - 200 → ok:true
 *   - 401 / 403 / 429 / 5xx → ok:false + 明确 reason
 *   - timeout → ok:false
 *   - 无 key → ok:false, reason: 'no-key'
 *   - 默认 apiBase（OpenAI 官方）
 *   - 自定义 apiBase（Moonshot / DeepSeek）
 *   - Anthropic 路径
 *
 * 关键 bug 回归：旧的 doctor 只查 key 长度 > 0 就报 OK，
 * 本测试确保不再发生。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'url';
import { join } from 'path';

// ─── globalThis.fetch mock helper ────────────────────────

let originalFetch;
let mockImpl;

before(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => mockImpl(url, opts);
});

after(() => {
  globalThis.fetch = originalFetch;
});

function setMock(fn) {
  mockImpl = fn;
}

// ─── import 模块（用 cache buster 避免缓存） ────────────

let doctorUrl;
let pingLlmProvider;

before(async () => {
  doctorUrl = pathToFileURL(join(process.cwd(), 'src/commands/doctor.js')).href + `?t=${Date.now()}`;
  const mod = await import(doctorUrl);
  pingLlmProvider = mod.pingLlmProvider;
});

// ─── 实际测试 ──────────────────────────────────────────

test('ping: 无 key 时直接返回 no-key（不发请求）', async () => {
  let called = false;
  setMock(() => { called = true; return new Response('', { status: 200 }); });
  const r = await pingLlmProvider({ anthropicKey: '', openaiKey: '', apiBase: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-key');
  assert.equal(called, false, '无 key 时不应发请求');
});

test('ping: 200 → ok:true（OpenAI 官方）', async () => {
  let calledUrl = null;
  setMock((url) => {
    calledUrl = url;
    return new Response('{"object":"list","data":[]}', { status: 200 });
  });
  const r = await pingLlmProvider({
    openaiKey: 'sk-test', apiBase: 'https://api.openai.com/v1',
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok(calledUrl.endsWith('/v1/models'), `应请求 /v1/models，实际: ${calledUrl}`);
});

test('ping: 自定义 apiBase (Moonshot) 正确拼接 /models', async () => {
  let calledUrl = null;
  setMock((url) => {
    calledUrl = url;
    return new Response('', { status: 200 });
  });
  const r = await pingLlmProvider({
    openaiKey: 'sk-test', apiBase: 'https://api.moonshot.cn/v1',
  });
  assert.equal(r.ok, true);
  assert.equal(calledUrl, 'https://api.moonshot.cn/v1/models');
});

test('ping: apiBase 末尾斜杠被 normalize（避免双斜杠）', async () => {
  let calledUrl = null;
  setMock((url) => {
    calledUrl = url;
    return new Response('', { status: 200 });
  });
  await pingLlmProvider({
    openaiKey: 'sk-test', apiBase: 'https://api.moonshot.cn/v1/',
  });
  assert.equal(calledUrl, 'https://api.moonshot.cn/v1/models', `末尾斜杠未处理: ${calledUrl}`);
});

test('ping: 401 → ok:false + reason 含 unauthorized', async () => {
  setMock(() => new Response('{"error":"invalid_api_key"}', { status: 401 }));
  const r = await pingLlmProvider({ openaiKey: 'sk-bad', apiBase: 'https://api.moonshot.cn/v1' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.reason, /unauthorized.*401/);
});

test('ping: 403 → ok:false + reason 含 forbidden', async () => {
  setMock(() => new Response('', { status: 403 }));
  const r = await pingLlmProvider({ openaiKey: 'sk-test', apiBase: 'https://api.moonshot.cn/v1' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.reason, /forbidden.*403/);
});

test('ping: 429 → ok:false + reason 含 rate-limited', async () => {
  setMock(() => new Response('', { status: 429 }));
  const r = await pingLlmProvider({ openaiKey: 'sk-test', apiBase: 'https://api.moonshot.cn/v1' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.match(r.reason, /rate-limited.*429/);
});

test('ping: 5xx → ok:false + reason 含 server-error', async () => {
  setMock(() => new Response('', { status: 502 }));
  const r = await pingLlmProvider({ openaiKey: 'sk-test', apiBase: 'https://api.moonshot.cn/v1' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.match(r.reason, /server-error/);
});

test('ping: 网络错误（fetch throws）→ ok:false + reason 含 network-error', async () => {
  setMock(() => {
    throw new Error('ECONNREFUSED');
  });
  const r = await pingLlmProvider({ openaiKey: 'sk-test', apiBase: 'https://api.moonshot.cn/v1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /network-error/);
});

test('ping: timeout (AbortError) → reason 含 timeout', async () => {
  setMock((url, opts) => new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  }));
  const r = await pingLlmProvider({ openaiKey: 'sk-test', apiBase: 'https://api.moonshot.cn/v1', timeoutMs: 50 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout/);
});

test('ping: Anthropic 路径用 POST /v1/messages + x-api-key header', async () => {
  let calledUrl = null;
  let calledOpts = null;
  setMock((url, opts) => {
    calledUrl = url;
    calledOpts = opts;
    return new Response('{"content":[{"text":"p"}]}', { status: 200 });
  });
  const r = await pingLlmProvider({ anthropicKey: 'sk-ant-test', apiBase: '' });
  assert.equal(r.ok, true);
  assert.equal(calledUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(calledOpts.method, 'POST');
  assert.equal(calledOpts.headers['x-api-key'], 'sk-ant-test');
  assert.equal(calledOpts.headers['anthropic-version'], '2023-06-01');
});

test('ping: Anthropic 401 → unauthorized reason', async () => {
  setMock(() => new Response('', { status: 401 }));
  const r = await pingLlmProvider({ anthropicKey: 'sk-ant-bad' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.reason, /unauthorized/);
});

test('ping: OpenAI 兼容端点优先于 Anthropic（同时给两个 key 时走 OpenAI，0 token 验证更便宜）', async () => {
  let calledUrl = null;
  setMock((url) => {
    calledUrl = url;
    return new Response('', { status: 200 });
  });
  await pingLlmProvider({ anthropicKey: 'sk-ant-x', openaiKey: 'sk-x', apiBase: 'https://api.moonshot.cn/v1' });
  assert.ok(calledUrl.includes('moonshot.cn'), '应走 OpenAI 兼容端点（更便宜）');
  assert.ok(!calledUrl.includes('anthropic.com'), '不应走 Anthropic 端点');
});

test('ping: 只有 anthropicKey 时走 Anthropic（无 OpenAI 端点）', async () => {
  let calledUrl = null;
  setMock((url) => {
    calledUrl = url;
    return new Response('', { status: 200 });
  });
  await pingLlmProvider({ anthropicKey: 'sk-ant-x', openaiKey: '' });
  assert.ok(calledUrl.includes('anthropic.com'), '无 OpenAI key 时应走 Anthropic');
});
