/**
 * startFeishuBot 共享 runner 单元测试
 *
 * 覆盖：
 *   T1 缺 appId / appSecret 抛错
 *   T2 正常 start → adapter 启动 + 返回 stop handle
 *   T3 stop() 取消 inflight 任务 + 关闭 adapter
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { startFeishuBot } from '../src/feishu-bot-runner.js';

function createMockLark() {
  const handlers = new Map();
  const started = [];
  const calls = { create: [], update: [] };
  class MockClient {
    constructor() {
      this.im = {
        message: {
          create: async (args) => {
            calls.create.push(args);
            return { ok: true, args, data: { message_id: `om_${calls.create.length}` } };
          },
          update: async (args) => {
            calls.update.push(args);
            return { ok: true, args };
          },
        },
        messageResource: {
          get: async (args) => ({ ok: true, args, data: Buffer.alloc(10) }),
        },
      };
    }
  }
  class MockWSClient {
    async start({ eventDispatcher }) { started.push(eventDispatcher); }
    async stop() { }
  }
  class MockEventDispatcher {
    register(hs) { for (const [k, v] of Object.entries(hs)) handlers.set(k, v); }
  }
  return {
    lark: { Client: MockClient, WSClient: MockWSClient, EventDispatcher: MockEventDispatcher, LoggerLevel: { info: 1 } },
    trigger: async (name, data) => { const h = handlers.get(name); if (!h) throw new Error(`no handler for ${name}`); return h(data); },
    handlers, started, calls,
  };
}

const noopLogger = { info() { }, warn() { }, error() { } };

// ─── T1: 构造校验 ──────────────────────────────────────

test('T1: 缺 appId 抛错', async () => {
  await assert.rejects(
    () => startFeishuBot({ appSecret: 'x' }),
    /appId and appSecret/,
  );
});

test('T1: 缺 appSecret 抛错', async () => {
  await assert.rejects(
    () => startFeishuBot({ appId: 'x' }),
    /appId and appSecret/,
  );
});

// ─── T2: 正常 start ───────────────────────────────────

test('T2: 正常 start → adapter 启动 + 返回 stop handle', async () => {
  const { lark, started } = createMockLark();
  const handle = await startFeishuBot({
    name: 'test-bot',
    appId: 'a', appSecret: 'b',
    role: 'jiangziya', model: 'claude-sonnet-4-20250514',
    lark,  // 注入 mock
    logger: noopLogger,
  });
  assert.equal(started.length, 1, 'adapter 应启动');
  assert.equal(handle.name, 'test-bot');
  assert.equal(typeof handle.stop, 'function');
  await handle.stop();
});

// ─── T3: stop 清理 ─────────────────────────────────────

test('T3: stop() 关闭 adapter + 解析 done Promise', async () => {
  const { lark } = createMockLark();
  const handle = await startFeishuBot({
    appId: 'a', appSecret: 'b', role: 'jiangziya',
    lark, logger: noopLogger,
  });
  let done = false;
  handle.done.then(() => { done = true; });
  await handle.stop();
  // done 应该在 stop 后 resolve
  await delay(20);
  assert.equal(done, true);
});

test('T4: /role set 后同步重建 session.taskEngine', async () => {
  const { lark, trigger, calls } = createMockLark();
  const handle = await startFeishuBot({
    appId: 'a',
    appSecret: 'b',
    role: 'jiangziya',
    model: 'claude-sonnet-4-20250514',
    roleAdmins: ['u-admin'],
    lark,
    logger: noopLogger,
  });

  try {
    await trigger('im.message.receive_v1', {
      message: {
        message_id: 'm-role',
        message_type: 'text',
        chat_id: 'c-role',
        chat_type: 'p2p',
        content: JSON.stringify({ text: '/role set rotation' }),
      },
      sender: { sender_id: { user_id: 'u-admin' } },
    });

    const session = handle.store.get('c-role');
    assert.ok(session, 'role 切换后应保留会话');
    assert.equal(session.roleId, 'rotation');
    assert.equal(session.taskEngine.roleId, 'rotation');
    assert.match(JSON.parse(calls.create.at(-1).data.content).text, /已切换角色/);
  } finally {
    await handle.stop();
  }
});
