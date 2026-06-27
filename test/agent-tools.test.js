/**
 * agent_* 工具层单元测试（Phase 5.5）
 *
 * 覆盖（通过 ToolRuntime.execute 调用注册的 agent_* 工具）：
 *   T1 agent_message 私聊发送（其他 role 收件箱能收到）
 *   T2 agent_broadcast 广播（频道历史能拉取）
 *   T3 agent_inbox 只看未读 + 全部
 *   T4 agent_mark_read 标记已读（支持 messageIds 和 all）
 *   T5 agent_conversation thread 拉取
 *   T6 agent_channel_history 频道拉取
 *   T7 隔离：agent_message 的 from 永远是 TaskEngine.roleId（不能冒名）
 *   T8 system prompt 注入 summaryForRole：buildSystemPrompt(role, {roleId}) 含 "N 条未读"
 *   T9 system prompt 不暴露正文（隔离保证）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TaskEngine } from '../src/task-engine.js';
import { ToolRuntime } from '../src/tool-runtime.js';
import { resetDataPaths } from '../src/data-paths.js';
import { resetBlackboard, closeBlackboard, summaryForRole } from '../src/blackboard-store.js';

function setupTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'perseng-agent-tools-'));
  process.env.PERSENG_CLI_BLACKBOARD_DIR = dir;
  resetDataPaths();
  resetBlackboard();
  return dir;
}

function teardown(dir) {
  closeBlackboard();
  delete process.env.PERSENG_CLI_BLACKBOARD_DIR;
  resetDataPaths();
  rmSync(dir, { recursive: true, force: true });
}

/**
 * 构造一个只注册 agent_* 工具的 ToolRuntime（用 TaskEngine 实例以拿到 roleId）
 */
async function buildRuntimeWithAgentTools(roleId) {
  const engine = new TaskEngine({ roleId });
  // 通过反射拿到内部 _toolRuntime
  const rt = new ToolRuntime();
  engine._toolRuntime = rt;
  await engine.registerBuiltinTools();
  return { engine, rt };
}

function makeNoopLlm(systemCapture) {
  return {
    async streamMessages(params) {
      if (systemCapture) systemCapture.value = params.system;
      params.onText?.('ok');
      return { text: 'ok', toolCalls: [] };
    },
  };
}

// ─── T1: agent_message ────────────────────────────────

test('T1: agent_message 私聊发送', async () => {
  const dir = setupTempDir();
  try {
    const { rt } = await buildRuntimeWithAgentTools('luban');
    const result = await rt.execute('agent_message', {
      to: 'nuwa',
      body: '帮 nuwa 干活',
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.id);

    // 切换到 nuwa 的"视角"再查收件箱
    const { rt: nuwaRt } = await buildRuntimeWithAgentTools('nuwa');
    const inboxRaw = await nuwaRt.execute('agent_inbox', { unreadOnly: true, limit: 10 });
    const inbox = JSON.parse(inboxRaw);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from, 'luban');
    assert.equal(inbox[0].body, '帮 nuwa 干活');
  } finally {
    teardown(dir);
  }
});

test('T1: agent_message 不能给自己发', async () => {
  const dir = setupTempDir();
  try {
    const { rt } = await buildRuntimeWithAgentTools('luban');
    await assert.rejects(
      () => rt.execute('agent_message', { to: 'luban', body: 'x' }),
      /不能给自己/,
    );
  } finally {
    teardown(dir);
  }
});

// ─── T2: agent_broadcast ──────────────────────────────

test('T2: agent_broadcast 广播进频道', async () => {
  const dir = setupTempDir();
  try {
    const { rt } = await buildRuntimeWithAgentTools('jiangziya');
    const result = await rt.execute('agent_broadcast', {
      channel: 'general',
      body: '各位请注意',
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.channel, 'general');

    const histRaw = await rt.execute('agent_channel_history', { channel: 'general', limit: 5 });
    const hist = JSON.parse(histRaw);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].body, '各位请注意');
  } finally {
    teardown(dir);
  }
});

// ─── T3: agent_inbox ──────────────────────────────────

test('T3: agent_inbox 默认只看未读', async () => {
  const dir = setupTempDir();
  try {
    // 用 jiangziya 给 luban 发
    const { rt: leaderRt } = await buildRuntimeWithAgentTools('jiangziya');
    await leaderRt.execute('agent_message', { to: 'luban', body: 'm1' });
    await leaderRt.execute('agent_message', { to: 'luban', body: 'm2' });
    // 切到 luban 查收件箱
    const { rt: lubanRt } = await buildRuntimeWithAgentTools('luban');
    const inboxRaw = await lubanRt.execute('agent_inbox', {});
    const inbox = JSON.parse(inboxRaw);
    assert.equal(inbox.length, 2);
  } finally {
    teardown(dir);
  }
});

