import test from 'node:test';
import assert from 'node:assert/strict';

import { ToolRuntime } from '../src/tool-runtime.js';

test('ToolRuntime registers tools and exposes Anthropic-style definitions', () => {
  const runtime = new ToolRuntime();
  runtime.register({
    name: 'sum',
    description: 'Adds numbers',
    schema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    execute: ({ a, b }) => a + b,
  });

  assert.equal(runtime.size, 1);
  assert.deepEqual(runtime.listToolNames(), ['sum']);
  assert.deepEqual(runtime.getToolDefinitions(), [
    {
      name: 'sum',
      description: 'Adds numbers',
      input_schema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
  ]);
});

test('ToolRuntime executes tools and normalizes object output', async () => {
  const runtime = new ToolRuntime();
  runtime.register({
    name: 'inspect',
    execute: async () => ({ ok: true }),
  });

  const output = await runtime.execute('inspect');
  assert.equal(output, '{\n  "ok": true\n}');
});

test('ToolRuntime reports missing tools and wrapped execution failures', async () => {
  const runtime = new ToolRuntime();
  runtime.register({
    name: 'explode',
    execute: () => {
      throw new Error('boom');
    },
  });

  await assert.rejects(() => runtime.execute('missing'), /未找到/);
  await assert.rejects(() => runtime.execute('explode'), /执行失败: boom/);
});
