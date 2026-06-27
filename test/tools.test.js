/**
 * 工具层综合测试
 *
 * 覆盖 TaskEngine 中注册的所有 builtin 工具：
 *   - read_file / write_file / list_dir / grep_search / run_command
 *   - timeline（init/add_milestone/add_task/update_status/show/rollup）
 *   - toolx（discover 模式）
 *
 * 不覆盖：
 *   - route_to_agent（已删除：所有任务都通过内置工具自己完成，不再 spawn 子代理）
 *   - toolx 的 execute/manual 模式（需要 PDF/excel/word 等文件准备，单独测）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskEngine } from '../src/task-engine.js';

function createTempDir(prefix = 'perseng-tools-') {
  return mkdtempSync(join(tmpdir(), prefix));
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
    async tools() { return await engine.getToolRuntime(); },
    restoreEnv() {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

// ════════════════════════════════════════════════════════════════
// read_file
// ════════════════════════════════════════════════════════════════

test('read_file: 读取 cwd 内文件', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'hello.txt'), '你好世界', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('read_file', { path: 'hello.txt' }));
  assert.equal(out, '你好世界');
});

test('read_file: 读取 cwd 内嵌套文件', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'sub'));
  writeFileSync(join(cwd, 'sub', 'deep.txt'), 'deep content', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('read_file', { path: 'sub/deep.txt' }));
  assert.equal(out, 'deep content');
});

test('read_file: 文件不存在返回错误', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('read_file', { path: 'missing.txt' }));
  assert.match(out, /Error reading file/);
});

test('read_file: 默认拒绝逃出 cwd', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('read_file', { path: '../outside.txt' }));
  assert.match(out, /outside the working directory/);
});

test('read_file: PERSENG_ALLOW_PATH_OUTSIDE_CWD=1 允许越界', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd, { PERSENG_ALLOW_PATH_OUTSIDE_CWD: '1' });
  t.after(env.restoreEnv);

  // 指向绝对路径 -> 仍然报错（文件不存在），但不会被路径校验拦
  const out = await env.tools().then((tt) => tt.execute('read_file', { path: 'X:\\nonexistent\\path\\file.txt' }));
  assert.match(out, /Error reading file/);
  assert.doesNotMatch(out, /outside the working directory/);
});

// ════════════════════════════════════════════════════════════════
// write_file
// ════════════════════════════════════════════════════════════════

test('write_file: 写入文件', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const tools = await env.tools();
  const out = await tools.execute('write_file', { path: 'out.txt', content: 'hello' });
  assert.match(out, /File written/);
  assert.equal(readFileSync(join(cwd, 'out.txt'), 'utf-8'), 'hello');
});

test('write_file: 自动创建父目录 (mkdir -p)', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const tools = await env.tools();
  await tools.execute('write_file', {
    path: 'a/b/c/d.txt',
    content: 'nested',
  });
  assert.equal(readFileSync(join(cwd, 'a', 'b', 'c', 'd.txt'), 'utf-8'), 'nested');
});

test('write_file: 默认拒绝越界', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('write_file', {
    path: '../evil.txt', content: 'pwned',
  }));
  assert.match(out, /outside the working directory/);
});

test('write_file: 覆盖已有文件', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'f.txt'), 'old', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const tools = await env.tools();
  await tools.execute('write_file', { path: 'f.txt', content: 'new' });
  assert.equal(readFileSync(join(cwd, 'f.txt'), 'utf-8'), 'new');
});

// ════════════════════════════════════════════════════════════════
// list_dir
// ════════════════════════════════════════════════════════════════

test('list_dir: 列出 cwd（默认 path="."）', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'a.txt'), 'a', 'utf-8');
  writeFileSync(join(cwd, 'b.txt'), 'b', 'utf-8');
  mkdirSync(join(cwd, 'sub'));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('list_dir', {}));
  const lines = out.split('\n');
  assert.ok(lines.some((l) => l.includes('file') && l.includes('a.txt')));
  assert.ok(lines.some((l) => l.includes('file') && l.includes('b.txt')));
  assert.ok(lines.some((l) => l.includes('dir') && l.includes('sub')));
});

test('list_dir: 指定子目录', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'sub'));
  writeFileSync(join(cwd, 'sub', 'x.txt'), 'x', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('list_dir', { path: 'sub' }));
  assert.match(out, /file\s+x\.txt/);
});

test('list_dir: 目录不存在', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('list_dir', { path: 'no-such-dir' }));
  assert.match(out, /Directory not found/);
});

// ════════════════════════════════════════════════════════════════
// grep_search
// ════════════════════════════════════════════════════════════════

test('grep_search: 在 cwd 递归搜索', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'a.js'), 'const needle = 1;\n', 'utf-8');
  writeFileSync(join(cwd, 'src', 'b.js'), 'const other = 2;\n', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('grep_search', {
    pattern: 'needle', glob: '*.js', path: 'src',
  }));
  assert.match(out, /a\.js:1:const needle = 1;/);
  assert.doesNotMatch(out, /b\.js/);
});

test('grep_search: glob ** 递归到子目录', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'deep', 'nested'), { recursive: true });
  writeFileSync(join(cwd, 'deep', 'nested', 'f.txt'), 'hit here', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('grep_search', {
    pattern: 'hit', glob: '**/*.txt', path: '.',
  }));
  assert.match(out, /hit here/);
});

