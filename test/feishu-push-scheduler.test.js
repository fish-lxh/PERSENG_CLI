/**
 * FeishuPushScheduler 单元测试
 *
 * 覆盖：
 *   T1 构造校验：缺 jobs / 缺 cron / 缺 chatId / 缺 prompt
 *   T2 cron 解析失败抛错
 *   T3 status() 反映 nextRunAt
 *   T4 fireNow() 调 engine + 发到 chat
 *   T5 start/stop 启停定时器
 *   T6 错误也走 reply（让用户知道）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { FeishuPushScheduler } from '../src/feishu-push-scheduler.js';

// ─── mocks ─────────────────────────────────────────────

function makeMockAdapter() {
  const calls = { create: [], update: [] };
  return {
    calls,
    async start() {},
    async stop() {},
    async replyText(chatId, text) {
      calls.create.push({ chatId, text });
      return { data: { message_id: `om_${calls.create.length}` } };
    },
    async replyTextOrCard(chatId, text) {
      calls.create.push({ chatId, text, type: text.length > 3000 ? 'card' : 'text' });
      return { data: { message_id: `om_${calls.create.length}` } };
    },
  };
}

function makeMockEngine(opts = {}) {
  return {
    async run(task, ctx) {
      if (opts.throwWith) throw opts.throwWith;
      return opts.response || `[engine reply to: ${task}]`;
    },
  };
}

const noopLogger = { info() {}, warn() {}, error() {} };

// ─── T1: 构造校验 ───────────────────────────────────────

test('T1: 缺 adapter 抛错', () => {
  assert.throws(() => new FeishuPushScheduler({ jobs: [], engineFactory: () => ({}) }), /adapter/);
});

test('T1: 缺 engineFactory 抛错', () => {
  assert.throws(() => new FeishuPushScheduler({ jobs: [], adapter: {} }), /engineFactory/);
});

test('T1: job 缺 cron 抛错', () => {
  const adapter = makeMockAdapter();
  assert.throws(
    () => new FeishuPushScheduler({
      jobs: [{ name: 'x', chatId: 'c', prompt: 'p' }],
      adapter, engineFactory: () => ({}),
    }),
    /missing cron/,
  );
});

test('T1: job 缺 chatId 抛错', () => {
  const adapter = makeMockAdapter();
  assert.throws(
    () => new FeishuPushScheduler({
      jobs: [{ name: 'x', cron: '* * * * *', prompt: 'p' }],
      adapter, engineFactory: () => ({}),
    }),
    /missing chatId/,
  );
});

test('T1: job 缺 prompt 抛错', () => {
  const adapter = makeMockAdapter();
  assert.throws(
    () => new FeishuPushScheduler({
      jobs: [{ name: 'x', cron: '* * * * *', chatId: 'c' }],
      adapter, engineFactory: () => ({}),
    }),
    /missing prompt/,
  );
});

// ─── T2: 无效 cron 抛错 ────────────────────────────────

test('T2: 无效 cron 抛错', () => {
  const adapter = makeMockAdapter();
  assert.throws(
    () => new FeishuPushScheduler({
      jobs: [{ name: 'x', cron: 'not-a-cron', chatId: 'c', prompt: 'p' }],
      adapter, engineFactory: () => ({}),
    }),
    /invalid cron/,
  );
});

// ─── T3: status() 返回结构 ─────────────────────────────

test('T3: status() 包含 nextRunAt / 字段', () => {
  const adapter = makeMockAdapter();
  const sch = new FeishuPushScheduler({
    jobs: [{ name: 'morning', cron: '0 9 * * *', chatId: 'oc_xxx', prompt: 'daily', role: 'jiangziya' }],
    adapter, engineFactory: () => ({}),
    logger: noopLogger,
  });
  const status = sch.status();
  assert.equal(status.length, 1);
  assert.equal(status[0].name, 'morning');
  assert.equal(status[0].cron, '0 9 * * *');
  assert.equal(status[0].chatId, 'oc_xxx');
  assert.equal(status[0].role, 'jiangziya');
  assert.ok(status[0].nextRunAt instanceof Date);
});

// ─── T4: fireNow 立即触发 ─────────────────────────────

test('T4: fireNow 调 engine + 发到 chat', async () => {
  const adapter = makeMockAdapter();
  const engine = makeMockEngine({ response: '每日简报内容' });
  const sch = new FeishuPushScheduler({
    jobs: [{ name: 'j1', cron: '0 9 * * *', chatId: 'oc_xxx', prompt: '生成简报' }],
    adapter, engineFactory: () => engine,
    logger: noopLogger,
  });

  await sch.fireNow('j1');

  assert.equal(adapter.calls.create.length, 1);
  assert.equal(adapter.calls.create[0].chatId, 'oc_xxx');
  assert.equal(adapter.calls.create[0].text, '每日简报内容');
  const status = sch.status();
  assert.equal(status[0].lastStatus, 'ok');
});

test('T4: fireNow 抛错时也尝试发错误消息', async () => {
  const adapter = makeMockAdapter();
  const engine = makeMockEngine({ throwWith: new Error('LLM 502') });
  const sch = new FeishuPushScheduler({
    jobs: [{ name: 'j1', cron: '0 9 * * *', chatId: 'oc_xxx', prompt: '生成简报' }],
    adapter, engineFactory: () => engine,
    logger: noopLogger,
  });

  await assert.rejects(() => sch.fireNow('j1'), /LLM 502/);

  // 应有一条错误消息发到 chat
  const errMsg = adapter.calls.create.find((c) => c.text.includes('LLM 502'));
  assert.ok(errMsg, '应有错误消息');
  const status = sch.status();
  assert.equal(status[0].lastStatus, 'error');
  assert.match(status[0].lastError, /LLM 502/);
});

test('T4: fireNow 不存在的 name 抛错', async () => {
  const adapter = makeMockAdapter();
  const sch = new FeishuPushScheduler({
    jobs: [{ name: 'a', cron: '0 9 * * *', chatId: 'c', prompt: 'p' }],
    adapter, engineFactory: () => ({}),
    logger: noopLogger,
  });
  await assert.rejects(() => sch.fireNow('nope'), /not found/);
});

// ─── T5: start / stop ─────────────────────────────────

test('T5: start 启动定时器；stop 清理', async () => {
  const adapter = makeMockAdapter();
  const sch = new FeishuPushScheduler({
    jobs: [],
    adapter, engineFactory: () => ({}),
    logger: noopLogger,
  });
  sch.start();
  assert.equal(sch._running, true);
  assert.ok(sch._timer, '应有 timer');
  await sch.stop();
  assert.equal(sch._running, false);
  assert.equal(sch._timer, null);
});

test('T5: 重复 start 幂等', async () => {
  const adapter = makeMockAdapter();
  const sch = new FeishuPushScheduler({
    jobs: [],
    adapter, engineFactory: () => ({}),
    logger: noopLogger,
  });
  sch.start();
  const t1 = sch._timer;
  sch.start();  // 第二次
  assert.equal(sch._timer, t1, '不应创建新 timer');
  await sch.stop();
});

// ─── T6: 长回复自动走 card ────────────────────────────

test('T6: 长度 > 3000 自动走 messageCard', async () => {
  const adapter = makeMockAdapter();
  const engine = makeMockEngine({ response: 'a'.repeat(4000) });
  const sch = new FeishuPushScheduler({
    jobs: [{ name: 'long', cron: '0 9 * * *', chatId: 'oc_xxx', prompt: 'p' }],
    adapter, engineFactory: () => engine,
    logger: noopLogger,
  });
  await sch.fireNow('long');
  assert.equal(adapter.calls.create[0].type, 'card');
});
