/**
 * M4.7 测试：LLM retry / fallback
 *
 * 覆盖：
 *   1. classifyError — 各种 HTTP status / error.code / SDK 类型分类
 *   2. computeBackoff — 指数增长、jitter、cap
 *   3. withRetry — 成功无重试 / 重试到成功 / 重试耗尽 / fatal 不重试 / onRetry 回调 / signal 取消
 *   4. metrics counter 累加
 *   5. LlmClient 集成（用 mock provider 替换 _getProvider）
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetCounters, snapshotCounters } from '../src/metrics-registry.js';

const tmpDir = '/tmp/perseng-m47-' + Date.now();

beforeEach(() => {
  resetCounters();
});

// ─── classifyError ─────────────────────────────

test('classifyError: HTTP 429 retryable', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  assert.equal(classifyError({ status: 429 }), 'retryable');
});

test('classifyError: HTTP 5xx retryable', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  for (const s of [500, 502, 503, 504]) {
    assert.equal(classifyError({ status: s }), 'retryable', `status=${s}`);
  }
});

test('classifyError: HTTP 408 retryable', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  assert.equal(classifyError({ status: 408 }), 'retryable');
});

test('classifyError: HTTP 4xx 客户端错误 fatal', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  for (const s of [400, 401, 403, 404, 422]) {
    assert.equal(classifyError({ status: s }), 'fatal', `status=${s}`);
  }
});

test('classifyError: 网络错误 retryable', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']) {
    assert.equal(classifyError({ code }), 'retryable', `code=${code}`);
  }
});

test('classifyError: Anthropic overloaded_error retryable', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  assert.equal(classifyError({ error: { type: 'overloaded_error' } }), 'retryable');
  assert.equal(classifyError({ type: 'api_error' }), 'retryable');
});

test('classifyError: Anthropic auth_error fatal', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  assert.equal(classifyError({ error: { type: 'authentication_error' } }), 'fatal');
  assert.equal(classifyError({ error: { type: 'invalid_request_error' } }), 'fatal');
});

test('classifyError: 流中断消息 retryable', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  assert.equal(classifyError(new Error('Connection closed.')), 'retryable');
  assert.equal(classifyError(new Error('stream ended unexpectedly')), 'retryable');
  assert.equal(classifyError(new Error('socket hang up')), 'retryable');
});

test('classifyError: 用户主动 abort fatal', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  const ctrl = new AbortController();
  ctrl.abort();
  const err = Object.assign(new Error('aborted'), { name: 'AbortError', signal: ctrl.signal });
  assert.equal(classifyError(err), 'fatal');
});

test('classifyError: 未知错误 fatal (fail-fast)', async () => {
  const { classifyError } = await import('../src/llm-retry.js');
  assert.equal(classifyError(new Error('Unknown XYZ')), 'fatal');
  assert.equal(classifyError(null), 'fatal');
});

// ─── computeBackoff ─────────────────────────────

test('computeBackoff: 指数增长 + cap', async () => {
  const { computeBackoff } = await import('../src/llm-retry.js');
  // 不加 jitter 才能精确比对
  const opts = { baseDelayMs: 100, maxDelayMs: 1000, jitter: false };
  assert.equal(computeBackoff(0, opts), 100);
  assert.equal(computeBackoff(1, opts), 200);
  assert.equal(computeBackoff(2, opts), 400);
  assert.equal(computeBackoff(3, opts), 800);
  assert.equal(computeBackoff(4, opts), 1000); // capped
  assert.equal(computeBackoff(10, opts), 1000);
});

test('computeBackoff: jitter 范围合理', async () => {
  const { computeBackoff } = await import('../src/llm-retry.js');
  // attempt=2，base=100，理论 max=400，jitter 在 [0, 400)
  for (let i = 0; i < 50; i++) {
    const d = computeBackoff(2, { baseDelayMs: 100, maxDelayMs: 10000 });
    assert.ok(d >= 0 && d < 400, `jittered delay 越界: ${d}`);
  }
});

// ─── withRetry ─────────────────────────────

test('withRetry: 第一次成功不重试', async () => {
  const { withRetry } = await import('../src/llm-retry.js');
  let calls = 0;
  const r = await withRetry(async () => { calls++; return 'ok'; }, { maxRetries: 3, baseDelayMs: 1 });
  assert.equal(r, 'ok');
  assert.equal(calls, 1);
  const snap = snapshotCounters();
  const attempts = snap.perseng_llm_attempts_total || [];
  const success = attempts.find((e) => e.labels.status === 'success');
  assert.ok(success, '应该记录 success counter');
  assert.equal(success.value, 1);
  const retries = snap.perseng_llm_retries_total || [];
  assert.equal(retries.length, 0, '不应有 retry counter');
});

test('withRetry: 重试 2 次后成功', async () => {
  const { withRetry } = await import('../src/llm-retry.js');
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 });
    return 'recovered';
  }, { maxRetries: 3, baseDelayMs: 1, model: 'm' });
  assert.equal(r, 'recovered');
  assert.equal(calls, 3);
  const snap = snapshotCounters();
  const retries = snap.perseng_llm_retries_total || [];
  assert.equal(retries.length, 1);
  assert.equal(retries[0].value, 2); // 重试 2 次
  const success = (snap.perseng_llm_attempts_total || []).find((e) => e.labels.status === 'success_after_retry');
  assert.ok(success, '应记录 success_after_retry');
});

test('withRetry: retryable 耗尽抛错', async () => {
  const { withRetry } = await import('../src/llm-retry.js');
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw Object.assign(new Error('still failing'), { status: 503 });
    }, { maxRetries: 2, baseDelayMs: 1 }),
    (err) => {
      assert.match(err.message, /failed after 3 attempts/);
      assert.equal(err.attempts, 3);
      assert.ok(err.cause);
      return true;
    }
  );
  assert.equal(calls, 3);
  const snap = snapshotCounters();
  const exhausted = (snap.perseng_llm_attempts_total || []).find((e) => e.labels.status === 'failed_retryable_exhausted');
  assert.ok(exhausted);
});

test('withRetry: fatal 错误不重试', async () => {
  const { withRetry } = await import('../src/llm-retry.js');
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw Object.assign(new Error('bad req'), { status: 400 });
    }, { maxRetries: 3, baseDelayMs: 1 })
  );
  assert.equal(calls, 1, 'fatal 错误应只调用 1 次');
  const snap = snapshotCounters();
  const fatal = (snap.perseng_llm_attempts_total || []).find((e) => e.labels.status === 'failed_fatal');
  assert.ok(fatal);
});

test('withRetry: onRetry 回调触发', async () => {
  const { withRetry } = await import('../src/llm-retry.js');
  const events = [];
  let calls = 0;
  await withRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('boom'), { status: 429 });
    return 'ok';
  }, {
    maxRetries: 3, baseDelayMs: 1, model: 'm',
    onRetry: (info) => events.push({ attempt: info.attempt, delay: info.delayMs, kind: info.errorKind }),
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].kind, 'retryable');
  assert.equal(events[1].attempt, 2);
});

test('withRetry: signal 取消立即中止', async () => {
  const { withRetry } = await import('../src/llm-retry.js');
  const ctrl = new AbortController();
  let calls = 0;
  // 在第一次失败后立即 abort
  const p = withRetry(async () => {
    calls++;
    if (calls === 1) {
      setImmediate(() => ctrl.abort());
      throw Object.assign(new Error('boom'), { status: 503 });
    }
    return 'should not reach';
  }, { maxRetries: 5, baseDelayMs: 100, signal: ctrl.signal });
  await assert.rejects(p, /Aborted|abort/i);
  assert.ok(calls <= 2, 'signal abort 后不应继续调用');
});

test('withRetry: maxRetries=0 等于不重试', async () => {
  const { withRetry } = await import('../src/llm-retry.js');
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw Object.assign(new Error('boom'), { status: 503 });
    }, { maxRetries: 0, baseDelayMs: 1 })
  );
  assert.equal(calls, 1);
});

// ─── LlmClient 集成 ─────────────────────────────

test('LlmClient.streamMessages: 包装 withRetry', async () => {
  // 构造一个 mock provider，streamMessages 头两次抛 503，第三次成功
  let calls = 0;
  const mockProvider = {
    name: 'mock',
    capabilities: { toolUse: true, vision: false, thinking: false },
    streamMessages: async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('503'), { status: 503 });
      return { text: 'ok', toolCalls: [], usage: { input_tokens: 10, output_tokens: 5 } };
    },
    sendToolResults: async () => ({ text: '', toolCalls: [] }),
    translateError: (e) => e,
  };

  const { LlmClient } = await import('../src/llm-client.js');
  // 注入 provider：直接 new，但 monkey-patch _getProvider
  const client = new LlmClient({ apiKey: 'sk-test-mock' });
  client._getProvider = async () => mockProvider;

  // 关掉网络延迟
  process.env.PERSENG_LLM_BASE_DELAY_MS = '1';
  delete process.env.PERSENG_LLM_RETRY;

  const r = await client.streamMessages({ messages: [], system: 's' });
  assert.equal(r.text, 'ok');
  assert.equal(calls, 3, '应重试 2 次后成功');
});

test('LlmClient.streamMessages: PERSENG_LLM_RETRY=0 关闭重试', async () => {
  let calls = 0;
  const mockProvider = {
    name: 'mock',
    capabilities: { toolUse: false, vision: false, thinking: false },
    streamMessages: async () => {
      calls++;
      throw Object.assign(new Error('503'), { status: 503 });
    },
    sendToolResults: async () => ({}),
    translateError: (e) => e,
  };

  const { LlmClient } = await import('../src/llm-client.js');
  const client = new LlmClient({ apiKey: 'sk-test-mock' });
  client._getProvider = async () => mockProvider;

  process.env.PERSENG_LLM_RETRY = '0';
  try {
    await assert.rejects(client.streamMessages({ messages: [], system: 's' }));
    assert.equal(calls, 1, '关闭重试时应只调用 1 次');
  } finally {
    delete process.env.PERSENG_LLM_RETRY;
  }
});