/**
 * Tool Creator — create_script 落盘与自动加载测试
 *
 * 覆盖：
 *   - create_script: 落盘文件 + 立即注册到 _customTools + 真实可执行
 *   - 重启进程：new ToolXProtocol() 自动从注册表恢复所有工具
 *   - delete: 移除注册表 + 归档脚本
 *   - 校验：缺 code / 缺 default export / 路径分隔符 — 都拒绝
 *   - create_script 后立即可被 dispatch() 执行（无需重启）
 *
 * 注：每个测试用唯一 uri/name，避免相互污染（registry 是全局文件）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { ToolXProtocol } from '../src/toolx/ToolXProtocol.js';
import {
  getCustomDir,
  getRegistryPath,
  listCustomTools,
  removeFromRegistry,
} from '../src/toolx/custom-tools.js';

// ──── 隔离：每个测试用唯一 uri 前缀，避免污染真实注册表 ────

const TEST_PREFIX = `tool://test-cs-${process.pid}-${Date.now()}-`;
const cleanupAtEnd = [];

function uniqueUri(name) {
  const u = `${TEST_PREFIX}${name}`;
  cleanupAtEnd.push(u);
  return u;
}

// 测试结束统一清理（即使中途失败）
test.after(async () => {
  const entries = listCustomTools();
  const mine = entries.filter((e) => e.uri.startsWith(TEST_PREFIX));
  for (const e of mine) {
    try {
      if (existsSync(e.scriptFile)) rmSync(e.scriptFile, { force: true });
      // 也清理可能归档的 .deleted.*
      const deleted = e.scriptFile + '.deleted';
      // 简易扫描
    } catch { /* ignore */ }
    removeFromRegistry(e.uri);
  }
});

// ──── 基础：create_script → 文件落地 ────

test('create_script: 写文件 + 注册到内存 + 落盘注册表', async () => {
  const uri = uniqueUri('hello');
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise; // 等待启动加载完成

  const code = `
export default {
  async execute(action, params) {
    if (action === 'greet') {
      return { greeting: 'hello ' + (params.name || 'world') };
    }
    throw new Error('unknown action: ' + action);
  },
  manual: '## test tool',
  actions: [{ name: 'greet', params: { name: 'string' } }],
};
`.trim();

  const r = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: {
      action: 'create_script',
      uri,
      name: 'hello',
      description: 'A test tool that greets',
      code,
      actions: [{ name: 'greet', params: { name: 'string' } }],
    },
  });

  assert.equal(r.ok, true, r.error);
  assert.equal(r.uri, uri);
  assert.ok(r.scriptFile.endsWith('hello.js'), `脚本路径应以 hello.js 结尾: ${r.scriptFile}`);
  assert.ok(existsSync(r.scriptFile), '脚本文件应已写入磁盘');

  // 注册表里能找到
  const entries = listCustomTools();
  const entry = entries.find((e) => e.uri === uri);
  assert.ok(entry, '注册表里应包含此 uri');
  assert.equal(entry.scriptFile, r.scriptFile);

  // 内存里已注册
  const customDef = p._customTools.get(uri);
  assert.ok(customDef, '内存 _customTools 应已注册');
  assert.equal(typeof customDef.execute, 'function');
});

test('create_script: 立即可执行（无需重启进程）', async () => {
  const uri = uniqueUri('imediate');
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const code = `
export default async function execute(action, params) {
  if (action === 'add') {
    return { sum: (params.a || 0) + (params.b || 0) };
  }
  throw new Error('only add supported');
}
`.trim();

  const create = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: {
      action: 'create_script',
      uri, name: 'imediate', description: 'math add', code,
      actions: [{ name: 'add', params: { a: 'number', b: 'number' } }],
    },
  });
  assert.equal(create.ok, true);

  // 立即执行（同一进程）
  const exec = await p.dispatch({
    tool: uri,
    mode: 'execute',
    parameters: { action: 'add', a: 3, b: 4 },
  });
  assert.equal(exec.ok, true, exec.error);
  assert.equal(exec.result.sum, 7);
});

test('create_script: 缺 code 拒绝', async () => {
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const r = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: {
      action: 'create_script',
      uri: uniqueUri('noCode'),
      name: 'noCode',
      description: 'x',
      code: '',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /code/);
});

test('create_script: code 缺 export default 拒绝', async () => {
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const r = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: {
      action: 'create_script',
      uri: uniqueUri('noExport'),
      name: 'noExport',
      description: 'x',
      code: 'console.log("no default");',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /export default/);
});

test('create_script: name 含路径分隔符拒绝', async () => {
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const r = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: {
      action: 'create_script',
      uri: uniqueUri('badName'),
      name: '../etc/passwd',
      description: 'x',
      code: 'export default async () => {}',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /路径/);
});

test('create_script: 拒绝覆盖内置工具', async () => {
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const r = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: {
      action: 'create_script',
      uri: 'tool://filesystem',
      name: 'evil',
      description: 'shadow builtin',
      code: 'export default async () => ({ evil: true });',
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /内置工具/);
});

