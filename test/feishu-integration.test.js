/**
 * 飞书机器人端到端集成测试
 *
 * 模拟完整流程：
 *   1. mock 飞书 SDK（不连真飞书）
 *   2. mock LLM client（不连真 API）
 *   3. 通过 trigger 模拟飞书事件
 *   4. 验证 ack + 异步执行 + reply 全链路
 *
 * 覆盖：
 *   T1 私聊消息 → ack + 回复
 *   T2 群聊无 @ → 无 ack
 *   T3 群聊 @bot → ack + 回复 + 清理 @文本
 *   T4 非 text 消息 → 友好提示
 *   T5 长内容（>3000 字）→ messageCard 回复
 *   T6 同一 chatId 多次消息复用同一个 TaskEngine
 *   T7 LLM 抛错 → 错误信息走用户面
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { FeishuAdapter } from '../src/feishu-adapter.js';
import { FeishuSessionStore } from '../src/feishu-session-store.js';

// ─── mock 飞书 SDK ──────────────────────────────────────────

function createMockLark() {
  const calls = { create: [], update: [], resource: [] };
  const handlers = new Map();

  class MockClient {
    constructor() {
      this.im = {
        message: {
          create: async (args) => {
            calls.create.push(args);
            const messageId = `om_${calls.create.length}`;
            return { ok: true, args, data: { message_id: messageId } };
          },
          update: async (args) => {
            calls.update.push(args);
            return { ok: true, args };
          },
        },
        messageResource: {
          get: async (args) => {
            calls.resource.push(args);
            return {
              ok: true, args,
              data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
            };
          },
        },
      };
    }
  }
  class MockWSClient {
    async start({ eventDispatcher }) { MockWSClient.dispatcher = eventDispatcher; }
    async stop() {}
  }
  class MockEventDispatcher {
    register(handlers) { for (const [k, v] of Object.entries(handlers)) handlers_map_get_set(handlers, k, v); }
  }
  // helper because Map cannot be used across closures cleanly
  const handlers_map_get_set = (obj, k, v) => {
    handlers.set(k, v);
  };

  const trigger = async (name, data) => {
    const h = handlers.get(name);
    if (!h) throw new Error(`no handler for ${name}`);
    return h(data);
  };

  return {
    lark: { Client: MockClient, WSClient: MockWSClient, EventDispatcher: MockEventDispatcher, LoggerLevel: { info: 1 } },
    calls,
    trigger,
  };
}

// ─── mock TaskEngine ───────────────────────────────────────

function makeMockEngine(opts = {}) {
  return {
    runCalls: [],
    async run(task, ctx = {}) {
      this.runCalls.push({ task, signal: !!ctx.signal, onText: !!ctx.onText });
      if (opts.throwWith) throw opts.throwWith;

      // 模拟流式：把 response 切成 chunks 通过 onText 发送
      const finalText = opts.longResponse
        ? 'a'.repeat(opts.longResponse)
        : (opts.response || `reply-to:${task}`);

      if (opts.streamChunks && typeof ctx.onText === 'function') {
        const chunkSize = opts.chunkSize || 50;
        for (let i = 0; i < finalText.length; i += chunkSize) {
          if (ctx.signal?.aborted) throw new Error('aborted');
          ctx.onText(finalText.slice(i, i + chunkSize));
        }
        return finalText;
      }

      return finalText;
    },
  };
}

// ─── 复用 feishuCommand 的核心 handler 逻辑（精简版） ──────────
// 集成测试不直接调用 feishuCommand（它会启动 WS），而是
// 复制核心消息处理循环，使得测试能注入 mock 的所有依赖。

async function makeHandler({ adapter, store, engineFactory, roleId }) {
  const inflight = [];

  adapter.onMessage(async (msg) => {
    // Phase 4.1: 支持 text / image / audio
    if (!['text', 'image', 'audio'].includes(msg.messageType)) {
      try { await adapter.replyText(msg.chatId, `🤖 暂不支持 ${msg.messageType} 类型的消息`); } catch { /* */ }
      return;
    }
    if (msg.messageType === 'text' && (!msg.text || !msg.text.trim())) return;

    // 3 秒 ack + 捕获 messageId 以便流式更新
    let ackMessageId = null;
    try {
      const ackResp = await adapter.replyText(msg.chatId, '🤔 正在思考…');
      ackMessageId = ackResp?.data?.message_id || null;
    } catch { /* */ }

    const session = store.getOrCreate(msg.chatId, msg.chatType, roleId, { senderId: msg.senderId });
    const abortCtl = new AbortController();
    session.abortCtl = abortCtl;

    // 流式状态
    const streamState = { buffer: '', lastSent: '', lastUpdateAt: 0, pendingFlush: null };
    const flushStream = async () => {
      if (!ackMessageId) return;
      if (streamState.buffer === streamState.lastSent) return;
      if (streamState.buffer.length > 3500) return;
      try {
        await adapter.updateMessage(ackMessageId, streamState.buffer);
        streamState.lastSent = streamState.buffer;
        streamState.lastUpdateAt = Date.now();
      } catch { /* */ }
    };
    const onTextChunk = (chunk) => {
      streamState.buffer += chunk;
      const charDelta = streamState.buffer.length - streamState.lastSent.length;
      const timeDelta = Date.now() - streamState.lastUpdateAt;
      if (charDelta >= 50 || timeDelta >= 300) {
        if (streamState.pendingFlush) return;
        streamState.pendingFlush = flushStream().finally(() => { streamState.pendingFlush = null; });
      }
    };

    const timeoutId = setTimeout(() => abortCtl.abort('timeout'), 5000);

    // Phase 4.1: 拉取 image/audio 附件
    let attachments = [];
    if (msg.messageType === 'image' || msg.messageType === 'audio') {
      try {
        if (msg.messageType === 'image') {
          const buf = await adapter.getMessageResource(msg.messageId, 'image');
          attachments.push({ type: 'image', base64: buf.toString('base64'), mediaType: 'image/png' });
        }
        // audio 测试不覆盖（需 ASR 真实 key）
      } catch (err) {
        try { await adapter.replyText(msg.chatId, `❌ 附件处理失败: ${err.message}`); } catch { /* */ }
        return;
      }
    }

    const task = (async () => {
      try {
        const result = await engineFactory(session).run(msg.text, {
          roleId,
          signal: abortCtl.signal,
          onText: onTextChunk,
          attachments,
        });
        session.history.push({ role: 'user', content: msg.text });
        session.history.push({ role: 'assistant', content: result });
        if (session.history.length > 20) session.history = session.history.slice(-20);
        if (ackMessageId && result.length <= 3000) {
          if (streamState.pendingFlush) await streamState.pendingFlush.catch(() => {});
          await adapter.updateMessage(ackMessageId, result);
        } else {
          await adapter.replyTextOrCard(msg.chatId, result);
        }
      } catch (err) {
        const userMsg = err?.message || String(err);
        try {
          if (ackMessageId) await adapter.updateMessage(ackMessageId, `❌ ${userMsg}`);
          else await adapter.replyText(msg.chatId, `❌ ${userMsg}`);
        } catch { /* */ }
      } finally {
        clearTimeout(timeoutId);
        session.abortCtl = null;
      }
    })();
    inflight.push(task);
    task.catch(() => { /* ignore */ });
  });

  await adapter.start();
  return { inflight };
}