test('grep_search: 无匹配返回 No matches', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'a.txt'), 'no match here', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('grep_search', {
    pattern: 'XYZNOTHING', glob: '*.txt', path: '.',
  }));
  assert.match(out, /No matches found/);
});

test('grep_search: 无效正则返回错误', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('grep_search', {
    pattern: '[invalid', glob: '*', path: '.',
  }));
  assert.match(out, /Invalid search pattern/);
});

test('grep_search: 搜索路径不存在', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('grep_search', {
    pattern: 'foo', glob: '*', path: 'no-such-dir',
  }));
  assert.match(out, /Search path not found/);
});

test('grep_search: 越界路径被拒绝', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('grep_search', {
    pattern: 'root', glob: '*', path: '../../etc',
  }));
  assert.match(out, /outside the working directory/);
});

test('grep_search: 默认上限 100 行匹配', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // 制造 150 个匹配
  const lines = Array.from({ length: 150 }, (_, i) => `match line ${i}`).join('\n');
  writeFileSync(join(cwd, 'big.txt'), lines, 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('grep_search', {
    pattern: 'match', glob: '*.txt', path: '.',
  }));
  const count = out.split('\n').filter(Boolean).length;
  assert.ok(count <= 100, `expected <= 100 matches, got ${count}`);
});

// ════════════════════════════════════════════════════════════════
// run_command（策略相关已测过，这里补 happy-path 与 exit-code）
// ════════════════════════════════════════════════════════════════

test('run_command: echo 输出', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('run_command', { command: 'echo hello' }));
  assert.match(out, /hello/);
});

test('run_command: 非零退出码被报告', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  // 通过脚本文件避开元字符拦截
  writeFileSync(join(cwd, 'fail.js'), 'process.exit(7);\n', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('run_command', { command: 'node fail.js' }));
  assert.match(out, /Exit code 7/);
});

test('run_command: 超时（短 timeout）', async (t) => {
  const cwd = createTempDir();
  writeFileSync(join(cwd, 'wait.js'), 'setTimeout(() => {}, 5000);\n', 'utf-8');

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);
  // 用 try/catch 兜底，子进程被超时杀掉后可能还在 hold 文件句柄
  t.after(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore EBUSY */ }
  });

  const out = await env.tools().then((tt) => tt.execute('run_command', {
    command: 'node wait.js',
    timeout: 500,
  }));
  assert.match(out, /Exit code|timeout|Error/);
});

test('run_command: 不存在的命令返回错误', async (t) => {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const env = makeEngine(cwd);
  t.after(env.restoreEnv);

  const out = await env.tools().then((tt) => tt.execute('run_command', { command: 'no-such-binary-xyz123' }));
  assert.match(out, /Error|Exit code/);
});

// ════════════════════════════════════════════════════════════════
// timeline
// ════════════════════════════════════════════════════════════════

async function freshEngine(t) {
  const cwd = createTempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = makeEngine(cwd);
  t.after(env.restoreEnv);
  return env;
}

