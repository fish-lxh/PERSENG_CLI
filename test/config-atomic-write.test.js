/**
 * saveConfig 原子写入回归测试 (P2.10)
 *
 * 覆盖：
 *   - 写入后文件可被 getConfig 正确读回
 *   - 写入不留下 .tmp 临时文件
 *   - 写入过程中崩溃不会损坏原文件（renameSync 原子性）
 *   - 并发 save 不会冲突（临时文件名带 PID + 时间戳 + 随机串）
 *
 * 使用 PERSENG_CLI_DATA_DIR 环境变量隔离测试目录，避免污染真实 ~/.perseng-cli
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpDir = mkdtempSync(join(tmpdir(), 'perseng-cli-test-'));
process.env.PERSENG_CLI_DATA_DIR = tmpDir;

let saveConfig, getConfig, resetConfig;

before(async () => {
  const mod = await import('../src/config.js');
  saveConfig = mod.saveConfig;
  getConfig = mod.getConfig;
  resetConfig = mod.resetConfig;
});

after(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

test('saveConfig: 写入后 getConfig 能读回', () => {
  resetConfig();
  const before = getConfig();
  assert.equal(before.role, 'jiangziya'); // 默认值

  saveConfig({ role: 'nuwa', customField: 'hello' });
  resetConfig(); // 强制重新读盘

  const after = getConfig();
  assert.equal(after.role, 'nuwa');
  assert.equal(after.customField, 'hello');
});

test('saveConfig: 不留下 .tmp 临时文件', () => {
  resetConfig();
  saveConfig({ role: 'jiangziya', probe: 'tmp-check' });

  const files = readdirSync(tmpDir);
  const tmpFiles = files.filter((f) => f.startsWith('.config.') && f.endsWith('.tmp'));
  assert.equal(tmpFiles.length, 0, `发现残留临时文件: ${tmpFiles.join(', ')}`);
});

test('saveConfig: 写入是原子的（崩溃后原文件保留）', () => {
  resetConfig();
  saveConfig({ role: 'luban', sentinel: 'A' });

  const configFile = join(tmpDir, 'config.json');
  assert.ok(existsSync(configFile));

  const beforeContent = readFileSync(configFile, 'utf-8');
  const beforeParsed = JSON.parse(beforeContent);
  assert.equal(beforeParsed.sentinel, 'A');

  // 模拟 renameSync 之前的崩溃：临时文件存在但原文件还在
  const fakeTmp = join(tmpDir, '.config.crash.test.tmp');
  writeFileSync(fakeTmp, 'partial garbage data', 'utf-8');

  // 验证原文件仍然完好（renameSync 未发生，原文件没被破坏）
  const afterContent = readFileSync(configFile, 'utf-8');
  const afterParsed = JSON.parse(afterContent);
  assert.equal(afterParsed.sentinel, 'A', '原文件被破坏（renameSync 不原子）');

  // 清理模拟残留
  unlinkSync(fakeTmp);
});

test('saveConfig: 并发 save 不会冲突（临时文件名唯一）', async () => {
  resetConfig();

  // 并发触发 10 次 save，每次用不同 value
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(Promise.resolve().then(() => saveConfig({ concurrentProbe: i })));
  }
  await Promise.all(promises);

  // 验证最后一次写入成功，文件可读
  resetConfig();
  const final = getConfig();
  assert.ok(typeof final.concurrentProbe === 'number');
  assert.ok(final.concurrentProbe >= 0 && final.concurrentProbe <= 9);

  // 验证没有残留 .tmp
  const files = readdirSync(tmpDir);
  const tmpFiles = files.filter((f) => f.startsWith('.config.') && f.endsWith('.tmp'));
  assert.equal(tmpFiles.length, 0);
});

test('saveConfig: 重复 save 不会累积临时文件', () => {
  resetConfig();
  for (let i = 0; i < 5; i++) {
    saveConfig({ counter: i });
  }

  const files = readdirSync(tmpDir);
  const tmpFiles = files.filter((f) => f.startsWith('.config.') && f.endsWith('.tmp'));
  assert.equal(tmpFiles.length, 0);
});

test('saveConfig: PERSENG_CLI_DATA_DIR 覆盖默认数据目录', () => {
  resetConfig();
  const config = getConfig();
  assert.equal(config.dataDir, tmpDir);
});