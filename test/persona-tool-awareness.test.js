/**
 * Persona 工具感知测试（修复"记忆模块遗漏新工具"）
 *
 * 验证：
 *   1. system prompt 自动包含 builtin 工具（含 tool://web-search）
 *   2. persona 的静态 knowledge 不会影响工具目录
 *   3. 动态创建的 custom tool 也被注入
 *   4. 提示词明确要求"以工具目录为准，不要凭印象"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resetDataPaths } from '../src/data-paths.js';
import { resetBlackboard, closeBlackboard } from '../src/blackboard-store.js';
import {
  buildSystemPrompt,
  discoverAvailableTools,
  discoverAvailableToolsAsync,
  resetToolsCache,
} from '../src/prompt-builder.js';
import { ToolXProtocol } from '../src/toolx/ToolXProtocol.js';
import { removeFromRegistry } from '../src/toolx/custom-tools.js';

function setupTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'perseng-prompt-'));
  process.env.PERSENG_CLI_BLACKBOARD_DIR = dir;
  resetDataPaths();
  resetBlackboard();
  resetToolsCache();
  return dir;
}

async function setupTempDirAsync() {
  const dir = setupTempDir();
  await discoverAvailableToolsAsync(); // 预热缓存
  return dir;
}

function teardown(dir) {
  closeBlackboard();
  delete process.env.PERSENG_CLI_BLACKBOARD_DIR;
  resetDataPaths();
  resetToolsCache();
  rmSync(dir, { recursive: true, force: true });
}

const fakeJiangziyaRole = {
  id: 'jiangziya',
  name: '姜子牙',
  description: '战略领导代理',
  // 注意：knowledge 故意不写任何工具，让测试更能体现自动注入的价值
  knowledge: [
    '战略分析方法论',
    '五层递进思考',
  ],
  principles: [
    { id: 'test-principle', name: '测试原则', content: '测试原则内容' },
  ],
};

// ──── 1. builtin 工具自动注入 ────

test('system prompt 自动包含 builtin 工具（含 tool://web-search）', async () => {
  const dir = await setupTempDirAsync();
  try {
    const prompt = buildSystemPrompt(fakeJiangziyaRole, { roleId: 'jiangziya' });

    // 验证目录标题
    assert.match(prompt, /当前可用工具/);

    // 关键：包含 tool://web-search（用户创建的）
    assert.match(prompt, /tool:\/\/web-search/, '应自动注入 tool://web-search');

    // 包含 builtin 工具
    assert.match(prompt, /tool:\/\/filesystem/);
    assert.match(prompt, /tool:\/\/pdf-reader/);
    assert.match(prompt, /tool:\/\/tool-creator/, '应包含 tool://tool-creator（鲁班）');
  } finally {
    teardown(dir);
  }
});

test('prompt 明确要求"以工具目录为准，不要凭印象"', async () => {
  const dir = await setupTempDirAsync();
  try {
    const prompt = buildSystemPrompt(fakeJiangziyaRole, { roleId: 'jiangziya' });

    // 行为约束中的关键句（允许跨行：使用 [\s\S] 而不是 .）
    assert.match(prompt, /以[\s\S]*为准[\s\S]*不要凭印象/);
    assert.match(prompt, /不要凭印象/);
  } finally {
    teardown(dir);
  }
});

// ──── 2. persona 静态 knowledge 不影响工具目录 ────

test('persona knowledge 里没写的工具，仍会出现在目录中（不依赖静态记忆）', async () => {
  const dir = await setupTempDirAsync();
  try {
    const roleWithEmptyKnowledge = {
      id: 'tester',
      name: '测试角色',
      description: '测试',
      knowledge: [],
      principles: [],
    };
    const prompt = buildSystemPrompt(roleWithEmptyKnowledge, { roleId: 'tester' });

    // 即使 persona.knowledge 是空，工具目录仍完整
    assert.match(prompt, /tool:\/\/web-search/);
    assert.match(prompt, /tool:\/\/filesystem/);
    assert.match(prompt, /共 \d+ 个工具/);
  } finally {
    teardown(dir);
  }
});

// ──── 3. discover API 验证 ────

test('discoverAvailableTools 返回 builtin 工具列表', async () => {
  const tools = await discoverAvailableToolsAsync();
  assert.ok(Array.isArray(tools));
  assert.ok(tools.length > 0);
  const uris = tools.map((t) => t.uri);
  assert.ok(uris.includes('tool://web-search'), '应包含 web-search');
  assert.ok(uris.includes('tool://filesystem'));
});

test('discoverAvailableTools 包含工具的 actions 信息', async () => {
  const tools = await discoverAvailableToolsAsync();
  const ws = tools.find((t) => t.uri === 'tool://web-search');
  assert.ok(ws, '应找到 web-search');
  assert.ok(Array.isArray(ws.actions));
  assert.ok(ws.actions.length > 0);
  assert.equal(ws.actions[0].name, 'search');
});

// ──── 4. 动态创建的 custom tool 也能被 persona 看到 ────

test('动态创建的 custom tool 自动出现在 system prompt', async () => {
  const dir = await setupTempDirAsync();
  try {
    // 创建 custom tool
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    const TEST_URI = 'tool://test-awareness-tool';
    const code = `export default async function execute(action, params) {
      return { ok: true, echo: 'hello from custom' };
    };`;

    const create = await p.dispatch({
      tool: 'tool://tool-creator', mode: 'execute',
      parameters: {
        action: 'create_script',
        uri: TEST_URI,
        name: 'test-awareness-tool',
        description: '测试工具感知的 custom tool',
        actions: [{ name: 'run', params: {} }],
        code,
      },
    });
    assert.equal(create.ok, true);

    // 关键：刷新缓存后再 buildSystemPrompt（模拟实际场景：buildSystemPrompt 前调用 discover）
    resetToolsCache();
    await discoverAvailableToolsAsync();
    const prompt = buildSystemPrompt(fakeJiangziyaRole, { roleId: 'jiangziya' });
    assert.match(prompt, /test-awareness-tool/, 'system prompt 应包含新创建的 custom tool');
    assert.match(prompt, /tool:\/\/test-awareness-tool/);

    // 清理
    p._customTools.delete(TEST_URI);
    removeFromRegistry(TEST_URI);
  } finally {
    teardown(dir);
  }
});

test('异步 discover 等待落盘 custom tools 加载完成', async () => {
  const dir = await setupTempDirAsync();
  try {
    // 第一步：先落盘注册表（模拟重启场景）
    const p1 = new ToolXProtocol({ cwd: process.cwd() });
    await p1._initCustomToolsPromise;
    const TEST_URI = 'tool://test-persist-awareness';
    await p1.dispatch({
      tool: 'tool://tool-creator', mode: 'execute',
      parameters: {
        action: 'create_script',
        uri: TEST_URI,
        name: 'test-persist-awareness',
        description: '持久化测试',
        actions: [{ name: 'go', params: {} }],
        code: `export default async function execute() { return { ok: true }; }`,
      },
    });
    // 关闭 p1，模拟进程结束
    p1._customTools.clear();

    // 第二步：新进程（仅通过 registry 知道有工具）
    // 清缓存（模拟新进程），discoverAvailableToolsAsync 应从磁盘恢复
    resetToolsCache();
    const tools = await discoverAvailableToolsAsync();
    const uris = tools.map((t) => t.uri);
    assert.ok(uris.includes(TEST_URI), '异步 discover 应从落盘注册表恢复并包含该工具');

    // 清理
    removeFromRegistry(TEST_URI);
  } finally {
    teardown(dir);
  }
});

// ──── 5. 真实场景：模拟姜子牙被问"你能搜索网页吗" ────

test('真实场景: 姜子牙被问"网络搜索"时，system prompt 已包含 tool://web-search', async () => {
  const dir = await setupTempDirAsync();
  try {
    // 模拟姜子牙 persona（不写任何工具相关 knowledge）
    const jiangziya = {
      id: 'jiangziya',
      name: '姜子牙',
      description: '战略领导代理',
      knowledge: [
        '战略分析方法论',
        '五层递进思考',
        '辅助者心态',
        // 注意：没有"网络搜索工具"、"web-search"等任何记忆
      ],
      principles: [],
    };

    const prompt = buildSystemPrompt(jiangziya, { roleId: 'jiangziya' });

    // 关键断言：即使 persona.knowledge 里没写，工具目录里仍有
    assert.match(prompt, /tool:\/\/web-search/, 'tool://web-search 应出现在工具目录');

    // 而且包含描述：多后端网络搜索
    assert.match(prompt, /多后端网络搜索/);

    // 还包含操作列表
    assert.match(prompt, /search/);

    // 还有提示要"以工具目录为准"
    assert.match(prompt, /以[\s\S]*列表为准/);
  } finally {
    teardown(dir);
  }
});