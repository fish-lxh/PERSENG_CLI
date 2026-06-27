/**
 * M4.2 测试：记忆 jaccard 去重 / 合并
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const tmpDir = mkdtempSync(join(tmpdir(), 'perseng-m42-'));
process.env.PERSENG_CLI_COGNITION_DIR = join(tmpDir, 'cognition');

const msUrl = pathToFileURL(join(process.cwd(), 'src/cognition/MemoryStore.js')).href + `?t=${Date.now()}-m42`;

let remember, recall, listEngrams, getEngram;

before(async () => {
  const ms = await import(msUrl);
  remember = ms.remember;
  recall = ms.recall;
  listEngrams = ms.listEngrams;
  getEngram = ms.getEngram;
});

after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('完全不同的内容：各自分别创建', async () => {
  const roleId = 'm42-different';
  const id1 = await remember(roleId, '我喜欢 Rust 编程语言', { schema: ['rust', '语言'] });
  const id2 = await remember(roleId, 'JavaScript 是动态类型语言', { schema: ['javascript', '语言'] });
  assert.notEqual(id1, id2);
});

test('措辞不同但意思相同：jaccard > 0.7 时合并到原条目', async () => {
  const roleId = 'm42-similar';
  // 第一条
  const id1 = await remember(roleId, '我喜欢 Rust 编程语言', { schema: ['rust', '语言', '喜欢'] });
  assert.ok(id1);

  // 第二条：措辞略不同但 token 重合度很高
  // tokens: [我, 喜欢, rust, 这门, 编程, 语言] vs [我, 喜欢, rust, 编程, 语言]
  // 集合:  {我, 喜欢, rust, 这门, 编程, 语言} = 6
  //        {我, 喜欢, rust, 编程, 语言}     = 5
  // inter = 5, union = 6, jaccard = 0.833
  const id2 = await remember(roleId, '我喜欢 rust 编程语言', { schema: ['rust', '编程', '喜欢'] });
  assert.equal(id1, id2, '应该合并到原条目，返回相同 id');

  // 验证：listEngrams 应该只有 1 条
  const list = await listEngrams(roleId, { limit: 100 });
  assert.equal(list.length, 1);

  // 内容应被 append
  const detail = await getEngram(roleId, id1);
  assert.match(detail.content, /我喜欢 Rust 编程语言/);
  assert.match(detail.content, /--/);
  // strength 应该有 +0.05
  assert.ok(detail.strength > 0.8, `strength should be > 0.8, got ${detail.strength}`);
});

test('可关闭 jaccard 合并：mergeSimilar=false', async () => {
  const roleId = 'm42-merge-off';
  const id1 = await remember(roleId, '我喜欢 Rust 编程语言', { schema: ['rust', '语言'] });
  const id2 = await remember(
    roleId,
    '我喜欢 rust 编程语言',
    { schema: ['rust', '编程'], mergeSimilar: false }
  );
  assert.notEqual(id1, id2, 'mergeSimilar=false 时应该创建新条目');
});

test('jaccard 阈值调高：内容相似度不够不合并', async () => {
  const roleId = 'm42-high-threshold';
  // 注意：fingerprint dedup 是 exact 匹配，跟 jaccard 互补
  // 这里用 mergeThreshold=0.99，几乎只有完全相同才合并（除了 fingerprint 兜底）
  const id1 = await remember(roleId, '我喜欢 Rust', { schema: ['rust'], mergeThreshold: 0.99 });
  const id2 = await remember(
    roleId,
    '我喜欢 rust 编程',
    { schema: ['rust', '编程'], mergeThreshold: 0.99 }
  );
  // jaccard: {我, 喜欢, rust} vs {我, 喜欢, rust, 编程} → 3/4 = 0.75 < 0.99
  // 加上 fingerprint 不同 → 应该新建
  assert.notEqual(id1, id2);
});

test('完全相同内容：fingerprint dedup 优先触发', async () => {
  const roleId = 'm42-fingerprint';
  const id1 = await remember(roleId, '我喜欢 Rust', { schema: ['rust'] });
  const id2 = await remember(roleId, '我喜欢 Rust', { schema: ['rust'] });
  assert.equal(id1, id2, '完全相同应被 fingerprint dedup 命中');
});

test('合并后 recall 仍能命中（schema 自动保留）', async () => {
  const roleId = 'm42-recall-after-merge';
  await remember(roleId, 'Python 是动态强类型语言', { schema: ['python', '动态类型'] });
  await remember(roleId, 'Python 是动态强类型解释型语言', { schema: ['python', '解释型'] });

  const list = await listEngrams(roleId, { limit: 100 });
  assert.equal(list.length, 1, '应合并为一条');

  // recall 应能命中
  const results = await recall(roleId, 'python', { limit: 5 });
  assert.ok(results.length >= 1);
});
