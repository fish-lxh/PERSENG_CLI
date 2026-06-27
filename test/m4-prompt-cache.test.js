/**
 * M4.3 测试：Anthropic prompt caching + usage tracking
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../src/llm-client.js';

// ─── 静态 helper 测试（不调真实 API） ─────────────────────

test('AnthropicProvider: streamMessages requestBody 含 cache_control', async () => {
  const p = new AnthropicProvider({ apiKey: 'test-key' });
  // mock client
  let capturedBody = null;
  p._client = {
    messages: {
      create: async (body) => {
        capturedBody = body;
        return (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 } } };
          yield { type: 'content_block_start', content_block: { type: 'text' } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } };
          yield { type: 'message_delta', usage: { output_tokens: 5 } };
          yield { type: 'message_stop' };
        })();
      },
    },
  };

  await p.streamMessages({
    system: 'You are a helpful assistant',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { name: 't1', description: 'd1', input_schema: { type: 'object' } },
      { name: 't2', description: 'd2', input_schema: { type: 'object' } },
    ],
  });

  assert.ok(capturedBody);
  // system 应是 array 形式，第一个 block 含 cache_control
  assert.ok(Array.isArray(capturedBody.system));
  assert.equal(capturedBody.system[0].type, 'text');
  assert.deepEqual(capturedBody.system[0].cache_control, { type: 'ephemeral' });
  // 最后一个 tool 应有 cache_control
  assert.equal(capturedBody.tools.length, 2);
  assert.deepEqual(capturedBody.tools[1].cache_control, { type: 'ephemeral' });
  assert.equal(capturedBody.tools[0].cache_control, undefined, '非末尾 tool 不应有 cache_control');
});

test('AnthropicProvider: getLastUsage 返回 token 统计', async () => {
  const p = new AnthropicProvider({ apiKey: 'test-key' });
  p._client = {
    messages: {
      create: async () => (async function* () {
        yield { type: 'message_start', message: { usage: { input_tokens: 200, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 } } };
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } };
        yield { type: 'message_delta', usage: { output_tokens: 10 } };
        yield { type: 'message_stop' };
      })(),
    },
  };

  const result = await p.streamMessages({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.ok(result.usage);
  assert.equal(result.usage.input_tokens, 200);
  assert.equal(result.usage.cache_creation_input_tokens, 100);
  assert.equal(result.usage.cache_read_input_tokens, 50);
  assert.equal(result.usage.output_tokens, 10);
  // getLastUsage 返回相同数据
  const last = p.getLastUsage();
  assert.deepEqual(last, result.usage);
});

test('AnthropicProvider: system 为空时不传 system 字段', async () => {
  const p = new AnthropicProvider({ apiKey: 'test-key' });
  let capturedBody = null;
  p._client = {
    messages: {
      create: async (body) => {
        capturedBody = body;
        return (async function* () {
          yield { type: 'message_start', message: { usage: {} } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } };
          yield { type: 'message_stop' };
        })();
      },
    },
  };

  await p.streamMessages({ messages: [{ role: 'user', content: 'hi' }] });
  // system 是 undefined 时不传
  assert.equal(capturedBody.system, undefined);
});

test('AnthropicProvider: 没有 tools 时不传 tools 字段', async () => {
  const p = new AnthropicProvider({ apiKey: 'test-key' });
  let capturedBody = null;
  p._client = {
    messages: {
      create: async (body) => {
        capturedBody = body;
        return (async function* () {
          yield { type: 'message_start', message: { usage: {} } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } };
          yield { type: 'message_stop' };
        })();
      },
    },
  };

  await p.streamMessages({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
  // tools 是空数组时不传
  assert.equal(capturedBody.tools, undefined);
});

test('AnthropicProvider: 单个 tool 也加 cache_control', async () => {
  const p = new AnthropicProvider({ apiKey: 'test-key' });
  let capturedBody = null;
  p._client = {
    messages: {
      create: async (body) => {
        capturedBody = body;
        return (async function* () {
          yield { type: 'message_start', message: { usage: {} } };
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } };
          yield { type: 'message_stop' };
        })();
      },
    },
  };

  await p.streamMessages({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'only', description: 'd', input_schema: { type: 'object' } }],
  });

  assert.equal(capturedBody.tools[0].cache_control?.type, 'ephemeral');
});