test('T3: agent_inbox unreadOnly=false 看全部', async () => {
  const dir = setupTempDir();
  try {
    const { rt: leaderRt } = await buildRuntimeWithAgentTools('jiangziya');
    const { rt: lubanRt } = await buildRuntimeWithAgentTools('luban');
    await leaderRt.execute('agent_message', { to: 'luban', body: 'm1' });
    await lubanRt.execute('agent_mark_read', { all: true });
    await leaderRt.execute('agent_message', { to: 'luban', body: 'm2' });
    // 只看未读 → 1 条
    const unreadOnly = JSON.parse(await lubanRt.execute('agent_inbox', { unreadOnly: true }));
    assert.equal(unreadOnly.length, 1);
    // 全部 → 2 条
    const all = JSON.parse(await lubanRt.execute('agent_inbox', { unreadOnly: false }));
    assert.equal(all.length, 2);
  } finally {
    teardown(dir);
  }
});

// ─── T4: agent_mark_read ──────────────────────────────

test('T4: agent_mark_read 减少未读', async () => {
  const dir = setupTempDir();
  try {
    const { rt: leaderRt } = await buildRuntimeWithAgentTools('jiangziya');
    const r1 = JSON.parse(await leaderRt.execute('agent_message', { to: 'luban', body: 'm1' }));
    const r2 = JSON.parse(await leaderRt.execute('agent_message', { to: 'luban', body: 'm2' }));

    const { rt: lubanRt } = await buildRuntimeWithAgentTools('luban');
    const markResult = JSON.parse(
      await lubanRt.execute('agent_mark_read', { messageIds: [r1.id, r2.id] }),
    );
    assert.equal(markResult.markedRead, 2);

    const inboxRaw = await lubanRt.execute('agent_inbox', {});
    const inbox = JSON.parse(inboxRaw);
    assert.equal(inbox.length, 0);
  } finally {
    teardown(dir);
  }
});

test('T4: agent_mark_read all=true 清空', async () => {
  const dir = setupTempDir();
  try {
    const { rt: leaderRt } = await buildRuntimeWithAgentTools('jiangziya');
    await leaderRt.execute('agent_message', { to: 'luban', body: 'm1' });
    await leaderRt.execute('agent_message', { to: 'luban', body: 'm2' });
    const { rt: lubanRt } = await buildRuntimeWithAgentTools('luban');
    const markResult = JSON.parse(await lubanRt.execute('agent_mark_read', { all: true }));
    assert.equal(markResult.markedRead, 2);
  } finally {
    teardown(dir);
  }
});

test('T4: agent_mark_read 缺参抛错', async () => {
  const dir = setupTempDir();
  try {
    const { rt } = await buildRuntimeWithAgentTools('luban');
    await assert.rejects(() => rt.execute('agent_mark_read', {}), /需要提供/);
  } finally {
    teardown(dir);
  }
});

// ─── T5: agent_conversation ───────────────────────────

test('T5: agent_conversation 拉取 thread', async () => {
  const dir = setupTempDir();
  try {
    const { rt: lubanRt } = await buildRuntimeWithAgentTools('luban');
    const sent = JSON.parse(await lubanRt.execute('agent_message', {
      to: 'nuwa', body: 'a', conversationId: 't-x',
    }));
    assert.equal(sent.conversationId, 't-x');

    const { rt: nuwaRt } = await buildRuntimeWithAgentTools('nuwa');
    await nuwaRt.execute('agent_message', {
      to: 'luban', body: 'b', conversationId: 't-x',
    });

    const threadRaw = await lubanRt.execute('agent_conversation', { conversationId: 't-x' });
    const thread = JSON.parse(threadRaw);
    assert.equal(thread.length, 2);
    assert.equal(thread[0].body, 'a');
    assert.equal(thread[1].body, 'b');
  } finally {
    teardown(dir);
  }
});

// ─── T6: agent_channel_history ────────────────────────

