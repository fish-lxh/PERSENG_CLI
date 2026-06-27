/**
 * FeishuAdapter 单元测试
 *
 * 7 个测试覆盖：
 *   T1 私聊 text 消息分发到 handler
 *   T2 群聊无 @ 被忽略
 *   T3 群聊有 @ 时触发且清理 @文本
 *   T4 非 text 消息返回"暂不支持"
 *   T5 replyText 调用 Client.im.message.create
 *   T6 replyText 失败时不抛出导致后续错误
 *   T7 onMessage 未注册就 start() 报错
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, FeishuAdapter } from '../src/feishu-adapter.js';

// ─── 共享 mock lark ─────────────────────────────────────────

function createMockLark() {
  const calls = { create: [], update: [], resource: [], start: [] };
  const handlerRegistry = new Map();

  class MockClient {
    constructor(opts) {
      this.opts = opts;
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
            // 默认返回 1x1 png base64
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
    constructor(opts) {
      this.opts = opts;
    }
    async start({ eventDispatcher }) {
      calls.start.push(eventDispatcher);
      // 把 dispatcher 暴露出去，便于测试触发
      MockWSClient.lastDispatcher = eventDispatcher;
    }
    async stop() {}
  }

  class MockEventDispatcher {
    constructor(opts) { this.opts = opts; }
    register(handlers) {
      for (const [k, v] of Object.entries(handlers)) {
        handlerRegistry.set(k, v);
      }
    }
    static getHandler(name) { return handlerRegistry.get(name); }
  }

  return {
    lark: {
      Client: MockClient,
      WSClient: MockWSClient,
      EventDispatcher: MockEventDispatcher,
      LoggerLevel: { info: 1 },
    },
    calls,
    trigger: async (name, data) => {
      const h = handlerRegistry.get(name);
      if (!h) throw new Error(`no handler for ${name}`);
      return h(data);
    },
  };
}

const noopLogger = { info() {}, warn() {}, error() {} };

// ─── T1: 私聊 text 消息分发 ──────────────────────────────

test('T1: 私聊 text 消息分发到 handler', async () => {
  const { lark, trigger } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });

  const received = [];
  adapter.onMessage(async (msg) => { received.push(msg); });
  await adapter.start();

  await trigger('im.message.receive_v1', {
    message: {
      message_id: 'm1', message_type: 'text', chat_id: 'c1', chat_type: 'p2p',
      content: JSON.stringify({ text: '你好' }),
    },
    sender: { sender_id: { user_id: 'u1' } },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].text, '你好');
  assert.equal(received[0].chatId, 'c1');
  assert.equal(received[0].senderId, 'u1');
  assert.equal(received[0].isGroup, false);
  await adapter.stop();
});

// ─── T2: 群聊无 @ 被忽略 ─────────────────────────────────

test('T2: 群聊无 @ 被忽略', async () => {
  const { lark, trigger } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    botOpenId: 'ou_bot',
  });
  const received = [];
  adapter.onMessage(async (msg) => { received.push(msg); });
  await adapter.start();

  await trigger('im.message.receive_v1', {
    message: {
      message_id: 'm2', message_type: 'text', chat_id: 'g1', chat_type: 'group',
      content: JSON.stringify({ text: '@_user_2 hello' }),
      mentions: [{ key: '@_user_2', id: { open_id: 'ou_other' } }],
    },
    sender: { sender_id: { user_id: 'u2' } },
  });

  assert.equal(received.length, 0, '未 @ 机器人，不应触发');
  await adapter.stop();
});

// ─── T3: 群聊有 @ 时触发且清理文本 ───────────────────────

test('T3: 群聊有 @bot 时触发且清理 @文本', async () => {
  const { lark, trigger } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    botOpenId: 'ou_bot',
  });
  const received = [];
  adapter.onMessage(async (msg) => { received.push(msg); });
  await adapter.start();

  await trigger('im.message.receive_v1', {
    message: {
      message_id: 'm3', message_type: 'text', chat_id: 'g1', chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 hello world' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    },
    sender: { sender_id: { user_id: 'u2' } },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].text, 'hello world');
  assert.equal(received[0].isGroup, true);
  await adapter.stop();
});

// ─── T4: 非 text 消息 → handler 仍被调用（类型在 feishu.js 里检查） ───

test('T4: 非 text 消息也走 parseMessage（handler 内 shouldHandle 决策）', async () => {
  const parsed = parseMessage({
    message: {
      message_id: 'm4', message_type: 'image', chat_id: 'c4', chat_type: 'p2p',
      content: JSON.stringify({ image_key: 'img_xxx' }),
    },
    sender: { sender_id: { user_id: 'u4' } },
  });
  assert.equal(parsed.messageType, 'image');
  assert.equal(parsed.text, '');   // 非 text 给出空字符串
});

// ─── T5: replyText 调用 Client.im.message.create ────────────

test('T5: replyText 调用 Client.im.message.create', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });

  await adapter.replyText('chat-x', '你好');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].params.receive_id_type, 'chat_id');
  assert.equal(calls.create[0].data.receive_id, 'chat-x');
  assert.equal(calls.create[0].data.msg_type, 'text');
  const content = JSON.parse(calls.create[0].data.content);
  assert.equal(content.text, '你好');
});

// ─── T6: parseMessage 边界 ───────────────────────────────

test('T6: parseMessage 处理 null / 缺字段 / 损坏 content', () => {
  assert.equal(parseMessage(null), null);
  assert.equal(parseMessage({}), null);
  assert.equal(parseMessage({ message: {} }), null);  // 缺 sender
  // content 不是合法 JSON
  const r = parseMessage({
    message: {
      message_type: 'text', chat_id: 'c', chat_type: 'p2p', content: 'NOT_JSON',
    },
    sender: { sender_id: { user_id: 'u' } },
  });
  assert.equal(r.text, '');
  assert.equal(r.chatId, 'c');
});

// ─── T7: onMessage 未注册就 start() 报错 ─────────────────

test('T7: 未注册 handler 时 start 抛错', async () => {
  const { lark } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  await assert.rejects(
    () => adapter.start(),
    /must call onMessage/,
  );
});

// ─── Bonus: 构造时校验必填 ───────────────────────────────

test('Bonus: 构造时缺少 appId/appSecret 抛错', () => {
  assert.throws(() => new FeishuAdapter({}), /required/);
  assert.throws(() => new FeishuAdapter({ appId: 'x' }), /required/);
});

// ─── Bonus: replyTextOrCard 长度分流 ─────────────────────

test('Bonus: replyTextOrCard < 3000 字走 replyText', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  await adapter.replyTextOrCard('c', 'short');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].data.msg_type, 'text');
});

test('Bonus: replyTextOrCard > 3000 字截断', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  const long = 'a'.repeat(5000);
  await adapter.replyTextOrCard('c', long);
  // 现在长内容走 card 而不是 text 截断
  assert.equal(calls.create[0].data.msg_type, 'interactive');
});

// ─── Phase 3.1: 流式更新 (updateMessage) ─────────────────────

test('Phase3: replyText 返回 data.message_id', async () => {
  const { lark } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  const resp = await adapter.replyText('c', 'hi');
  assert.ok(resp?.data?.message_id, '应返回 message_id 用于后续 update');
});

test('Phase3: updateMessage 调用 Client.im.message.update', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  await adapter.updateMessage('om_42', '新的内容');
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].path.message_id, 'om_42');
  assert.equal(calls.update[0].data.msg_type, 'text');
  const content = JSON.parse(calls.update[0].data.content);
  assert.equal(content.text, '新的内容');
});

test('Phase3: updateMessage 缺 messageId 抛错', async () => {
  const { lark } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  await assert.rejects(
    () => adapter.updateMessage('', 'hi'),
    /messageId is required/,
  );
});

test('Phase3: updateMessage 接受超长文本（调用方负责截断）', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  const long = 'x'.repeat(10000);
  await adapter.updateMessage('om_1', long);
  // 飞书 SDK 自己做长度校验；adapter 不截断，调用方控制
  assert.equal(calls.update[0].path.message_id, 'om_1');
});

// ─── Phase 4.1: 多模态（image/audio 资源下载） ─────────────────

test('Phase4: getMessageResource 下载 image', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  const buf = await adapter.getMessageResource('om_42', 'image');
  assert.ok(Buffer.isBuffer(buf), '应返回 Buffer');
  assert.ok(buf.length > 0, '应有内容');
  assert.equal(calls.resource.length, 1);
  assert.equal(calls.resource[0].path.message_id, 'om_42');
  assert.equal(calls.resource[0].params.type, 'image');
});

test('Phase4: getMessageResource 缺 messageId 抛错', async () => {
  const { lark } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  await assert.rejects(
    () => adapter.getMessageResource('', 'image'),
    /messageId is required/,
  );
});

test('Phase4: getMessageResource 拒绝非法 type', async () => {
  const { lark } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
  });
  await assert.rejects(
    () => adapter.getMessageResource('om_1', 'video'),
    /invalid type/,
  );
});

// ─── Reply 去重（Phase 5.5：避免 LLM echo 重复发送） ────────────────

test('D1: 完全重复的 replyText 第二次被跳过（返回 null）', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
  });
  const longText = '这是一段用于触发去重的较长文本，需要超过 DEDUP_MIN_LEN 才会被记录到指纹表。';
  const r1 = await adapter.replyText('chat-1', longText);
  const r2 = await adapter.replyText('chat-1', longText);
  assert.ok(r1, '首次发送应返回响应');
  assert.equal(r2, null, '完全重复应返回 null');
  assert.equal(calls.create.length, 1, '飞书 SDK 只应被调用一次');
});

test('D2: 短文本（< 20 字）不去重', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
  });
  await adapter.replyText('chat-1', '好的');
  await adapter.replyText('chat-1', '好的');
  assert.equal(calls.create.length, 2, '短文本应每次都发送');
});

test('D3: 不同 chat 之间不互相同步去重', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
  });
  const longText = '在 chat-1 和 chat-2 都发送相同长文本，去重缓存应分别维护。'.padEnd(50, 'X');
  await adapter.replyText('chat-1', longText);
  await adapter.replyText('chat-2', longText);
  assert.equal(calls.create.length, 2, '不同 chat 的同内容应都发送');
});

test('D4: TTL 过期后重新发送允许', async () => {
  const { lark, calls } = createMockLark();
  // 用极短 TTL（10ms）+ 手动 sleep 验证过期清理
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 10,
  });
  const longText = '用于验证 TTL 过期的较长文本内容，需要超过二十个字符才算指纹。';
  await adapter.replyText('chat-1', longText);
  await new Promise((r) => setTimeout(r, 20));
  await adapter.replyText('chat-1', longText);
  assert.equal(calls.create.length, 2, 'TTL 过期后第二次应正常发送');
});

test('D5: dedupTtlMs=0 完全禁用去重', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 0,
  });
  const longText = '禁用去重后，相同内容连续发送多次都应该正常通过 SDK。';
  await adapter.replyText('chat-1', longText);
  await adapter.replyText('chat-1', longText);
  await adapter.replyText('chat-1', longText);
  assert.equal(calls.create.length, 3);
});

test('D6: clearReplyDedup() 立即清空缓存', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
  });
  const longText = '验证 clearReplyDedup 可以立即清空去重缓存，不论 TTL 是否过期。';
  await adapter.replyText('chat-1', longText);
  adapter.clearReplyDedup();
  await adapter.replyText('chat-1', longText);
  assert.equal(calls.create.length, 2);
});

test('D7: LLM echo 前缀检测：回复以用户消息前缀开头时截掉前缀', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
  });
  // 模拟用户输入并 track
  adapter._trackUserInput('chat-1', '我现在的持仓是国金证券和回盛生物 / 收件箱无新消息。');
  // 模拟 LLM echo：回复前缀复述了用户消息
  const echoReply = '我现在的持仓是国金证券和回盛生物 / 收件箱无新消息。' +
    '\n\n—— 实际分析：今日大盘震荡，国金缩量回调属健康，建议持有。'.padEnd(60, ' ');
  const result = await adapter.replyText('chat-1', echoReply);
  assert.ok(result, '剥掉 echo 后仍有内容时应正常发送');
  // 检查 SDK 收到的 content 已剥掉前缀
  const sentContent = JSON.parse(calls.create[0].data.content);
  assert.ok(
    !sentContent.text.startsWith('我现在的持仓'),
    `剥掉的回复不应以 echo 前缀开头，实际: ${sentContent.text.slice(0, 30)}`,
  );
  assert.match(sentContent.text, /实际分析/);
});

test('D8: echo 剥掉后内容太短（< 20 字）时跳过', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
  });
  adapter._trackUserInput('chat-1', '这是一段较长的用户输入用于触发 echo 检测的最小长度阈值。');
  // echo reply 内容几乎全是复述用户消息
  const echoOnly = '这是一段较长的用户输入用于触发 echo 检测的最小长度阈值。';
  const result = await adapter.replyText('chat-1', echoOnly);
  assert.equal(result, null, '剥掉后几乎为空应跳过');
  assert.equal(calls.create.length, 0);
});

test('D9: enableEchoStrip=false 时不剥 echo', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
    enableEchoStrip: false,
  });
  adapter._trackUserInput('chat-1', '用户输入超过三十字符用于触发 echo 检测的最小长度阈值测试。');
  const echoReply = '用户输入超过三十字符用于触发 echo 检测的最小长度阈值测试。' +
    ' 续写的内容用于让总长度超过最小发送阈值。';
  await adapter.replyText('chat-1', echoReply);
  assert.equal(calls.create.length, 1, '禁用 echo strip 时 echo 仍会发送');
});

test('D10: replyCard 同样应用去重', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
  });
  const longContent = '卡片内容去重验证：这是一段超过二十字符的长内容，会被去重逻辑识别为相同内容。'.padEnd(80, 'X');
  await adapter.replyCard('chat-1', '测试卡', longContent);
  await adapter.replyCard('chat-1', '测试卡', longContent);
  assert.equal(calls.create.length, 1, 'replyCard 完全重复也应被去重');
});

test('D11: replyTextOrCard 同样应用去重', async () => {
  const { lark, calls } = createMockLark();
  const adapter = new FeishuAdapter({
    appId: 'a', appSecret: 'b', lark, logger: noopLogger,
    dedupTtlMs: 60000,
  });
  const longText = 'replyTextOrCard 去重验证：长文本应被检测为重复内容并跳过第二次发送。';
  await adapter.replyTextOrCard('chat-1', longText);
  await adapter.replyTextOrCard('chat-1', longText);
  assert.equal(calls.create.length, 1, 'replyTextOrCard 完全重复也应被去重');
});