test('timeline: init 初始化空时间线', async (t) => {
  const env = await freshEngine(t);
  const out = await env.tools().then((tt) => tt.execute('timeline', { action: 'init', phase_name: 'planning' }));
  assert.match(out, /# 项目时间线 — planning/);
  assert.match(out, /时间线为空/);
});

test('timeline: add_milestone → add_task → update_status → show', async (t) => {
  const env = await freshEngine(t);
  const tools = await env.tools();

  await tools.execute('timeline', { action: 'init', phase_name: 'M0' });
  await tools.execute('timeline', { action: 'add_milestone', milestone: 'M1' });

  // add_task 之前 milestone 还没有 - 测试错误路径
  const errOut = await tools.execute('timeline', {
    action: 'add_task', milestone: 'nope', task: { name: 'x' },
  });
  assert.match(errOut, /milestone "nope" not found/);

  // 正确添加 task
  await tools.execute('timeline', {
    action: 'add_task',
    milestone: 'M1',
    task: { name: '写测试', description: '补测试', assignee: 'dev', estimate: '2h' },
  });

  // update_status
  const updOut = await tools.execute('timeline', {
    action: 'update_status', milestone: 'M1', status: 'in_progress',
  });
  assert.match(updOut, /M1 \[in_progress\]/);

  // show
  const showOut = await tools.execute('timeline', { action: 'show' });
  assert.match(showOut, /M1/);
  assert.match(showOut, /写测试/);
  assert.match(showOut, /@dev/);
});

test('timeline: rollup 汇总', async (t) => {
  const env = await freshEngine(t);
  const tools = await env.tools();

  await tools.execute('timeline', { action: 'init', phase_name: 'demo' });
  await tools.execute('timeline', { action: 'add_milestone', milestone: 'M1' });
  await tools.execute('timeline', { action: 'add_milestone', milestone: 'M2' });
  await tools.execute('timeline', {
    action: 'add_task', milestone: 'M1', task: { name: 't1' },
  });
  await tools.execute('timeline', {
    action: 'add_task', milestone: 'M2', task: { name: 't2' },
  });
  await tools.execute('timeline', {
    action: 'add_task', milestone: 'M2', task: { name: 't3' },
  });

  const out = await tools.execute('timeline', { action: 'rollup' });
  assert.match(out, /里程碑数: 2/);
  assert.match(out, /总任务数: 3/);
});

test('timeline: 未知 action 返回错误', async (t) => {
  const env = await freshEngine(t);
  const out = await env.tools().then((tt) => tt.execute('timeline', { action: 'fly' }));
  assert.match(out, /unknown action "fly"/);
});

test('timeline: add_task 缺 task.name 返回错误', async (t) => {
  const env = await freshEngine(t);
  const tools = await env.tools();
  await tools.execute('timeline', { action: 'add_milestone', milestone: 'M1' });
  const out = await tools.execute('timeline', {
    action: 'add_task', milestone: 'M1', task: { description: 'no name' },
  });
  assert.match(out, /task name is required/);
});

// ════════════════════════════════════════════════════════════════
// toolx (discover 模式即可，不依赖外部文件)
// ════════════════════════════════════════════════════════════════

test('toolx: discover 列出 builtin 工具', async (t) => {
  const env = await freshEngine(t);
  const out = await env.tools().then((tt) => tt.execute('toolx', { mode: 'discover' }));
  assert.match(out, /发现 \d+ 个工具/);
  // 应包含至少一个 builtin
  assert.match(out, /tool:\/\//);
});

test('toolx: 缺 tool 参数返回友好提示', async (t) => {
  const env = await freshEngine(t);
  const out = await env.tools().then((tt) => tt.execute('toolx', { mode: 'manual' }));
  assert.match(out, /请指定 tool 参数/);
});

// ════════════════════════════════════════════════════════════════
// ToolRuntime 自身（注册/取消注册/查询）
// ════════════════════════════════════════════════════════════════

test('ToolRuntime: registerAll 批量注册 + size / listToolNames / get', async (t) => {
  const env = await freshEngine(t);
  // 通过 freshEngine 创建的 engine 在 getToolRuntime() 之前 _toolRuntime 为 null
  // 这里直接拿到 runtime
  const rt = await env.tools();
  // 已有 builtin 工具
  assert.ok(rt.size >= 5, `expected >=5 tools, got ${rt.size}`);
  const names = rt.listToolNames();
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('write_file'));
  assert.ok(names.includes('run_command'));
  assert.ok(names.includes('timeline'));
  assert.ok(names.includes('toolx'));

  // getTool() 返回工具定义
  const t1 = rt.getTool('read_file');
  assert.ok(t1 && t1.execute);
  assert.ok(t1.schema && t1.schema.properties && t1.schema.properties.path);
});

test('ToolRuntime: unregister 移除工具 + execute 抛 TOOL_NOT_FOUND', async (t) => {
  const env = await freshEngine(t);
  const rt = await env.tools();
  rt.register({
    name: 'tmp',
    execute: async () => 'result',
  });
  assert.ok(rt.getTool('tmp') && typeof rt.getTool('tmp').execute === 'function');

  rt.unregister('tmp');
  await assert.rejects(
    () => rt.execute('tmp', {}),
    (err) => {
      assert.match(err.code, /tool_not_found/);
      assert.match(err.userMessage, /未找到/);
      return true;
    },
  );
});

// ─────────────────────────────────────────────────────────────
// 子代理模块移除验证：route_to_agent / getAgentRouter 已彻底下线
// ─────────────────────────────────────────────────────────────

test('TaskEngine: 不再注册 route_to_agent 工具', async (t) => {
  const env = await freshEngine(t);
  const rt = await env.tools();
  const names = rt.listToolNames();
  assert.ok(
    !names.includes('route_to_agent'),
    `route_to_agent 应已被移除，实际工具列表: ${names.join(', ')}`,
  );
});

test('TaskEngine: getAgentRouter() 已删除（导入会抛 TypeError）', async (t) => {
  const env = await freshEngine(t);
  // 调用已删除的方法 → TypeError: env.engine.getAgentRouter is not a function
  assert.equal(typeof env.engine.getAgentRouter, 'undefined');
});

test('TaskEngine: agent-router.js 模块已从磁盘移除', async (t) => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  // __dirname 等价：相对当前测试文件回退到 src/
  const here = fileURLToPath(import.meta.url);
  const srcDir = join(here, '..', '..', 'src');
  assert.equal(
    existsSync(join(srcDir, 'agent-router.js')),
    false,
    'src/agent-router.js 应已被删除',
  );
});
