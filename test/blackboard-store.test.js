/**
 * BlackboardStore 单元测试
 *
 * 覆盖：
 *   T1 私聊发送 + 收件
 *   T2 频道广播
 *   T3 未读计数 + markRead
 *   T4 summaryForRole 隔离（不暴露正文）
 *   T5 会话线程 + replyToConversation
 *   T6 频道历史 + 列表
 *   T7 sendMessage 参数校验
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resetDataPaths } from '../src/data-paths.js';
import {
  sendMessage, sendToMany, getMessageById,
  inbox, outbox, markRead, markAllRead, unreadCount,
  channelHistory, listChannels, conversation, replyToConversation,
  summaryForRole, resetBlackboard, closeBlackboard,
} from '../src/blackboard-store.js';

function setupTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'perseng-bb-'));
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

// ─── T1: 私聊 ─────────────────────────────────────────

test('T1: 私聊发送 + 收件', () => {
  const dir = setupTempDir();
  try {
    const m = sendMessage({ from: 'jiangziya', to: 'luban', subject: 'hi', body: '写个工具' });
    assert.ok(m.id);
    assert.equal(m.from, 'jiangziya');
    assert.equal(m.to, 'luban');
    assert.equal(m.subject, 'hi');

    const lubanInbox = inbox('luban');
    assert.equal(lubanInbox.length, 1);
    assert.equal(lubanInbox[0].body, '写个工具');
  } finally {
    teardown(dir);
  }
});

test('T1: 收件箱不返回别人的私聊', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'jiangziya', to: 'luban', body: 'a' });
    sendMessage({ from: 'hr', to: 'nuwa', body: 'b' });
    assert.equal(inbox('luban').length, 1);
    assert.equal(inbox('nuwa').length, 1);
    assert.equal(inbox('jiangziya').length, 0);  // 没收到任何
  } finally {
    teardown(dir);
  }
});

// ─── T2: 频道 ─────────────────────────────────────────

test('T2: 频道广播 — 频道历史包含消息', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'jiangziya', channel: 'general', body: '各位好' });
    sendMessage({ from: 'luban', channel: 'general', body: '收到' });

    const hist = channelHistory('general');
    assert.equal(hist.length, 2);
    assert.equal(hist[0].from, 'luban');  // 最新在前
  } finally {
    teardown(dir);
  }
});

test('T2: 频道消息不进私聊收件箱', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'jiangziya', channel: 'general', body: '公共消息' });
    assert.equal(inbox('luban').length, 0);  // 不进 luban 私聊
    assert.equal(inbox('nuwa').length, 0);
  } finally {
    teardown(dir);
  }
});

// ─── T3: markRead / unreadCount ───────────────────────

test('T3: markRead 减少未读', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'a', to: 'b', body: 'm1' });
    sendMessage({ from: 'a', to: 'b', body: 'm2' });
    sendMessage({ from: 'a', to: 'b', body: 'm3' });
    assert.equal(unreadCount('b'), 3);

    const m1 = inbox('b')[0];
    const m2 = inbox('b')[1];
    const changed = markRead([m1.id, m2.id], 'b');
    assert.equal(changed, 2);
    assert.equal(unreadCount('b'), 1);
  } finally {
    teardown(dir);
  }
});

test('T3: markAllRead 清零', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'a', to: 'b', body: 'm1' });
    sendMessage({ from: 'c', to: 'b', body: 'm2' });
    const changed = markAllRead('b');
    assert.equal(changed, 2);
    assert.equal(unreadCount('b'), 0);
  } finally {
    teardown(dir);
  }
});

test('T3: markRead 不标记别人的消息', () => {
  const dir = setupTempDir();
  try {
    const m = sendMessage({ from: 'a', to: 'b', body: 'm1' });
    // c 尝试标记 b 的消息
    const changed = markRead([m.id], 'c');
    assert.equal(changed, 0);  // 没有改任何行
    assert.equal(unreadCount('b'), 1);
  } finally {
    teardown(dir);
  }
});

// ─── T4: summaryForRole 不暴露正文 ───────────────────

test('T4: summaryForRole 0 条不返回任何东西', () => {
  const dir = setupTempDir();
  try {
    assert.equal(summaryForRole('luban'), '');
  } finally {
    teardown(dir);
  }
});

test('T4: summaryForRole 仅返回计数提示，不含正文', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'a', to: 'luban', body: '秘密内容SECRET_KEY_12345' });
    const summary = summaryForRole('luban');
    assert.match(summary, /1 条未读/);
    assert.doesNotMatch(summary, /SECRET_KEY_12345/);
    assert.doesNotMatch(summary, /秘密内容/);
  } finally {
    teardown(dir);
  }
});

// ─── T5: 会话线程 ─────────────────────────────────────

test('T5: conversation 返回 thread 全部消息（按时间正序）', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'a', to: 'b', conversationId: 't1', body: 'first' });
    sendMessage({ from: 'b', to: 'a', conversationId: 't1', body: 'reply' });
    sendMessage({ from: 'a', to: 'b', conversationId: 't1', body: 'final' });

    const thread = conversation('t1');
    assert.equal(thread.length, 3);
    assert.equal(thread[0].body, 'first');
    assert.equal(thread[2].body, 'final');
  } finally {
    teardown(dir);
  }
});

test('T5: replyToConversation 自动找对接收方', () => {
  const dir = setupTempDir();
  try {
    const root = sendMessage({ from: 'a', to: 'b', conversationId: 't2', body: '初始' });
    // b 回复
    const reply = replyToConversation({ from: 'b', conversationId: 't2', body: '回复' });
    assert.equal(reply.to, 'a');
    assert.equal(reply.conversationId, 't2');
    assert.equal(reply.from, 'b');
  } finally {
    teardown(dir);
  }
});

// ─── T6: 频道列表 ─────────────────────────────────────

test('T6: listChannels 返回所有频道 + 计数', () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'a', channel: 'general', body: '1' });
    sendMessage({ from: 'b', channel: 'general', body: '2' });
    sendMessage({ from: 'a', channel: 'project-x', body: '3' });

    const channels = listChannels();
    assert.equal(channels.length, 2);
    const general = channels.find((c) => c.name === 'general');
    assert.equal(general.messageCount, 2);
  } finally {
    teardown(dir);
  }
});

test('T6: channelHistory since 过滤', async () => {
  const dir = setupTempDir();
  try {
    sendMessage({ from: 'a', channel: 'g', body: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    const mid = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    sendMessage({ from: 'a', channel: 'g', body: 'new' });
    const recent = channelHistory('g', { since: mid });
    assert.equal(recent.length, 1, `expected 1, got ${recent.length}`);
    assert.equal(recent[0].body, 'new');
  } finally {
    teardown(dir);
  }
});

// ─── T7: 参数校验 ─────────────────────────────────────

test('T7: 缺 from 抛错', () => {
  const dir = setupTempDir();
  try {
    assert.throws(() => sendMessage({ to: 'b', body: 'x' }), /from/);
  } finally {
    teardown(dir);
  }
});

test('T7: 缺 body 抛错', () => {
  const dir = setupTempDir();
  try {
    assert.throws(() => sendMessage({ from: 'a', to: 'b' }), /body/);
  } finally {
    teardown(dir);
  }
});

test('T7: to 和 channel 都没指定 抛错', () => {
  const dir = setupTempDir();
  try {
    assert.throws(() => sendMessage({ from: 'a', body: 'x' }), /to or channel/);
  } finally {
    teardown(dir);
  }
});

test('T7: to 和 channel 同时指定 抛错', () => {
  const dir = setupTempDir();
  try {
    assert.throws(
      () => sendMessage({ from: 'a', to: 'b', channel: 'c', body: 'x' }),
      /mutually exclusive/,
    );
  } finally {
    teardown(dir);
  }
});

// ─── Bonus: sendToMany ───────────────────────────────

test('Bonus: sendToMany 群发', () => {
  const dir = setupTempDir();
  try {
    const ids = sendToMany('jiangziya', ['luban', 'nuwa', 'hr'], '全员通知');
    assert.equal(ids.length, 3);
    assert.equal(inbox('luban').length, 1);
    assert.equal(inbox('nuwa').length, 1);
    assert.equal(inbox('hr').length, 1);
  } finally {
    teardown(dir);
  }
});
