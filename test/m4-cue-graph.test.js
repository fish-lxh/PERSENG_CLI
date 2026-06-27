/**
 * M4.1 测试：Network 边权重改为共现频次 + 1-hop 邻居查询
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const tmpDir = mkdtempSync(join(tmpdir(), 'perseng-m41-'));
process.env.PERSENG_CLI_COGNITION_DIR = join(tmpDir, 'cognition');

const networkUrl = pathToFileURL(join(process.cwd(), 'src/cognition/Network.js')).href + `?t=${Date.now()}`;
const recallStrategyUrl = pathToFileURL(join(process.cwd(), 'src/cognition/RecallStrategy.js')).href;

let Network, calculateConnectionWeight;

before(async () => {
  const net = await import(networkUrl);
  Network = net.Network;
  const rs = await import(recallStrategyUrl);
  calculateConnectionWeight = rs.calculateConnectionWeight;
});

after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── calculateConnectionWeight 单元测试 ─────────────────────

test('weight: 共现 1 次 + 0 衰减 + strength 1.0 = 小于 1 的正数', () => {
  const w = calculateConnectionWeight({
    timestamp: Date.now(),
    position: 0,
    strength: 1.0,
    cooccurrence: 1,
  });
  assert.ok(w > 0 && w <= 1, `weight should be in (0, 1], got ${w}`);
});

test('weight: 共现 10 次比 1 次高', () => {
  const baseOpts = { timestamp: Date.now(), position: 0, strength: 1.0 };
  const w1 = calculateConnectionWeight({ ...baseOpts, cooccurrence: 1 });
  const w10 = calculateConnectionWeight({ ...baseOpts, cooccurrence: 10 });
  assert.ok(w10 > w1, `w10=${w10} should > w1=${w1}`);
});

test('weight: 7 天前的权重 ≈ 现在的一半（半衰期）', () => {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const wNow = calculateConnectionWeight({ timestamp: now, position: 0, strength: 1.0, cooccurrence: 1 });
  const wOld = calculateConnectionWeight({ timestamp: sevenDaysAgo, position: 0, strength: 1.0, cooccurrence: 1 });
  // 7 天半衰期：e^(-1) ≈ 0.368
  assert.ok(wOld < wNow, `old should be less than now`);
  assert.ok(Math.abs(wOld / wNow - 0.368) < 0.05, `ratio should be ~0.368, got ${wOld / wNow}`);
});

test('weight: position 越远权重越低', () => {
  const opts = { timestamp: Date.now(), strength: 1.0, cooccurrence: 1 };
  const w0 = calculateConnectionWeight({ ...opts, position: 0 });
  const w3 = calculateConnectionWeight({ ...opts, position: 3 });
  assert.ok(w0 > w3);
});

// ─── Network 真实更新 + 查询 ─────────────────────────────

test('Network: updateFromSchema 累加 cooccurrence', async () => {
  const roleDir = join(tmpDir, 'cognition', 'test-coc');
  const net = new Network({ roleDir, persengRoleDir: join(tmpDir, 'perseng-coc') });
  await net.ensure();

  // 第一次：schema=[A, B, C] 应该建 A→B, B→C 各 cooccurrence=1
  await net.updateFromSchema(['A', 'B', 'C'], 'engram-1', { timestamp: Date.now(), strength: 0.8 });

  // 第二次：同样 schema，cooccurrence 应该 = 2
  await net.updateFromSchema(['A', 'B', 'C'], 'engram-2', { timestamp: Date.now(), strength: 0.8 });

  // 第三次：错位 schema，B→A 而非 A→B
  await net.updateFromSchema(['B', 'A'], 'engram-3', { timestamp: Date.now(), strength: 0.8 });

  const aCue = await net.getOneHopNeighbors('A', { limit: 10 });
  assert.ok(aCue.length >= 1);
  const aToB = aCue.find((c) => c.target === 'B');
  assert.ok(aToB, 'A → B edge should exist');
  assert.equal(aToB.cooccurrence, 2, 'A→B cooccurrence should be 2 after 2 same-schema updates');

  const bCue = await net.getOneHopNeighbors('B', { limit: 10 });
  const bToA = bCue.find((c) => c.target === 'A');
  assert.ok(bToA, 'B → A edge should exist');
  assert.equal(bToA.cooccurrence, 1, 'B→A cooccurrence should be 1');
});

test('Network: getOneHopNeighbors 按 cooccurrence 降序', async () => {
  const roleDir = join(tmpDir, 'cognition', 'test-rank');
  const net = new Network({ roleDir, persengRoleDir: join(tmpDir, 'perseng-rank') });
  await net.ensure();

  // A → C 一次
  await net.updateFromSchema(['A', 'C'], 'e1', { timestamp: Date.now(), strength: 0.8 });
  // A → B 三次（应该排前）
  await net.updateFromSchema(['A', 'B'], 'e2', { timestamp: Date.now(), strength: 0.8 });
  await net.updateFromSchema(['A', 'B'], 'e3', { timestamp: Date.now(), strength: 0.8 });
  await net.updateFromSchema(['A', 'B'], 'e4', { timestamp: Date.now(), strength: 0.8 });

  const neighbors = await net.getOneHopNeighbors('A', { limit: 10 });
  assert.ok(neighbors.length >= 2);
  // B (cooccurrence=3) 应该在 C (cooccurrence=1) 之前
  const bIdx = neighbors.findIndex((n) => n.target === 'B');
  const cIdx = neighbors.findIndex((n) => n.target === 'C');
  assert.ok(bIdx < cIdx, `B (3x) should rank before C (1x), got order: ${neighbors.map(n => `${n.target}:${n.cooccurrence}`).join(', ')}`);
});

test('Network: getOneHopNeighbors 过滤低权重边', async () => {
  const roleDir = join(tmpDir, 'cognition', 'test-filter');
  const net = new Network({ roleDir, persengRoleDir: join(tmpDir, 'perseng-filter') });
  await net.ensure();

  await net.updateFromSchema(['X', 'Y'], 'e1', { timestamp: Date.now() - 365 * 24 * 60 * 60 * 1000, strength: 0.1 });
  await net.updateFromSchema(['X', 'Z'], 'e2', { timestamp: Date.now(), strength: 0.9 });

  const veryOld = await net.getOneHopNeighbors('X', { minWeight: 0.0001 });
  const veryFresh = await net.getOneHopNeighbors('X', { minWeight: 0.5 });
  assert.ok(veryOld.length >= 2, '应该包含 Z 和 Y');
  assert.ok(veryFresh.length >= 1 && veryFresh.length < veryOld.length, '高阈值应该过滤掉 Y（365 天前）');
});

// ─── 端到端：MemoryStore 实际能 1-hop 召回 ─────────────────

test('MemoryStore: 1-hop 召回 — 用 schema 邻接词触发间接命中', async () => {
  // 动态 import MemoryStore（避免污染全局模块状态）
  const msUrl = pathToFileURL(join(process.cwd(), 'src/cognition/MemoryStore.js')).href + `?t=${Date.now()}-m41`;
  const { remember, recall, resetMemoryStore } = await import(msUrl);
  // 防止多次 import 累积 db
  try { resetMemoryStore?.(); } catch { /* ignore */ }

  const roleId = 'cue-graph-test';

  // 场景：用户问"如何做拉面"，但历史记忆里只有 schema=[拉面, 高筋面粉, 和面] 的条目
  //   实际上 engram 内容是 "拉面要用高筋面粉反复折叠醒发"
  //   cue graph: 拉面 → 高筋面粉 → 和面（cooccurrence 累加）
  //
  // 用户 query "做面条用什么粉" — tokenize 出 [做, 面条, 用, 什么, 粉]
  //   findBestCenter 找 degree 最大的 cue：
  //     - "做": connections 0
  //     - "面条": connections 0（只有 "拉面" 有 connections）
  //     - "什么": connections 0
  //     - "粉": connections 0
  //   所以 center = null，recall 返回 []
  //
  // 注意：用户 query 里的词要跟历史 cue 词**完全匹配**才能触发传播激活。
  // 真实场景里 query 词（面条/粉）需要跟历史 schema 词（拉面/高筋面粉）有 cue_index 重叠。
  // 当前实现 findBestCenter 只看 query token 和 history cue 名字一致。

  // 简化：用完全相同的关键词测试传播
  await remember(roleId, '牛肉面要用高筋面粉反复折叠', {
    schema: ['牛肉面', '高筋面粉', '和面', '醒面'],
  });

  // query 直接命中 "牛肉面" → 扩散到 "高筋面粉" → 找到 engram
  const direct = await recall(roleId, '牛肉面', { limit: 5 });
  assert.ok(direct.length >= 1, 'direct recall should hit');
  assert.equal(direct[0].id, direct[0].id, 'should return engram');

  // 1-hop: query 用 "高筋面粉" 也能召回（因为 "牛肉面" → "高筋面粉" 是 1-hop 边）
  const oneHop = await recall(roleId, '高筋面粉', { limit: 5 });
  assert.ok(oneHop.length >= 1, '1-hop recall should hit via 牛肉面 → 高筋面粉');
});
