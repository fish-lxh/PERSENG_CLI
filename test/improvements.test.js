import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

import {
  tokenizeCommand,
  getAllowlist,
  checkCommand,
} from '../src/command-policy.js';
import { buildSafeEnv } from '../src/safe-env.js';
import {
  getCognitionDir,
  getRolexDir,
  resetDataPaths,
} from '../src/data-paths.js';
import { PersengError, ErrorCode, wrap } from '../src/errors.js';

// ─────────────── command-policy ───────────────

test('tokenizeCommand handles quotes and escapes', () => {
  assert.deepEqual(tokenizeCommand('multica issue get "foo bar"'), [
    'multica', 'issue', 'get', 'foo bar',
  ]);
  assert.deepEqual(tokenizeCommand("git log 'a b'"), ['git', 'log', 'a b']);
  assert.deepEqual(tokenizeCommand('echo a\\ b'), ['echo', 'a b']);
});

test('tokenizeCommand throws on unclosed quote', () => {
  assert.throws(() => tokenizeCommand('echo "hi'), /Unclosed quote/);
});

test('checkCommand rejects shell metachars', () => {
  for (const cmd of [
    'multica foo; rm -rf /',
    'ls | grep x',
    'echo $(whoami)',
    'echo `whoami`',
    'foo && bar',
    'foo || bar',
    'foo > /etc/passwd',
    'foo < /etc/passwd',
  ]) {
    const r = checkCommand(cmd);
    assert.equal(r.ok, false, `expected reject for: ${cmd}`);
    assert.match(r.reason, /metacharacter/i);
  }
});

test('checkCommand rejects absolute paths', () => {
  for (const cmd of [
    '/bin/rm -rf /',
  ]) {
    const r = checkCommand(cmd);
    assert.equal(r.ok, false, `expected reject for: ${cmd}`);
    assert.match(r.reason, /absolute path/);
  }
  // Windows-style absolute path on Unix-like shells (no shell metachars in input)
  // 我们用 token 级别检查：'evil.exe' 的第一个 token 形如盘符+冒号
  const winCmd = 'C:/Windows/System32/evil.exe';
  const r2 = checkCommand(winCmd);
  assert.equal(r2.ok, false, `expected reject for: ${winCmd}`);
  assert.match(r2.reason, /absolute path/);
});

test('checkCommand allows bare binary by default (no allowlist)', () => {
  // 未设置 PERSENG_RUN_COMMAND_ALLOWLIST 时，仅做元字符/绝对路径校验
  const r = checkCommand('multica issue get foo');
  assert.equal(r.ok, true);
  assert.equal(r.binary, 'multica');
});

test('checkCommand enforces allowlist when set', (t) => {
  const prev = process.env.PERSENG_RUN_COMMAND_ALLOWLIST;
  process.env.PERSENG_RUN_COMMAND_ALLOWLIST = 'multica,git';
  t.after(() => {
    if (prev === undefined) delete process.env.PERSENG_RUN_COMMAND_ALLOWLIST;
    else process.env.PERSENG_RUN_COMMAND_ALLOWLIST = prev;
  });

  assert.equal(checkCommand('multica foo').ok, true);
  assert.equal(checkCommand('git status').ok, true);
  const r = checkCommand('rm -rf /tmp/x');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in PERSENG_RUN_COMMAND_ALLOWLIST/);
});

test('getAllowlist handles unset / empty / whitespace', () => {
  const prev = process.env.PERSENG_RUN_COMMAND_ALLOWLIST;
  delete process.env.PERSENG_RUN_COMMAND_ALLOWLIST;
  assert.equal(getAllowlist(), null);

  process.env.PERSENG_RUN_COMMAND_ALLOWLIST = '   ';
  assert.equal(getAllowlist(), null);

  process.env.PERSENG_RUN_COMMAND_ALLOWLIST = 'a, b , c';
  assert.deepEqual(getAllowlist(), new Set(['a', 'b', 'c']));

  if (prev === undefined) delete process.env.PERSENG_RUN_COMMAND_ALLOWLIST;
  else process.env.PERSENG_RUN_COMMAND_ALLOWLIST = prev;
});

// ─────────────── safe-env ───────────────

