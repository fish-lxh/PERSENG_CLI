/**
 * M3 新增功能测试
 *
 * 覆盖：
 *   - MemoryStore 新增 API: forget / listEngrams / getEngram / getMemoryStats
 *   - BaseProvider / AnthropicProvider / OpenAIProvider 抽象
 *   - metrics 子命令（collectMetrics 内部）
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const tmpDir = mkdtempSync(join(tmpdir(), 'perseng-m3-'));
process.env.PERSENG_CLI_COGNITION_DIR = join(tmpDir, 'cognition');

const memoryStoreUrl = pathToFileURL(join(process.cwd(), 'src/cognition/MemoryStore.js')).href + `?t=${Date.now()}`;
const llmClientUrl = pathToFileURL(join(process.cwd(), 'src/llm-client.js')).href;
const baseProviderUrl = pathToFileURL(join(process.cwd(), 'src/llm-providers/BaseProvider.js')).href;
const metricsUrl = pathToFileURL(join(process.cwd(), 'src/commands/metrics.js')).href;

let memoryStore;
before(async () => {
  memoryStore = await import(memoryStoreUrl);
});

after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── MemoryStore 新 API ──────────────────────────────────────

test('MemoryStore: remember + recall + forget 闭环', async () => {
  const id1 = await memoryStore.remember('m3-tester', 'alpha bravo content', {
    schema: ['alpha', 'bravo'],
  });
  assert.ok(id1, '应返回 engram id');

  const recalled = await memoryStore.recall('m3-tester', 'alpha');
  assert.ok(recalled.length >= 1);
  assert.ok(recalled.some((e) => e.id === id1));

  // forget
  const result = await memoryStore.forget('m3-tester', id1);
  assert.equal(result.deleted, true);
  assert.equal(result.engramId, id1);

  // 再 recall 应找不到
  const after = await memoryStore.recall('m3-tester', 'alpha');
  assert.equal(after.length, 0, 'forget 后应无记忆');
});

test('MemoryStore: forget 不存在的 id 返回 deleted=false', async () => {
  const result = await memoryStore.forget('m3-tester', 'nonexistent-id-999');
  assert.equal(result.deleted, false);
});

test('MemoryStore: listEngrams 按 timestamp 倒序', async () => {
  await memoryStore.remember('m3-list', 'older content', { schema: ['older'] });
  await new Promise((r) => setTimeout(r, 10));
  await memoryStore.remember('m3-list', 'newer content', { schema: ['newer'] });

  const list = await memoryStore.listEngrams('m3-list', { limit: 10 });
  assert.ok(list.length >= 2);
  assert.ok(list[0].content.includes('newer'));
});

test('MemoryStore: listEngrams 支持 type 过滤', async () => {
  await memoryStore.remember('m3-type', 'atomic test', { schema: ['atomic'], type: 'ATOMIC' });
  await memoryStore.remember('m3-type', 'pattern test', { schema: ['pattern'], type: 'PATTERN' });

  const atomicOnly = await memoryStore.listEngrams('m3-type', { type: 'ATOMIC', limit: 100 });
  assert.ok(atomicOnly.every((e) => e.type === 'ATOMIC'));
});

test('MemoryStore: getEngram 返回完整详情', async () => {
  const id = await memoryStore.remember('m3-detail', 'detail test', { schema: ['detail'] });
  const detail = await memoryStore.getEngram('m3-detail', id);
  assert.ok(detail);
  assert.equal(detail.id, id);
  assert.equal(detail.content, 'detail test');
  assert.deepEqual(detail.schema, ['detail']);
});

test('MemoryStore: getMemoryStats 返回统计', async () => {
  // 用 bigram 重叠度低的内容（< 0.5），避免被 M4.2 jaccard 合并
  await memoryStore.remember('m3-stats', 'stats alpha count', { schema: ['s1'] });
  await memoryStore.remember('m3-stats', 'stats beta summary', { schema: ['s2'] });

  const stats = await memoryStore.getMemoryStats('m3-stats');
  assert.ok(stats);
  assert.equal(stats.roleId, 'm3-stats');
  assert.ok(stats.total >= 2);
  assert.ok(stats.dbSizeBytes > 0);
  assert.ok(stats.byStrength);
});

// ─── BaseProvider 抽象 ──────────────────────────────────────

test('BaseProvider: 子类必须实现 _initClient', async () => {
  const { BaseProvider } = await import(baseProviderUrl);
  const base = new BaseProvider();
  await assert.rejects(() => base._initClient(), /must be implemented/);
});

test('BaseProvider: 默认 capabilities 不含 toolUse / vision', async () => {
  const { BaseProvider } = await import(baseProviderUrl);
  const base = new BaseProvider();
  const caps = base.capabilities;
  assert.equal(caps.toolUse, false);
  assert.equal(caps.vision, false);
  assert.equal(caps.streaming, true);
});

test('AnthropicProvider: capabilities 含 toolUse / vision / thinking', async () => {
  const { AnthropicProvider } = await import(llmClientUrl);
  const p = new AnthropicProvider({ apiKey: 'test-key' });
  assert.equal(p.name, 'anthropic');
  assert.equal(p.capabilities.toolUse, true);
  assert.equal(p.capabilities.vision, true);
  assert.equal(p.capabilities.thinking, true);
});

test('OpenAIProvider: capabilities 含 toolUse / vision 不含 thinking', async () => {
  const { OpenAIProvider } = await import(llmClientUrl);
  const p = new OpenAIProvider({ apiKey: 'test-key' });
  assert.equal(p.name, 'openai');
  assert.equal(p.capabilities.toolUse, true);
  assert.equal(p.capabilities.vision, true);
  assert.equal(p.capabilities.thinking, false);
});

test('BaseProvider: translateError 转换 401 / 429', async () => {
  const { BaseProvider } = await import(baseProviderUrl);
  const base = new BaseProvider();

  const translated401 = base.translateError({ status: 401 });
  assert.equal(translated401.message, 'Authentication failed. Check your API key configuration.');

  const translated429 = base.translateError({ status: 429 });
  assert.equal(translated429.message, 'API rate limit exceeded.');
});

test('BaseProvider: sendToolResults 抛出未实现（subclass 重写）', async () => {
  const { BaseProvider } = await import(baseProviderUrl);
  const base = new BaseProvider();
  await assert.rejects(
    () => base.sendToolResults({ system: '', messages: [], tools: [], toolResults: [] }),
    /must be implemented/
  );
});

// ─── metrics 子命令 ──────────────────────────────────────────

test('metrics: collectMetrics 返回带时间戳的对象', async () => {
  const { collectMetrics } = await import(metricsUrl);
  const result = await collectMetrics();
  assert.ok(result.timestamp > 0);
  assert.ok(typeof result.metrics === 'object');
  assert.ok(result.metrics.promptx_info);
  assert.ok(result.metrics.promptx_uptime_seconds);
});

test('metrics: include 过滤指标', async () => {
  const { collectMetrics } = await import(metricsUrl);
  const result = await collectMetrics({ include: 'promptx_info,promptx_uptime_seconds' });
  assert.ok(result.metrics.promptx_info);
  assert.ok(result.metrics.promptx_uptime_seconds);
  assert.equal(result.metrics.promptx_memory_total, undefined);
});

test('metrics: 序列化为 Prometheus 格式', async () => {
  // 通过子命令入口触发一次 stdout 写入（捕获）
  const { metricsCommand } = await import(metricsUrl);
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    await metricsCommand({ format: 'prometheus' });
  } finally {
    process.stdout.write = origWrite;
  }
  const text = chunks.join('');
  assert.match(text, /# HELP perseng_info/);
  assert.match(text, /perseng_uptime_seconds /);
});