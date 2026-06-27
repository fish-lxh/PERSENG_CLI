/**
 * 跨 Agent 互通测试（重现飞书场景）
 *
 * 场景：
 *   - 飞书群 A（chat-a）：用户跟 jiangziya 对话
 *   - 飞书群 B（chat-b）：用户跟 luban 对话
 *   - jiangziya 调 agent_message 发消息给 luban
 *   - luban 调 agent_inbox 收消息
 *   - luban 调 agent_message 回复 jiangziya
 *
 * 验证：
 *   - 跨 TaskEngine 实例（不同 roleId）消息能互通
 *   - 共享同一个 blackboard DB（同一进程）
 *   - summaryForRole 只暴露计数（不污染主上下文）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resetDataPaths } from '../src/data-paths.js';
import {
  resetBlackboard,
  closeBlackboard,
  summaryForRole,
  sendMessage,
} from '../src/blackboard-store.js';
import { TaskEngine } from '../src/task-engine.js';

function setupTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'perseng-interop-'));
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

// 跳过需要 LLM 的工具 — 模拟 Feishu 中 LLM 调用工具的场景
async function setupEngines() {
  const jiangziya = new TaskEngine({ roleId: 'jiangziya', cwd: process.cwd() });
  const luban = new TaskEngine({ roleId: 'luban', cwd: process.cwd() });
  const hr = new TaskEngine({ roleId: 'hr', cwd: process.cwd() });
  // 触发 tool runtime 初始化（注册 agent_* 工具）
  await jiangziya.getToolRuntime();
  await luban.getToolRuntime();
  await hr.getToolRuntime();
  return { jiangziya, luban, hr };
}

// ──── 模拟飞书两 chat session 互通 ────

test('T1: jiangziya 发私聊 → luban inbox 收到', async () => {
  const dir = setupTempDir();
  try {
    const { jiangziya, luban } = await setupEngines();

    // jiangziya 通过 agent_message 发消息给 luban
    const sent = await (await jiangziya.getToolRuntime()).execute('agent_message', {
      to: 'luban',
      subject: '工具请求',
      body: '帮我建一个 web-search 工具',
    });
    const sentJson = JSON.parse(sent);
    assert.equal(sentJson.ok, true);
    assert.ok(sentJson.id > 0);

    // luban 通过 agent_inbox 收消息
    const inboxRaw = await (await luban.getToolRuntime()).execute('agent_inbox', {
      unreadOnly: true,
    });
    const inboxMsgs = JSON.parse(inboxRaw);
    assert.equal(inboxMsgs.length, 1, `luban 收件箱应有 1 条，实际 ${inboxMsgs.length}`);
    assert.equal(inboxMsgs[0].from, 'jiangziya');
    assert.equal(inboxMsgs[0].to, 'luban');
    assert.match(inboxMsgs[0].body, /web-search/);
    assert.equal(inboxMsgs[0].subject, '工具请求');
  } finally {
    teardown(dir);
  }
});

test('T2: luban 回复 → jiangziya 通过 conversation 看到全 thread', async () => {
  const dir = setupTempDir();
  try {
    const { jiangziya, luban } = await setupEngines();

    // 1) jiangziya 发
    const sent = await (await jiangziya.getToolRuntime()).execute('agent_message', {
      to: 'luban',
      body: '第一个问题',
    });
    const { id: firstId } = JSON.parse(sent);

    // 2) luban 回复（自动续 thread）
    const reply = await (await luban.getToolRuntime()).execute('agent_message', {
      to: 'jiangziya',
      body: '已收到，我来处理',
      conversationId: String(firstId),
    });
    const { id: replyId } = JSON.parse(reply);

    // 3) jiangziya 看 conversation thread
    const threadRaw = await (await jiangziya.getToolRuntime()).execute('agent_conversation', {
      conversationId: String(firstId),
    });
    const thread = JSON.parse(threadRaw);
    assert.equal(thread.length, 2, `thread 应有 2 条，实际 ${thread.length}`);
    assert.equal(thread[0].body, '第一个问题');
    assert.equal(thread[1].body, '已收到，我来处理');
    assert.equal(thread[1].from, 'luban');
    assert.equal(thread[1].to, 'jiangziya');
  } finally {
    teardown(dir);
  }
});

test('T3: 频道广播 — 多个 agent 都能看到', async () => {
  const dir = setupTempDir();
  try {
    const { jiangziya, luban, hr } = await setupEngines();

    // jiangziya 广播到 general 频道
    const sent = await (await jiangziya.getToolRuntime()).execute('agent_broadcast', {
      channel: 'general',
      body: '今天下午 3 点开会',
    });
    const sentJson = JSON.parse(sent);
    assert.equal(sentJson.ok, true);

    // luban 查频道历史
    const lubanHistRaw = await (await luban.getToolRuntime()).execute('agent_channel_history', {
      channel: 'general',
    });
    const lubanHist = JSON.parse(lubanHistRaw);
    assert.ok(lubanHist.length >= 1, `luban 应能看到频道消息`);

    // hr 也查频道历史
    const hrHistRaw = await (await hr.getToolRuntime()).execute('agent_channel_history', {
      channel: 'general',
    });
    const hrHist = JSON.parse(hrHistRaw);
    assert.equal(hrHist.length, lubanHist.length, '频道消息对所有 agent 可见');
  } finally {
    teardown(dir);
  }
});

test('T4: summaryForRole 只暴露计数，不暴露正文', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'jiangziya', to: 'luban', body: '这是机密内容' });

    const s = summaryForRole('luban');
    assert.match(s, /1 条未读/);
    assert.ok(!s.includes('机密内容'), 'summary 不应包含正文');

    const empty = summaryForRole('nuwa');
    assert.equal(empty, '');
  } finally {
    teardown(dir);
  }
});

test('T5: 同一进程多 TaskEngine 共享 blackboard（最关键的飞书场景）', async () => {
  // 模拟 feishu-multi：单进程启动多个 bot，每个 bot 一个 TaskEngine（不同 roleId）
  const dir = setupTempDir();
  try {
    const { jiangziya, luban, hr } = await setupEngines();

    // 模拟对话流：
    //   jiangziya 发 → luban → hr
    await (await jiangziya.getToolRuntime()).execute('agent_message', {
      to: 'luban', body: 'A1: 项目启动'
    });
    await (await luban.getToolRuntime()).execute('agent_message', {
      to: 'hr', body: 'A2: 需要招人'
    });
    await (await hr.getToolRuntime()).execute('agent_message', {
      to: 'jiangziya', body: 'A3: 收到，开始招'
    });

    // 每个 agent 收件箱应只有发给自己的消息
    const jiangziyaInbox = JSON.parse(
      await (await jiangziya.getToolRuntime()).execute('agent_inbox', { unreadOnly: true })
    );
    assert.equal(jiangziyaInbox.length, 1);
    assert.equal(jiangziyaInbox[0].from, 'hr');
    assert.equal(jiangziyaInbox[0].body, 'A3: 收到，开始招');

    const lubanInbox = JSON.parse(
      await (await luban.getToolRuntime()).execute('agent_inbox', { unreadOnly: true })
    );
    assert.equal(lubanInbox.length, 1);
    assert.equal(lubanInbox[0].from, 'jiangziya');

    const hrInbox = JSON.parse(
      await (await hr.getToolRuntime()).execute('agent_inbox', { unreadOnly: true })
    );
    assert.equal(hrInbox.length, 1);
    assert.equal(hrInbox[0].from, 'luban');

    // markRead 后未读计数变 0
    await (await luban.getToolRuntime()).execute('agent_mark_read', {
      all: true,
    });
    const lubanSummary = summaryForRole('luban');
    assert.equal(lubanSummary, '', 'markRead all 后 summary 应为空');
  } finally {
    teardown(dir);
  }
});

test('T6: agent_message 不能给自己发', async () => {
  const dir = setupTempDir();
  try {
    const { jiangziya } = await setupEngines();

    await assert.rejects(
      async () => (await jiangziya.getToolRuntime()).execute('agent_message', {
        to: 'jiangziya', body: '给自己',
      }),
      /不能给自己/,
    );
  } finally {
    teardown(dir);
  }
});

test('T7: 参数校验 — agent_message 缺 body', async () => {
  const dir = setupTempDir();
  try {
    const { jiangziya } = await setupEngines();

    await assert.rejects(
      async () => (await jiangziya.getToolRuntime()).execute('agent_message', {
        to: 'luban',
      }),
      /body/,
    );
  } finally {
    teardown(dir);
  }
});

test('T8: 参数校验 — agent_broadcast 缺 channel', async () => {
  const dir = setupTempDir();
  try {
    const { jiangziya } = await setupEngines();

    await assert.rejects(
      async () => (await jiangziya.getToolRuntime()).execute('agent_broadcast', {
        body: 'no channel',
      }),
      /channel/,
    );
  } finally {
    teardown(dir);
  }
});

test('T9: 多个 TaskEngine 实例间隔离 inbox（不同 roleId 互不可见）', async () => {
  const dir = setupTempDir();
  try {
    const { jiangziya, luban, hr, nuwa } = await (async () => {
      const e = await setupEngines();
      const nuwa = new TaskEngine({ roleId: 'nuwa', cwd: process.cwd() });
      await nuwa.getToolRuntime();
      return { ...e, nuwa };
    })();

    // jiangziya 只发给 luban
    await (await jiangziya.getToolRuntime()).execute('agent_message', {
      to: 'luban', body: '只给 luban',
    });

    // hr 和 nuwa 看不到
    const hrInbox = JSON.parse(
      await (await hr.getToolRuntime()).execute('agent_inbox', { unreadOnly: true })
    );
    const nuwaInbox = JSON.parse(
      await (await nuwa.getToolRuntime()).execute('agent_inbox', { unreadOnly: true })
    );
    assert.equal(hrInbox.length, 0, 'hr 不应看到发给 luban 的私聊');
    assert.equal(nuwaInbox.length, 0, 'nuwa 不应看到发给 luban 的私聊');

    // luban 看到
    const lubanInbox = JSON.parse(
      await (await luban.getToolRuntime()).execute('agent_inbox', { unreadOnly: true })
    );
    assert.equal(lubanInbox.length, 1);
  } finally {
    teardown(dir);
  }
});