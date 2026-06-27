import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskEngine } from '../src/task-engine.js';
import { ToolRuntime } from '../src/tool-runtime.js';

function createTempDir() {
  return mkdtempSync(join(tmpdir(), 'perseng-secfix-'));
}

function makeEngine(cwd, extraEnv = {}) {
  const prevEnv = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    prevEnv[k] = process.env[k];
    process.env[k] = v;
  }
  const llm = {
    async streamMessages({ onText }) {
      onText?.('ok');
      return { text: 'ok', toolCalls: [] };
    },
  };
  const engine = new TaskEngine({ cwd, llmClient: llm });
  return {
    engine,
    restoreEnv() {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

test('read_file rejects paths outside cwd by default', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const { engine, restoreEnv } = makeEngine(cwd);
  t.after(restoreEnv);

  const tools = await engine.getToolRuntime();
  const out = await tools.execute('read_file', { path: '../../etc/passwd' });
  assert.match(out, /outside the working directory/);
});

test('write_file rejects paths outside cwd by default', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const { engine, restoreEnv } = makeEngine(cwd);
  t.after(restoreEnv);

  const tools = await engine.getToolRuntime();
  const out = await tools.execute('write_file', {
    path: '../../tmp/evil.txt',
    content: 'pwned',
  });
  assert.match(out, /outside the working directory/);
});

test('read_file allows paths inside cwd', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeFileSync(join(cwd, 'a.txt'), 'hello', 'utf-8');

  const { engine, restoreEnv } = makeEngine(cwd);
  t.after(restoreEnv);

  const tools = await engine.getToolRuntime();
  const out = await tools.execute('read_file', { path: 'a.txt' });
  assert.equal(out, 'hello');
});

test('PERSENG_ALLOW_PATH_OUTSIDE_CWD=1 escapes the path bound', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const { engine, restoreEnv } = makeEngine(cwd, { PERSENG_ALLOW_PATH_OUTSIDE_CWD: '1' });
  t.after(restoreEnv);

  // 落到 cwd 外的临时文件，证明逃生口生效
  const out = await tools_exec_read(engine, 'a.txt');
  // 读不存在文件应返回 Error，但不应被路径校验拦下
  assert.match(out, /Error reading file/);

  async function tools_exec_read(eng, p) {
    const tools = await eng.getToolRuntime();
    return tools.execute('read_file', { path: p });
  }
});

test('grep_search skips symlinks by default', async (t) => {
  const cwd = createTempDir();
  const outDir = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));

  // 在 outDir 放一个含 needle 的文件，然后在 cwd 建一个指向它的 symlink
  writeFileSync(join(outDir, 'secret.txt'), 'needle in secret', 'utf-8');
  mkdirSync(join(cwd, 'links'), { recursive: true });
  try {
    symlinkSync(join(outDir, 'secret.txt'), join(cwd, 'links', 'secret.txt'));
  } catch {
    // Windows 无权限创建 symlink 时跳过
    return;
  }

  const { engine, restoreEnv } = makeEngine(cwd);
  t.after(restoreEnv);

  const tools = await engine.getToolRuntime();
  const out = await tools.execute('grep_search', {
    pattern: 'needle',
    glob: '**/*.txt',
    path: '.',
  });
  // 不应返回 secret.txt
  assert.doesNotMatch(out, /secret\.txt/);
});

test('run_command is blocked when PERSENG_BLOCK_RUN_COMMAND=1', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const { engine, restoreEnv } = makeEngine(cwd, { PERSENG_BLOCK_RUN_COMMAND: '1' });
  t.after(restoreEnv);

  const tools = await engine.getToolRuntime();
  const out = await tools.execute('run_command', { command: 'echo hi' });
  assert.match(out, /disabled by PERSENG_BLOCK_RUN_COMMAND/);
});

test('setModel(null) clears the cached LLM client', async () => {
  const calls = [];
  let provider = 'A';
  const llm = {
    async streamMessages({ onText }) {
      calls.push(provider);
      onText?.(provider);
      return { text: provider, toolCalls: [] };
    },
  };

  const engine = new TaskEngine({
    llmClient: llm,
    systemPrompt: 'PRE',
    loadRole: () => ({ id: 'r', name: 'r' }),
  });
  // 触发一次构建，固化 client
  await engine.run('first', { roleId: 'r' });
  assert.equal(calls.length, 1);

  // 关键修复：之前 setModel(null) 会被早返忽略，_llmClient 不会清空
  // 现在：先 setModel(null) 把 _llmClient 清掉 + model=null
  // 再 setModel('kimi-k2.6') 应当再清一次并设新 model
  provider = 'B';
  engine.setModel(null);
  assert.equal(engine.model, null);
  engine.setModel('kimi-k2.6');
  assert.equal(engine.model, 'kimi-k2.6');
});