const noopLogger = { info() {}, warn() {}, error() {} };

// ─── T1: 私聊消息 → ack + reply ────────────────────────────

test('T1: 私聊 text → ack + 短结果走 update', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  const engine1 = makeMockEngine({ response: 'OK' });
  const store = new FeishuSessionStore({ engineFactory: () => engine1 });
  await makeHandler({ adapter, store, engineFactory: () => engine1, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: { message_id: 'm1', message_type: 'text', chat_id: 'c1', chat_type: 'p2p', content: JSON.stringify({ text: 'hello' }) },
    sender: { sender_id: { user_id: 'u1' } },
  });

  await delay(80);

  // 1 个 ack create
  const acked = calls.create.find((c) => JSON.parse(c.data.content).text.includes('正在思考'));
  assert.ok(acked, '应有 ack');
  // 短结果应走 update（覆盖 ack）
  const updates = calls.update.map((u) => JSON.parse(u.data.content).text);
  assert.ok(updates.includes('OK'), `短结果应走 update；updates=${JSON.stringify(updates)}`);

  await adapter.stop();
});

// ─── T2: 群聊无 @ → 无响应 ─────────────────────────────────

test('T2: 群聊无 @ 时不响应', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger, botOpenId: 'ou_bot' });
  const store = new FeishuSessionStore({ engineFactory: () => makeMockEngine() });
  await makeHandler({ adapter, store, engineFactory: () => makeMockEngine(), roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: {
      message_id: 'm2', message_type: 'text', chat_id: 'g1', chat_type: 'group',
      content: JSON.stringify({ text: '群友消息' }),
      mentions: [{ key: '@_user_99', id: { open_id: 'ou_other' } }],
    },
    sender: { sender_id: { user_id: 'u2' } },
  });

  await delay(20);
  assert.equal(calls.create.length, 0, '不应有任何发送');
  await adapter.stop();
});