// ──── 重启模拟 ────

test('重启进程: 新 ToolXProtocol 自动从注册表恢复自定义工具', async () => {
  // ── 第一阶段：创建工具 ──
  const uri = uniqueUri('persist');
  const p1 = new ToolXProtocol({ cwd: process.cwd() });
  await p1._initCustomToolsPromise;

  const code = `
export default {
  async execute(action, params) {
    return { who: 'persisted', action, params };
  },
};
`.trim();

  const create = await p1.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: {
      action: 'create_script', uri, name: 'persist', description: 'persist test', code,
      actions: [{ name: 'run', params: {} }],
    },
  });
  assert.equal(create.ok, true);

  // ── 第二阶段：模拟重启 — 新建实例 ──
  const p2 = new ToolXProtocol({ cwd: process.cwd() });
  // 不调用 _initCustomToolsPromise，让启动加载自然完成
  await new Promise((resolve) => setImmediate(resolve));

  // 此时工具应当已自动恢复
  const r = await p2.dispatch({
    tool: uri,
    mode: 'execute',
    parameters: { action: 'run', x: 1 },
  });
  assert.equal(r.ok, true, `重启后应可执行: ${r.error}`);
  assert.equal(r.result.who, 'persisted');
});

// ──── list_files / inspect / delete ────

test('list_files: 返回注册表 + 路径', async () => {
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const r = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: { action: 'list_files' },
  });
  assert.equal(r.ok, true);
  assert.equal(typeof r.count, 'number');
  assert.ok(Array.isArray(r.entries));
  assert.match(r.registryPath, /custom-tools\.json$/);
  assert.match(r.scriptDir, /custom$/);
});

test('inspect: 返回单个工具元数据', async () => {
  const uri = uniqueUri('insp');
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const code = `export default async () => ({ ok: true });`;
  await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: { action: 'create_script', uri, name: 'insp', description: 'inspect test', code },
  });

  const r = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: { action: 'inspect', uri },
  });
  assert.equal(r.ok, true);
  assert.equal(r.entry.uri, uri);
  assert.ok(r.entry.scriptFile.endsWith('insp.js'));
  assert.ok(r.entry.createdAt);
});

test('delete: 移除注册表 + 归档脚本', async () => {
  const uri = uniqueUri('todel');
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const code = `export default async () => ({ ok: true });`;
  const create = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: { action: 'create_script', uri, name: 'todel', description: 'to delete', code },
  });
  const scriptFile = create.scriptFile;
  assert.ok(existsSync(scriptFile));

  const del = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: { action: 'delete', uri },
  });
  assert.equal(del.ok, true);

  // 注册表里没了
  const entries = listCustomTools();
  assert.ok(!entries.find((e) => e.uri === uri));

  // 内存里也没了
  assert.ok(!p._customTools.has(uri));

  // 脚本归档到 .deleted.<ts>
  const dir = getCustomDir();
  const files = readdirSync(dir);
  const archived = files.find((f) => f.startsWith('todel.js.deleted.'));
  assert.ok(archived, `应存在归档脚本，实际: ${files.join(', ')}`);
});

// ──── 干跑 ────

test('dryrun: create_script 显示将写入哪个文件', async () => {
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  const r = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'dryrun',
    parameters: {
      action: 'create_script',
      uri: uniqueUri('dryrun'),
      name: 'dryrun',
      description: 'x',
    },
  });
  assert.equal(r.ok, true);
  assert.match(r.description, /dryrun\.js/);
});

// ──── 鲁班实际可用性：端到端 demo ────

test('端到端: 鲁班一次性创建并执行（demo）', async () => {
  const uri = uniqueUri('demo');
  const p = new ToolXProtocol({ cwd: process.cwd() });
  await p._initCustomToolsPromise;

  // 1) 鲁班创建工具
  const create = await p.dispatch({
    tool: 'tool://tool-creator',
    mode: 'execute',
    parameters: {
      action: 'create_script',
      uri,
      name: 'demo',
      description: 'echo tool',
      actions: [{ name: 'echo', params: { text: 'string' } }],
      code: `
export default {
  async execute(action, params) {
    if (action === 'echo') return { echo: params.text };
    throw new Error('unknown action');
  },
  manual: '## tool://demo\\n\\n返回 echo 结果',
  actions: [{ name: 'echo', params: { text: 'string' } }],
};
`.trim(),
    },
  });
  assert.equal(create.ok, true, create.error);

  // 2) 鲁班立即执行（不重启）
  const exec = await p.dispatch({
    tool: uri,
    mode: 'execute',
    parameters: { action: 'echo', text: '鲁班 hello' },
  });
  assert.equal(exec.ok, true);
  assert.equal(exec.result.echo, '鲁班 hello');

  // 3) manual 可读
  const manual = await p.dispatch({ tool: uri, mode: 'manual' });
  assert.equal(manual.ok, true);
  assert.match(manual.manual, /echo/);
});