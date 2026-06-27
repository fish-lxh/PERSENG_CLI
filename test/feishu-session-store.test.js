/**
 * FeishuSessionStore 单元测试
 *
 * 覆盖：
 *   T1 getOrCreate 复用现有 session
 *   T2 超 MAX_SESSIONS 时 LRU 淘汰
 *   T3 空闲超时回收
 *   T4 显式 evict 取消进行中的任务
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FeishuSessionStore } from '../src/feishu-session-store.js';

// 用一个简单的 fake engine 替代 TaskEngine
function fakeEngine(id) {
  return { __id: id, run: async () => `result-${id}` };
}

function makeStore(opts = {}) {
  const factory = opts.engineFactory || ((chatId, roleId) => fakeEngine(`${roleId}@${chatId}`));
  return new FeishuSessionStore({
    engineFactory: factory,
    maxSessions: opts.maxSessions ?? 3,
    idleTimeoutMs: opts.idleTimeoutMs ?? 30_000,
  });
}

// ─── T1: getOrCreate 复用 ────────────────────────────────

test('T1: getOrCreate 复用现有 session', () => {
  const store = makeStore();
  const s1 = store.getOrCreate('c1', 'p2p', 'r1', { senderId: 'u1' });
  const s2 = store.getOrCreate('c1', 'p2p', 'r1', { senderId: 'u2' });
  assert.equal(s1, s2, 'should reuse same session');
  assert.equal(s2.senderId, 'u2', 'senderId should update');
  assert.equal(store.size, 1);
});

// ─── T2: LRU 淘汰 ────────────────────────────────────────

test('T2: 超 MAX_SESSIONS 时淘汰最旧的 (LRU)', () => {
  const evicted = [];
  const store = new FeishuSessionStore({
    engineFactory: (chatId, roleId) => ({
      ...fakeEngine(`${roleId}@${chatId}`),
      _abortCtl: null,
    }),
    maxSessions: 2,
    idleTimeoutMs: 30_000,
  });
  // 我们没有 engineFactory 注入 abortCtl 钩子；改用显式 evict 验证
  const s1 = store.getOrCreate('c1', 'p2p', 'r');
  const s2 = store.getOrCreate('c2', 'p2p', 'r');
  const s3 = store.getOrCreate('c3', 'p2p', 'r');

  assert.equal(store.size, 2);
  assert.equal(store.get('c1'), undefined, 'c1 should be evicted (oldest)');
  assert.ok(store.get('c2'));
  assert.ok(store.get('c3'));
});

// ─── T3: 空闲超时回收 ─────────────────────────────────────

test('T3: idle 超时的 session 被 sweep 回收', async () => {
  const store = new FeishuSessionStore({
    engineFactory: (chatId, roleId) => fakeEngine(`${roleId}@${chatId}`),
    maxSessions: 10,
    idleTimeoutMs: 10,  // 10ms 立即超时
  });
  store.getOrCreate('c1', 'p2p', 'r');
  assert.equal(store.size, 1);

  // 等超时
  await new Promise((r) => setTimeout(r, 30));

  const removed = store.sweep();
  assert.equal(removed, 1);
  assert.equal(store.size, 0);
});

// ─── T4: 显式 evict 取消正在跑的任务 ─────────────────────

test('T4: evict 取消 session 的进行中任务', () => {
  let abortReason = null;
  const store = new FeishuSessionStore({
    engineFactory: (chatId, roleId) => fakeEngine(`${roleId}@${chatId}`),
    maxSessions: 10,
  });
  const s = store.getOrCreate('c1', 'p2p', 'r');
  s.abortCtl = new AbortController();
  s.abortCtl.signal.addEventListener('abort', () => {
    abortReason = s.abortCtl.signal.reason;
  });

  assert.equal(store.evict('c1'), true);
  assert.equal(store.size, 0);
  assert.equal(abortReason, 'evicted');

  // 第二次 evict 返回 false
  assert.equal(store.evict('c1'), false);
});

// ─── Bonus: startSweep / stopSweep ───────────────────────

test('Bonus: startSweep / stopSweep 定时器可启停', () => {
  const store = makeStore({ idleTimeoutMs: 1 });
  store.startSweep();
  assert.ok(store._sweepTimer, 'sweep timer should be set');
  store.stopSweep();
  assert.equal(store._sweepTimer, null, 'sweep timer should be cleared');
  // 重复 stop 不报错
  store.stopSweep();
});