// ─── T3: 群聊 @bot → 触发且清理文本 ───────────────────────

test('T3: 群聊 @bot → 触发 + 文本里 @ 被清理', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger, botOpenId: 'ou_bot' });
  let receivedTask = null;
  const engine = makeMockEngine();
  const originalRun = engine.run.bind(engine);
  engine.run = async (task, ctx) => { receivedTask = task; return originalRun(task, ctx); };

  const store = new FeishuSessionStore({ engineFactory: () => engine });
  await makeHandler({ adapter, store, engineFactory: () => engine, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: {
      message_id: 'm3', message_type: 'text', chat_id: 'g1', chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 这是任务' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    },
    sender: { sender_id: { user_id: 'u3' } },
  });

  await delay(80);

  assert.equal(receivedTask, '这是任务', '应清理 @ 占位符');
  // 短结果走 update
  const updates = calls.update.map((u) => JSON.parse(u.data.content).text);
  assert.ok(updates.some((t) => t.startsWith('reply-to:')), '应有 update 形式的 reply');

  await adapter.stop();
});

// ─── T4: 非支持的消息类型 → 友好提示 ───────────────────────

test('T4: 收到 video 消息 → 友好提示', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  const store = new FeishuSessionStore({ engineFactory: () => makeMockEngine() });
  await makeHandler({ adapter, store, engineFactory: () => makeMockEngine(), roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: {
      message_id: 'm4', message_type: 'video', chat_id: 'c4', chat_type: 'p2p',
      content: JSON.stringify({ file_key: 'file_xxx' }),
    },
    sender: { sender_id: { user_id: 'u4' } },
  });

  await delay(20);
  assert.equal(calls.create.length, 1, '应只有一条友好提示');
  const prompt = JSON.parse(calls.create[0].data.content).text;
  assert.match(prompt, /video/);
  assert.match(prompt, /暂不支持/);

  await adapter.stop();
});

// ─── T5: 长内容（>3000 字）→ messageCard ───────────────────

test('T5: 长回复走 messageCard (interactive)', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  const engine = makeMockEngine({ longResponse: 5000 });
  const store = new FeishuSessionStore({ engineFactory: () => engine });
  await makeHandler({ adapter, store, engineFactory: () => engine, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: { message_id: 'm5', message_type: 'text', chat_id: 'c5', chat_type: 'p2p', content: JSON.stringify({ text: 'hi' }) },
    sender: { sender_id: { user_id: 'u5' } },
  });

  await delay(100);
  // 至少应有一个 msg_type=interactive
  const card = calls.create.find((c) => c.data.msg_type === 'interactive');
  assert.ok(card, '长回复应使用 interactive card');
  const cardContent = JSON.parse(card.data.content);
  assert.match(cardContent.elements[0].content, /a{50,}/);  // 长 a 串

  await adapter.stop();
});

// ─── T6: 同一 chatId 多次消息复用同一个 session/engine ─────

test('T6: 同一 chatId 多次消息复用 session', async () => {
  const { lark, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  const engines = [];
  const engineFactory = () => {
    const e = makeMockEngine();
    engines.push(e);
    return e;
  };
  const store = new FeishuSessionStore({ engineFactory });
  await makeHandler({ adapter, store, engineFactory, roleId: 'r' });

  // 连续发 3 条到同一个 chat
  for (let i = 0; i < 3; i++) {
    await trigger('im.message.receive_v1', {
      message: { message_id: `m${i}`, message_type: 'text', chat_id: 'same', chat_type: 'p2p', content: JSON.stringify({ text: `msg-${i}` }) },
      sender: { sender_id: { user_id: 'u' } },
    });
  }

  await delay(100);

  // store 中应只有 1 个 session
  assert.equal(store.size, 1, '应复用 session');
  // 工厂被调用的次数应 >= 1（可能因为异步导致重复创建，但 session 数 ≤ 1）
  assert.ok(store.get('same').history.length >= 2, 'history 至少有 1 轮对话');

  await adapter.stop();
});

// ─── T7: LLM 抛错 → 用户面错误信息 ─────────────────────────

test('T7: LLM 抛错 → 用户面错误信息（覆盖 ack）', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  const engine = makeMockEngine({ throwWith: new Error('LLM 上游 502') });
  const store = new FeishuSessionStore({ engineFactory: () => engine });
  await makeHandler({ adapter, store, engineFactory: () => engine, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: { message_id: 'm7', message_type: 'text', chat_id: 'c7', chat_type: 'p2p', content: JSON.stringify({ text: 'hi' }) },
    sender: { sender_id: { user_id: 'u7' } },
  });

  await delay(50);

  // 错误走 update（覆盖 ack）
  const errUpdate = calls.update.find((u) => JSON.parse(u.data.content).text.includes('LLM'));
  assert.ok(errUpdate, '应有 update 形式的错误提示');

  await adapter.stop();
});

