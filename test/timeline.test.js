/**
 * tool://timeline 系统工具测试
 *
 * 覆盖：
 *   1. timeline-store 底层 CRUD / 过滤 / 导出 / 校验
 *   2. ToolXProtocol 集成（BUILTIN_TOOLS + dispatch + log）
 *   3. dryrun 模式正确性
 *   4. 并发鲁班写入 / 重启恢复（与 web-search 一致的 isolation pattern）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ToolXProtocol } from '../src/toolx/ToolXProtocol.js';
import {
  addEvent,
  listEvents,
  getEvent,
  updateEvent,
  deleteEvent,
  stats,
  exportTimeline,
} from '../src/toolx/timeline-store.js';

// ──── 测试夹具 ────

function setupTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'perseng-timeline-'));
  process.env.PERSENG_CLI_TIMELINE_DIR = dir;
  return dir;
}

function teardown(dir) {
  delete process.env.PERSENG_CLI_TIMELINE_DIR;
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════
// 1. timeline-store 底层测试
// ════════════════════════════════════════════════════════════════

test('timeline-store: addEvent + getEvent 闭环', () => {
  const dir = setupTempDir();
  try {
    const e = addEvent({ title: 'v1.0 发布', category: 'release', tags: ['v1.0'] });
    assert.ok(e.id, '应自动生成 id');
    assert.equal(e.title, 'v1.0 发布');
    assert.equal(e.category, 'release');
    assert.deepEqual(e.tags, ['v1.0']);
    assert.ok(e.time, '应自动设置 time');
    assert.ok(e.createdAt);

    // 从磁盘恢复
    const fetched = getEvent(e.id);
    assert.equal(fetched.id, e.id);
    assert.equal(fetched.title, e.title);
  } finally {
    teardown(dir);
  }
});

test('timeline-store: 缺 title 应抛错', () => {
  const dir = setupTempDir();
  try {
    assert.throws(() => addEvent({ category: 'release' }), /title/);
    assert.throws(() => addEvent({ title: '   ' }), /title/);
  } finally {
    teardown(dir);
  }
});

test('timeline-store: 未知 category 应抛错', () => {
  const dir = setupTempDir();
  try {
    assert.throws(
      () => addEvent({ title: 'X', category: 'nonsense' }),
      /未知 category/,
    );
  } finally {
    teardown(dir);
  }
});

test('timeline-store: listEvents 按 time 倒序 + 多重过滤', () => {
  const dir = setupTempDir();
  try {
    addEvent({ title: 'A 旧', time: '2026-06-01T10:00:00Z', category: 'release' });
    addEvent({ title: 'B 中', time: '2026-06-15T10:00:00Z', category: 'incident' });
    addEvent({ title: 'C 新', time: '2026-06-23T10:00:00Z', category: 'release' });

    // 全部按倒序
    const all = listEvents();
    assert.equal(all.length, 3);
    assert.equal(all[0].title, 'C 新');
    assert.equal(all[2].title, 'A 旧');

    // category 过滤
    const releases = listEvents({ category: 'release' });
    assert.equal(releases.length, 2);

    // since / until 过滤
    const recent = listEvents({ since: '2026-06-10T00:00:00Z', until: '2026-06-20T00:00:00Z' });
    assert.equal(recent.length, 1);
    assert.equal(recent[0].title, 'B 中');

    // search 过滤
    const bySearch = listEvents({ search: 'A' });
    assert.equal(bySearch.length, 1);
    assert.equal(bySearch[0].title, 'A 旧');

    // tags 过滤
    addEvent({ title: 'D tag', category: 'note', tags: ['urgent', 'bug'] });
    const tagged = listEvents({ tags: ['urgent'] });
    assert.equal(tagged.length, 1);
    assert.equal(tagged[0].title, 'D tag');
  } finally {
    teardown(dir);
  }
});

test('timeline-store: updateEvent 局部更新 + 保护 id/createdAt', () => {
  const dir = setupTempDir();
  try {
    const e = addEvent({ title: '原标题', category: 'note' });
    const updated = updateEvent(e.id, { title: '新标题', tags: ['a'] });
    assert.equal(updated.title, '新标题');
    assert.equal(updated.id, e.id, 'id 不可改');
    assert.equal(updated.createdAt, e.createdAt, 'createdAt 不可改');
    assert.notEqual(updated.updatedAt, e.updatedAt, 'updatedAt 应被刷新');

    // 尝试改 id 应抛错
    assert.throws(
      () => updateEvent(e.id, { id: 'hijack' }),
      /字段 "id" 不允许/,
    );
  } finally {
    teardown(dir);
  }
});

test('timeline-store: deleteEvent + 不存在返回 ok:false', () => {
  const dir = setupTempDir();
  try {
    const e = addEvent({ title: 'to-remove' });
    const r = deleteEvent(e.id);
    assert.equal(r.ok, true);
    assert.equal(getEvent(e.id), null);

    const r2 = deleteEvent('non-existent');
    assert.equal(r2.ok, false);
  } finally {
    teardown(dir);
  }
});

test('timeline-store: stats 返回总数 + 分组', () => {
  const dir = setupTempDir();
  try {
    addEvent({ title: '1', category: 'release' });
    addEvent({ title: '2', category: 'release' });
    addEvent({ title: '3', category: 'incident' });
    const s = stats();
    assert.equal(s.total, 3);
    assert.equal(s.byCategory.release, 2);
    assert.equal(s.byCategory.incident, 1);
    assert.ok(s.earliest);
    assert.ok(s.latest);
  } finally {
    teardown(dir);
  }
});

test('timeline-store: exportTimeline 输出 markdown / json', () => {
  const dir = setupTempDir();
  try {
    addEvent({ title: 'M1', time: '2026-06-24T10:00:00Z', category: 'release', tags: ['v1'] });
    addEvent({ title: 'M2', time: '2026-06-24T14:00:00Z', category: 'incident' });

    const md = exportTimeline('markdown');
    assert.match(md, /# Timeline/);
    assert.match(md, /M1/);
    assert.match(md, /M2/);
    assert.match(md, /2026-06-24/);
    assert.match(md, /#v1/, '标签应被渲染');

    const json = exportTimeline('json');
    const parsed = JSON.parse(json);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
  } finally {
    teardown(dir);
  }
});

// ════════════════════════════════════════════════════════════════
// 2. ToolXProtocol 集成
// ════════════════════════════════════════════════════════════════

test('ToolXProtocol: tool://timeline 在 BUILTIN_TOOLS 中可发现', async () => {
  const dir = setupTempDir();
  try {
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    const d = p.discover();
    const uris = d.tools.map((t) => t.uri);
    assert.ok(uris.includes('tool://timeline'));

    const t = d.tools.find((x) => x.uri === 'tool://timeline');
    const actionNames = t.actions.map((a) => a.name);
    assert.ok(actionNames.includes('add'));
    assert.ok(actionNames.includes('list'));
    assert.ok(actionNames.includes('show'));
    assert.ok(actionNames.includes('update'));
    assert.ok(actionNames.includes('delete'));
    assert.ok(actionNames.includes('stats'));
    assert.ok(actionNames.includes('export'));
  } finally {
    teardown(dir);
  }
});

test('ToolXProtocol: dispatch add + list 端到端', async () => {
  const dir = setupTempDir();
  try {
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    // add
    const add = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: {
        action: 'add',
        title: '发布 v1.2',
        category: 'release',
        tags: ['v1.2', 'search'],
        description: '新增 tool://web-search',
        metadata: { commits: 47 },
      },
    });
    assert.equal(add.ok, true);
    assert.equal(add.action, 'add');
    assert.ok(add.event.id);
    assert.equal(add.event.category, 'release');
    assert.deepEqual(add.event.tags, ['v1.2', 'search']);
    assert.deepEqual(add.event.metadata, { commits: 47 });

    // list
    const list = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'list' },
    });
    assert.equal(list.ok, true);
    assert.equal(list.count, 1);
    assert.equal(list.events[0].title, '发布 v1.2');

    // list + category 过滤
    const filtered = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'list', category: 'incident' },
    });
    assert.equal(filtered.count, 0);
  } finally {
    teardown(dir);
  }
});

test('ToolXProtocol: show / update / delete 闭环', async () => {
  const dir = setupTempDir();
  try {
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    const added = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'add', title: '原标题' },
    });
    const id = added.event.id;

    // show
    const show = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'show', id },
    });
    assert.equal(show.event.title, '原标题');

    // show 不存在的 id
    const show404 = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'show', id: 'evt-nope' },
    });
    assert.equal(show404.ok, false);
    assert.match(show404.error, /不存在/);

    // update
    const upd = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'update', id, title: '新标题', tags: ['updated'] },
    });
    assert.equal(upd.ok, true);
    assert.equal(upd.event.title, '新标题');
    assert.deepEqual(upd.event.tags, ['updated']);

    // delete
    const del = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'delete', id },
    });
    assert.equal(del.ok, true);
    assert.equal(del.removed.id, id);

    // 再次 show 应失败
    const after = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'show', id },
    });
    assert.equal(after.ok, false);
  } finally {
    teardown(dir);
  }
});

test('ToolXProtocol: stats 与 export', async () => {
  const dir = setupTempDir();
  try {
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'add', title: 'A', category: 'release' },
    });
    await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'add', title: 'B', category: 'incident' },
    });

    const s = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'stats' },
    });
    assert.equal(s.ok, true);
    assert.equal(s.total, 2);
    assert.equal(s.byCategory.release, 1);
    assert.equal(s.byCategory.incident, 1);

    const exp = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'export', format: 'markdown' },
    });
    assert.equal(exp.ok, true);
    assert.equal(exp.format, 'markdown');
    assert.match(exp.content, /# Timeline/);
    assert.match(exp.content, /A/);
    assert.match(exp.content, /B/);

    const json = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'export', format: 'json' },
    });
    assert.equal(json.format, 'json');
    const parsed = JSON.parse(json.content);
    assert.equal(parsed.length, 2);
  } finally {
    teardown(dir);
  }
});

test('ToolXProtocol: 执行日志可被 log 模式查询', async () => {
  const dir = setupTempDir();
  try {
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'add', title: 'log-test' },
    });

    const log = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'log',
    });
    assert.equal(log.ok, true);
    assert.ok(log.total >= 1);
    const last = log.entries[log.entries.length - 1];
    assert.equal(last.action, 'add');
    assert.equal(last.status, 'success');
  } finally {
    teardown(dir);
  }
});

test('ToolXProtocol: 错误参数 → ok:false 但不抛出', async () => {
  const dir = setupTempDir();
  try {
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    // 缺 title
    const noTitle = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'add' },
    });
    assert.equal(noTitle.ok, false);

    // 未知 action
    const badAction = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'drop' },
    });
    assert.equal(badAction.ok, false);
    assert.match(badAction.error, /不支持操作/);
  } finally {
    teardown(dir);
  }
});

test('ToolXProtocol: 进程重启 → 落盘事件仍可读', async () => {
  const dir = setupTempDir();
  try {
    // 第一进程：写入
    const p1 = new ToolXProtocol({ cwd: process.cwd() });
    await p1._initCustomToolsPromise;
    const added = await p1.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'add', title: '持久化测试', category: 'release' },
    });
    assert.equal(added.ok, true);

    // 验证文件落盘
    const filePath = join(dir, 'timeline.json');
    assert.ok(existsSync(filePath), '应生成 timeline.json');
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    assert.equal(raw.length, 1);
    assert.equal(raw[0].title, '持久化测试');

    // 模拟"新进程"：清掉 p1._customTools 不影响（其实 timeline 走 BUILTIN_TOOLS，
    // 不走 _customTools，但这里语义验证磁盘持久化）
    p1._customTools.clear();

    // 第二进程
    const p2 = new ToolXProtocol({ cwd: process.cwd() });
    await p2._initCustomToolsPromise;
    const listed = await p2.dispatch({
      tool: 'tool://timeline',
      mode: 'execute',
      parameters: { action: 'list' },
    });
    assert.equal(listed.count, 1);
    assert.equal(listed.events[0].title, '持久化测试');
  } finally {
    teardown(dir);
  }
});

// ════════════════════════════════════════════════════════════════
// 3. dryrun 模式
// ════════════════════════════════════════════════════════════════

test('ToolXProtocol: dryrun 生成可读描述', async () => {
  const dir = setupTempDir();
  try {
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    const dryAdd = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'dryrun',
      parameters: { action: 'add', title: 'preview', category: 'release' },
    });
    assert.equal(dryAdd.ok, true);
    assert.match(dryAdd.description, /新增事件/);
    assert.match(dryAdd.description, /preview/);

    const dryList = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'dryrun',
      parameters: { action: 'list', category: 'release', since: '2026-06-01' },
    });
    assert.match(dryList.description, /列出事件/);
    assert.match(dryList.description, /过滤/);

    const dryStats = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'dryrun',
      parameters: { action: 'stats' },
    });
    assert.match(dryStats.description, /统计/);

    const dryExport = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'dryrun',
      parameters: { action: 'export', format: 'json' },
    });
    assert.match(dryExport.description, /json/);

    // 未知 action
    const dryBad = await p.dispatch({
      tool: 'tool://timeline',
      mode: 'dryrun',
      parameters: { action: 'purge' },
    });
    assert.equal(dryBad.ok, false);
  } finally {
    teardown(dir);
  }
});

test('ToolXProtocol: manual 模式返回完整文档', async () => {
  const dir = setupTempDir();
  try {
    const p = new ToolXProtocol({ cwd: process.cwd() });
    await p._initCustomToolsPromise;

    const m = await p.dispatch({ tool: 'tool://timeline', mode: 'manual' });
    assert.equal(m.ok, true);
    assert.match(m.manual, /tool:\/\/timeline/);
    assert.match(m.manual, /可用操作/);
    assert.match(m.manual, /存储/);
    assert.equal(m.actions.length, 7);
  } finally {
    teardown(dir);
  }
});