test('buildSafeEnv strips API keys by default', () => {
  const prev = {
    A: process.env.ANTHROPIC_API_KEY,
    O: process.env.OPENAI_API_KEY,
  };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-secret';
  process.env.OPENAI_API_KEY = 'sk-secret';
  process.env.PATH = '/usr/bin';

  const env = buildSafeEnv();
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);

  // 还原
  if (prev.A === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev.A;
  if (prev.O === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev.O;
});

test('buildSafeEnv passes through explicit extra keys', () => {
  const prev = process.env.PERSENG_SPAWN_PASSTHROUGH_KEYS;
  process.env.PERSENG_SPAWN_PASSTHROUGH_KEYS = 'MY_CUSTOM_KEY';
  process.env.MY_CUSTOM_KEY = 'value';
  const env = buildSafeEnv();
  assert.equal(env.MY_CUSTOM_KEY, 'value');

  if (prev === undefined) delete process.env.PERSENG_SPAWN_PASSTHROUGH_KEYS;
  else process.env.PERSENG_SPAWN_PASSTHROUGH_KEYS = prev;
  delete process.env.MY_CUSTOM_KEY;
});

test('buildSafeEnv with includeApiKeys true exposes keys', () => {
  const prevA = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
  const env = buildSafeEnv({ includeApiKeys: true });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-xxx');
  if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevA;
});

// ─────────────── data-paths ───────────────

test('data-paths default to ~/.perseng-cli', () => {
  resetDataPaths();
  const cog = getCognitionDir();
  const rolex = getRolexDir();
  const home = homedir();
  // Windows: cog = 'C:\Users\46649\.perseng-cli\cognition'
  // POSIX:   cog = '/home/x/.perseng-cli/cognition'
  assert.ok(cog.startsWith(home + (cog.includes('\\') ? '\\' : '/')),
    `expected ${cog} to start with ${home}`);
  assert.ok(cog.endsWith('.perseng-cli' + (cog.includes('\\') ? '\\' : '/') + 'cognition'),
    `bad cognition suffix: ${cog}`);
  assert.ok(rolex.endsWith('.perseng-cli' + (rolex.includes('\\') ? '\\' : '/') + 'rolex'),
    `bad rolex suffix: ${rolex}`);
});

test('data-paths respects PERSENG_CLI_COGNITION_DIR override', (t) => {
  const prev = process.env.PERSENG_CLI_COGNITION_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'perseng-cog-override-'));
  t.after(() => {
    if (prev === undefined) delete process.env.PERSENG_CLI_COGNITION_DIR;
    else process.env.PERSENG_CLI_COGNITION_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.PERSENG_CLI_COGNITION_DIR = dir;
  resetDataPaths();
  assert.equal(getCognitionDir(), dir);
});

// ─────────────── errors ───────────────

test('PersengError carries code + userMessage and isUserFacing()', () => {
  const e = new PersengError({
    code: ErrorCode.ROLE_NOT_FOUND,
    message: 'Role "x" not found',
    userMessage: '角色 "x" 未找到',
  });
  assert.equal(e.code, 'role_not_found');
  assert.equal(e.userMessage, '角色 "x" 未找到');
  assert.equal(e.isUserFacing(), true);
  assert.match(e.toString(), /\[role_not_found\]/);
  assert.match(e.toString(), /未找到/);
});

test('PersengError non-user-facing internal errors', () => {
  const e = new PersengError({ code: ErrorCode.INTERNAL, message: 'boom' });
  assert.equal(e.isUserFacing(), false);
});

test('wrap() converts plain Error to PersengError', () => {
  const inner = new Error('disk full');
  const w = wrap(inner, ErrorCode.MEMORY_STORE);
  assert.ok(w instanceof PersengError);
  assert.equal(w.code, 'memory_store');
  assert.equal(w.cause, inner);
});

test('wrap() returns PersengError unchanged', () => {
  const orig = new PersengError({ code: ErrorCode.INTERNAL, message: 'x' });
  assert.equal(wrap(orig), orig);
});

// ─────────────── command-policy end-to-end (via task engine tool) ───────────────

test('TaskEngine run_command rejects commands with metacharacters', async () => {
  const prev = process.env.PERSENG_BLOCK_RUN_COMMAND;
  process.env.PERSENG_BLOCK_RUN_COMMAND = undefined;
  delete process.env.PERSENG_BLOCK_RUN_COMMAND;

  const llm = { async streamMessages({ onText }) { onText?.('ok'); return { text: 'ok', toolCalls: [] }; } };
  const { TaskEngine } = await import('../src/task-engine.js');
  const engine = new TaskEngine({ llmClient: llm });
  const tools = await engine.getToolRuntime();
  const out = await tools.execute('run_command', { command: 'echo hi; rm -rf /' });
  assert.match(out, /metacharacter/i);

  if (prev !== undefined) process.env.PERSENG_BLOCK_RUN_COMMAND = prev;
});

test('TaskEngine run_command enforces allowlist', async () => {
  const prevA = process.env.PERSENG_RUN_COMMAND_ALLOWLIST;
  const prevB = process.env.PERSENG_BLOCK_RUN_COMMAND;
  process.env.PERSENG_RUN_COMMAND_ALLOWLIST = 'echo';
  delete process.env.PERSENG_BLOCK_RUN_COMMAND;

  const llm = { async streamMessages({ onText }) { onText?.('ok'); return { text: 'ok', toolCalls: [] }; } };
  const { TaskEngine } = await import('../src/task-engine.js');
  const engine = new TaskEngine({ llmClient: llm });
  const tools = await engine.getToolRuntime();

  // echo 在白名单
  const okOut = await tools.execute('run_command', { command: 'echo hello' });
  assert.ok(!/rejected by policy/.test(okOut), `expected echo to pass policy: ${okOut}`);

  // rm 不在白名单
  const blockedOut = await tools.execute('run_command', { command: 'rm -rf /tmp/x' });
  assert.match(blockedOut, /not in PERSENG_RUN_COMMAND_ALLOWLIST/);

  if (prevA === undefined) delete process.env.PERSENG_RUN_COMMAND_ALLOWLIST;
  else process.env.PERSENG_RUN_COMMAND_ALLOWLIST = prevA;
  if (prevB !== undefined) process.env.PERSENG_BLOCK_RUN_COMMAND = prevB;
});
