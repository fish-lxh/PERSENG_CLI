/**
 * M4.4 测试：tool result 结构化截断
 *
 * 注意：ToolRuntime.execute 内部已经 JSON.stringify，
 * 所以结构化截断对象到达测试代码时是字符串。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const tmpDir = mkdtempSync(join(tmpdir(), 'perseng-m44-'));

const taskEngineUrl = pathToFileURL(join(process.cwd(), 'src/task-engine.js')).href + `?t=${Date.now()}-m44`;

let TaskEngine;
before(async () => {
  const m = await import(taskEngineUrl);
  TaskEngine = m.TaskEngine;
});

after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// helper: 工具执行结果统一解包（runtime 已 JSON.stringify）
const unwrap = (raw) => {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
};

// ─── read_file ──────────────────────────────────────

test('read_file: 小文件完整返回纯文本', async () => {
  const file = join(tmpDir, 'small.txt');
  writeFileSync(file, 'line1\nline2\nline3\n');
  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const result = await tools.execute('read_file', { path: 'small.txt' });
  assert.equal(typeof result, 'string');
  assert.equal(result, 'line1\nline2\nline3\n');
});

test('read_file: 超过 limit 返回结构化截断', async () => {
  const file = join(tmpDir, 'big.txt');
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`);
  writeFileSync(file, lines.join('\n'));

  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const raw = await tools.execute('read_file', { path: 'big.txt', limit: 100 });
  const result = unwrap(raw);

  assert.equal(result.truncated, true);
  assert.equal(result.range.totalLines, 500);
  assert.equal(result.range.endLine, 100);
  assert.equal(result.nextOffset, 100);
  assert.match(result.hint, /offset=100/);
  assert.ok(result.content.includes('line 1'));
  assert.ok(result.content.includes('line 100'));
});

test('read_file: offset 跳过前 N 行', async () => {
  const file = join(tmpDir, 'offset.txt');
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  writeFileSync(file, lines.join('\n'));

  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const raw = await tools.execute('read_file', { path: 'offset.txt', offset: 40, limit: 5 });
  const result = unwrap(raw);

  assert.equal(result.truncated, true);
  assert.equal(result.range.startLine, 41);
  assert.equal(result.range.endLine, 45);
  assert.ok(result.content.includes('line 41'));
  assert.ok(!result.content.includes('line 40'));
});

test('read_file: 字节截断保护', async () => {
  const file = join(tmpDir, 'huge.txt');
  const bigLine = 'x'.repeat(10 * 1024);
  const content = Array.from({ length: 50 }, () => bigLine).join('\n');
  writeFileSync(file, content);

  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const raw = await tools.execute('read_file', { path: 'huge.txt', limit: 100, maxBytes: 5 * 1024 });
  const result = unwrap(raw);

  assert.equal(result.truncated, true);
  assert.equal(result.byteTruncated, true);
  assert.ok(Buffer.byteLength(result.content, 'utf-8') <= 5 * 1024 + 100);
});

test('read_file: 10MB+ 大文件直接拒绝', async () => {
  const file = join(tmpDir, 'massive.txt');
  const { openSync, writeSync, closeSync } = await import('fs');
  const fd = openSync(file, 'w');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 11; i++) writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }

  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const raw = await tools.execute('read_file', { path: 'massive.txt' });
  const result = unwrap(raw);

  assert.equal(result.reason, 'file_too_large');
  assert.ok(result.totalBytes > 10 * 1024 * 1024);
});

// ─── grep_search ──────────────────────────────────────

test('grep_search: 默认 limit=50', async () => {
  const file = join(tmpDir, 'matches.txt');
  const lines = Array.from({ length: 100 }, (_, i) => `match-${i + 1}`);
  writeFileSync(file, lines.join('\n'));

  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const raw = await tools.execute('grep_search', { pattern: 'match-', path: '.' });
  const result = unwrap(raw);

  assert.equal(result.truncated, true);
  assert.equal(result.shown, 50);
  assert.equal(result.total, 100);
  assert.match(result.hint, /pattern/);
});

test('grep_search: 匹配少于 limit 返回纯文本（向后兼容）', async () => {
  const file = join(tmpDir, 'few.txt');
  writeFileSync(file, 'a\nb\nc\n');

  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const result = await tools.execute('grep_search', { pattern: 'b', path: '.' });

  assert.equal(typeof result, 'string');
  assert.match(result, /b/);
});

test('grep_search: 无匹配返回 No matches found.', async () => {
  const file = join(tmpDir, 'empty.txt');
  writeFileSync(file, 'foo\nbar\n');

  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const result = await tools.execute('grep_search', { pattern: 'nonexistent_xyz', path: '.' });
  assert.equal(result, 'No matches found.');
});

test('grep_search: 自定义 limit', async () => {
  // 用独立子目录避免其他测试文件干扰
  const subDir = join(tmpDir, 'custom-sub');
  const { mkdirSync } = await import('fs');
  mkdirSync(subDir);
  const file = join(subDir, 'custom.txt');
  const lines = Array.from({ length: 30 }, (_, i) => `m${i}`);
  writeFileSync(file, lines.join('\n'));

  const eng = new TaskEngine({ cwd: tmpDir, maxToolRounds: 1 });
  const tools = await eng.getToolRuntime();
  const raw = await tools.execute('grep_search', { pattern: 'm', path: 'custom-sub', limit: 10 });
  const result = unwrap(raw);

  assert.equal(result.shown, 10);
  assert.equal(result.total, 30);
});
