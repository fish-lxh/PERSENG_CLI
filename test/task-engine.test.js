import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskEngine } from '../src/task-engine.js';
import { ToolRuntime } from '../src/tool-runtime.js';

function createTempDir() {
  return mkdtempSync(join(tmpdir(), 'perseng-task-engine-'));
}

test('TaskEngine honors custom system prompts and forwards streamed text', async () => {
  const calls = [];
  const streamed = [];
  const runtime = new ToolRuntime();
  runtime.register({
    name: 'echo_tool',
    description: 'Echoes the provided value',
    schema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
    },
    execute: async ({ value }) => `echo:${value}`,
  });

  const llmClient = {
    async streamMessages(params) {
      calls.push(params);
      if (calls.length === 1) {
        params.onText?.('hello ');
        return {
          text: 'hello ',
          toolCalls: [{ id: 'tool-1', name: 'echo_tool', input: { value: 'world' } }],
        };
      }

      params.onText?.('done');
      return {
        text: 'done',
        toolCalls: [],
      };
    },
  };

  const engine = new TaskEngine({
    llmClient,
    toolRuntime: runtime,
    systemPrompt: 'CUSTOM SYSTEM PROMPT',
    maxToolRounds: 4,
  });

  const result = await engine.run('perform task', {
    instructions: 'Be careful.',
    onText: (chunk) => streamed.push(chunk),
  });

  assert.equal(result, 'hello done');
  assert.deepEqual(streamed, ['hello ', 'done']);
  assert.equal(calls[0].system, 'CUSTOM SYSTEM PROMPT');

  const secondRoundMessages = calls[1].messages;
  assert.ok(
    secondRoundMessages.some(
      (message) => Array.isArray(message.content)
        && message.content.some((item) => item.type === 'tool_use' && item.name === 'echo_tool')
    )
  );
  assert.ok(
    secondRoundMessages.some(
      (message) => Array.isArray(message.content)
        && message.content.some((item) => item.type === 'tool_result' && item.content === 'echo:world')
    )
  );
});

test('TaskEngine builds system prompts when none is provided and grep_search works cross-platform', async (t) => {
  const tempDir = createTempDir();
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  mkdirSync(join(tempDir, 'nested'), { recursive: true });
  writeFileSync(join(tempDir, 'nested', 'alpha.txt'), 'first needle\nsecond line\n', 'utf-8');
  writeFileSync(join(tempDir, 'nested', 'beta.md'), 'needle in markdown\n', 'utf-8');

  let capturedSystem = '';
  const llmClient = {
    async streamMessages(params) {
      capturedSystem = params.system;
      params.onText?.('ok');
      return { text: 'ok', toolCalls: [] };
    },
  };

  const engine = new TaskEngine({
    cwd: tempDir,
    llmClient,
    loadRole: () => ({
      id: 'tester',
      name: 'Test Agent',
      description: 'Used in tests.',
    }),
  });

  const result = await engine.run('inspect files', {
    roleId: 'tester',
    memories: ['previous insight'],
  });

  const tools = await engine.getToolRuntime();
  const grepResult = await tools.execute('grep_search', {
    pattern: 'needle',
    glob: '**/*.txt',
    path: '.',
  });

  assert.equal(result, 'ok');
  assert.match(capturedSystem, /Test Agent/);
  assert.match(capturedSystem, /## 相关记忆/);
  assert.match(capturedSystem, /## 行为约束/);
  assert.match(grepResult, /alpha\.txt:1:first needle/);
  assert.doesNotMatch(grepResult, /beta\.md/);
});