test('T6: agent_channel_history limit', async () => {
  const dir = setupTempDir();
  try {
    const { rt } = await buildRuntimeWithAgentTools('jiangziya');
    for (let i = 0; i < 3; i++) {
      await rt.execute('agent_broadcast', { channel: 'g', body: `m${i}` });
    }
    const hist = JSON.parse(await rt.execute('agent_channel_history', { channel: 'g', limit: 2 }));
    assert.equal(hist.length, 2);
  } finally {
    teardown(dir);
  }
});

// ─── T7: from 永远是 TaskEngine.roleId（隔离冒名） ────

test('T7: agent_message 的 from 来自 roleId，不能伪装', async () => {
  const dir = setupTempDir();
  try {
    // luban 工具实例
    const { rt: lubanRt } = await buildRuntimeWithAgentTools('luban');
    // 即使在 input 里塞个 from 字段，schema 不收，from 仍然是 luban
    await lubanRt.execute('agent_message', {
      to: 'nuwa', body: 'x', from: 'jiangziya',  // ← 假装是 jiangziya
    });
    const { rt: nuwaRt } = await buildRuntimeWithAgentTools('nuwa');
    const inbox = JSON.parse(await nuwaRt.execute('agent_inbox', {}));
    assert.equal(inbox[0].from, 'luban', 'from 字段必须来自 roleId，不能被工具 input 篡改');
  } finally {
    teardown(dir);
  }
});

// ─── T8: system prompt 注入 summaryForRole ────────────

test('T8: buildSystemPrompt 含 N 条未读（来自 roleId）', async () => {
  const dir = setupTempDir();
  try {
    // 用 jiangziya 身份给 luban 发一条（不能 luban→luban）
    const { rt: leaderRt } = await buildRuntimeWithAgentTools('jiangziya');
    await leaderRt.execute('agent_message', { to: 'luban', body: '私信内容' });

    // 用 luban 跑 engine，捕获 system prompt
    const capture = { value: '' };
    const llm = makeNoopLlm(capture);
    const engine = new TaskEngine({ roleId: 'luban', llmClient: llm });
    await engine.run('x');

    assert.match(capture.value, /1 条未读/);
  } finally {
    teardown(dir);
  }
});

test('T8: 0 条未读时 system prompt 不包含收件箱提示', async () => {
  const dir = setupTempDir();
  try {
    const capture = { value: '' };
    const llm = makeNoopLlm(capture);
    const engine = new TaskEngine({ roleId: 'luban', llmClient: llm });
    await engine.run('x');

    assert.doesNotMatch(capture.value, /收件箱/);
  } finally {
    teardown(dir);
  }
});

// ─── T9: system prompt 隔离——不暴露正文 ─────────────

test('T9: system prompt 不含正文（隔离保证）', async () => {
  const dir = setupTempDir();
  try {
    // 用 jiangziya 身份给 luban 发秘密正文
    const { rt: leaderRt } = await buildRuntimeWithAgentTools('jiangziya');
    await leaderRt.execute('agent_message', { to: 'luban', body: '绝密内容X' });

    const capture = { value: '' };
    const llm = makeNoopLlm(capture);
    const engine = new TaskEngine({ roleId: 'luban', llmClient: llm });
    await engine.run('x');

    assert.match(capture.value, /1 条未读/);
    assert.doesNotMatch(capture.value, /绝密内容X/);
  } finally {
    teardown(dir);
  }
});

// ─── T10: 工具已注册 ──────────────────────────────────

test('T10: 6 个 agent_* 工具全部注册到 ToolRuntime', async () => {
  const dir = setupTempDir();
  try {
    const { rt } = await buildRuntimeWithAgentTools('luban');
    const names = rt.listToolNames();
    for (const name of [
      'agent_message', 'agent_broadcast', 'agent_inbox',
      'agent_mark_read', 'agent_conversation', 'agent_channel_history',
    ]) {
      assert.ok(names.includes(name), `missing tool: ${name}`);
    }
  } finally {
    teardown(dir);
  }
});

test('T10: agent_* 工具定义符合 Anthropic 格式', async () => {
  const dir = setupTempDir();
  try {
    const { rt } = await buildRuntimeWithAgentTools('luban');
    const defs = rt.getToolDefinitions();
    const agentMsg = defs.find((d) => d.name === 'agent_message');
    assert.ok(agentMsg, 'agent_message definition missing');
    assert.equal(agentMsg.input_schema.type, 'object');
    assert.ok(agentMsg.input_schema.properties.to);
    assert.ok(agentMsg.input_schema.properties.body);
    assert.deepEqual(agentMsg.input_schema.required, ['to', 'body']);
  } finally {
    teardown(dir);
  }
});