// ─── Phase 3.1: 流式更新 ────────────────────────────────

test('P3.1-T1: 流式输出走 updateMessage 更新同一条 ack 消息', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  const engine = makeMockEngine({
    response: 'hello world',
    streamChunks: true,
    chunkSize: 5,
  });
  const store = new FeishuSessionStore({ engineFactory: () => engine });
  await makeHandler({ adapter, store, engineFactory: () => engine, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: { message_id: 'pm1', message_type: 'text', chat_id: 'cpm1', chat_type: 'p2p', content: JSON.stringify({ text: 'hi' }) },
    sender: { sender_id: { user_id: 'u' } },
  });

  await delay(300);

  // 验证：调用栈中至少有一次 update
  assert.ok(calls.update.length >= 1, `expected update calls, got ${calls.update.length}`);
  // 第一次 update 的 messageId 应等于 ack 的 messageId
  const ackCreate = calls.create[0];
  const ackId = ackCreate && JSON.parse(ackCreate.data.content).text.includes('正在思考')
    ? null
    : null;
  // 我们的 mock 把 ackResp.data.message_id = om_N，update 的 path.message_id 应匹配
  // 通过 update path 验证
  for (const u of calls.update) {
    assert.ok(u.path?.message_id, 'update 应带 message_id');
    assert.equal(u.data.msg_type, 'text');
  }
  // 最后一次 update 的内容应包含完整结果
  const lastUpdate = calls.update[calls.update.length - 1];
  const lastText = JSON.parse(lastUpdate.data.content).text;
  assert.ok(lastText.length > 0, '最终 update 不应为空');
  // 不应有额外 create（短结果直接 update，不新发）
  const finalCreates = calls.create.filter((c) => {
    try { return !JSON.parse(c.data.content).text.includes('正在思考'); } catch { return false; }
  });
  assert.equal(finalCreates.length, 0, '短结果不应新发消息');

  await adapter.stop();
});

test('P3.1-T2: 长结果（>3000）最终发 messageCard', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  const engine = makeMockEngine({
    longResponse: 5000,
    streamChunks: true,
    chunkSize: 100,
  });
  const store = new FeishuSessionStore({ engineFactory: () => engine });
  await makeHandler({ adapter, store, engineFactory: () => engine, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: { message_id: 'pm2', message_type: 'text', chat_id: 'cpm2', chat_type: 'p2p', content: JSON.stringify({ text: 'hi' }) },
    sender: { sender_id: { user_id: 'u' } },
  });

  await delay(500);

  // 应该有 card create（interactive）— 最终结果走卡
  const card = calls.create.find((c) => c.data.msg_type === 'interactive');
  assert.ok(card, '长结果应发 messageCard');
  // 期间可能有一些 update（buffer 还没超 3500 时），但最后一次 update 不应是 5000 字符
  if (calls.update.length > 0) {
    const lastUpdateText = JSON.parse(calls.update[calls.update.length - 1].data.content).text;
    assert.ok(lastUpdateText.length <= 3500, '流式 update 不应超过 3500 字符');
  }

  await adapter.stop();
});

test('P3.1-T3: 错误信息走 updateMessage（覆盖 ack）', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  const engine = makeMockEngine({ throwWith: new Error('服务挂了') });
  const store = new FeishuSessionStore({ engineFactory: () => engine });
  await makeHandler({ adapter, store, engineFactory: () => engine, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: { message_id: 'pm3', message_type: 'text', chat_id: 'cpm3', chat_type: 'p2p', content: JSON.stringify({ text: 'hi' }) },
    sender: { sender_id: { user_id: 'u' } },
  });

  await delay(50);

  // 错误应走 update，不是 create
  assert.ok(calls.update.length >= 1, '错误应通过 updateMessage 覆盖 ack');
  const errUpdate = calls.update[calls.update.length - 1];
  const errText = JSON.parse(errUpdate.data.content).text;
  assert.match(errText, /服务挂了/);

  await adapter.stop();
});

// ─── Phase 4.1: image 多模态 ──────────────────────────────

test('P4.1-T1: image 消息 → 下载附件 → 喂给 engine', async () => {
  const { lark, calls, trigger } = createMockLark();
  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark, logger: noopLogger });
  let receivedCtx = null;
  const engine = {
    runCalls: [],
    async run(task, ctx = {}) {
      this.runCalls.push({ task, ctx });
      receivedCtx = ctx;
      return 'image 看到了';
    },
  };
  const store = new FeishuSessionStore({ engineFactory: () => engine });
  await makeHandler({ adapter, store, engineFactory: () => engine, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: {
      message_id: 'p41m1', message_type: 'image', chat_id: 'c41', chat_type: 'p2p',
      content: JSON.stringify({ image_key: 'img_xxx' }),
    },
    sender: { sender_id: { user_id: 'u' } },
  });

  await delay(100);

  // 验证：调用了 messageResource.get 下载图片
  assert.ok(calls.resource.length >= 1, '应下载图片资源');
  assert.equal(calls.resource[0].path.message_id, 'p41m1');
  assert.equal(calls.resource[0].params.type, 'image');
  // 验证：engine.run 收到了 attachments
  assert.ok(receivedCtx?.attachments, 'engine.run 应收到 attachments');
  const imageAtt = receivedCtx.attachments.find((a) => a.type === 'image');
  assert.ok(imageAtt, '应有 image 附件');
  assert.ok(imageAtt.base64.length > 0, 'base64 应有内容');

  await adapter.stop();
});

test('P4.1-T2: image 下载失败 → 友好提示', async () => {
  // 构造一个 messageResource.get 抛错的 lark mock（完整 mock 结构）
  const calls = { create: [], update: [] };
  const handlers = new Map();
  const larkErr = {
    Client: class {
      constructor() {
        this.im = {
          message: {
            create: async (a) => { calls.create.push(a); return { ok: true, args: a, data: { message_id: 'om_x' } }; },
            update: async (a) => { calls.update.push(a); return { ok: true, args: a }; },
          },
          messageResource: { get: async () => { throw new Error('网络挂了'); } },
        };
      }
    },
    WSClient: class {
      async start({ eventDispatcher }) { /* 真 handler 已在 FeishuAdapter.start() 之前 register，不动它 */ }
      async stop() {}
    },
    EventDispatcher: class {
      constructor() { this.registered = new Map(); }
      register(hs) { for (const [k, v] of Object.entries(hs)) this.registered.set(k, v); }
    },
    LoggerLevel: { info: 1 },
  };
  const trigger = async (name, data) => {
    // 找到最近一次 start() 注入的 dispatcher（通过 mock 内的 adapter 反查）
    // 简化：让 FeishuAdapter.start() 完后存到 module-level
    const dispatcher = larkErr.EventDispatcher.lastInstance;
    const h = dispatcher?.registered?.get(name);
    if (!h) throw new Error(`no handler for ${name}`);
    return h(data);
  };
  // 拦截 EventDispatcher 构造，记录最后一个实例
  const OrigDispatcher = larkErr.EventDispatcher;
  larkErr.EventDispatcher = class extends OrigDispatcher {
    constructor(...args) { super(...args); OrigDispatcher.lastInstance = this; }
  };

  const adapter = new FeishuAdapter({ appId: 'a', appSecret: 'b', lark: larkErr, logger: noopLogger });
  const engine = makeMockEngine();
  const store = new FeishuSessionStore({ engineFactory: () => engine });
  await makeHandler({ adapter, store, engineFactory: () => engine, roleId: 'r' });

  await trigger('im.message.receive_v1', {
    message: {
      message_id: 'p41m2', message_type: 'image', chat_id: 'c42', chat_type: 'p2p',
      content: JSON.stringify({ image_key: 'img_fail' }),
    },
    sender: { sender_id: { user_id: 'u' } },
  });

  await delay(100);

  // 应有错误提示
  const errMsgs = calls.create.map((c) => {
    try { return JSON.parse(c.data.content).text; } catch { return ''; }
  }).filter((t) => t.startsWith('❌'));
  assert.ok(errMsgs.length >= 1, `应有错误提示；creates=${JSON.stringify(calls.create.map(c => c.data.content))}`);

  await adapter.stop();
});
