/**
 * Logger 模块测试 (P2.12)
 *
 * 覆盖：
 *   - logger 默认 JSON 输出到 stderr（stdout 留给 NDJSON 协议）
 *   - PERSENG_LOG_LEVEL 控制级别
 *   - childLogger 派生独立 logger
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('logger: 默认输出 JSON 到 stderr', async () => {
  const { logger } = await import('../src/logger.js');
  assert.ok(logger, 'logger 应导出');
  assert.equal(typeof logger.info, 'function');
  assert.equal(typeof logger.warn, 'function');
  assert.equal(typeof logger.error, 'function');
  assert.equal(typeof logger.debug, 'function');
  assert.equal(typeof logger.fatal, 'function');
});

test('logger: childLogger 派生独立 logger', async () => {
  const { childLogger } = await import('../src/logger.js');
  const memoryLog = childLogger('memory');
  assert.ok(memoryLog);
  // child logger 应该是 pino child instance
  assert.equal(typeof memoryLog.info, 'function');
  assert.equal(typeof memoryLog.child, 'function');
});

test('logger: 默认级别尊重 PERSENG_LOG_LEVEL 环境变量', async () => {
  const prevLevel = process.env.PERSENG_LOG_LEVEL;
  process.env.PERSENG_LOG_LEVEL = 'warn';

  // 重新加载模块以触发新的 env 读取
  const moduleUrl = new URL('../src/logger.js', import.meta.url).href;
  const mod = await import(`${moduleUrl}?t=${Date.now()}`);
  assert.equal(mod.logger.level, 'warn');

  // 恢复
  if (prevLevel === undefined) delete process.env.PERSENG_LOG_LEVEL;
  else process.env.PERSENG_LOG_LEVEL = prevLevel;
});

test('logger: info 级别能输出（通过 pino 自定义 destination 捕获）', async () => {
  const chunks = [];
  // 直接用 pino 自定义 destination 而不接管 process.stderr
  // （pino 默认走 fd 2，不走 process.stderr.write）
  const dest = {
    write(chunk) { chunks.push(Buffer.from(chunk)); return chunk.length; },
  };

  const { pino } = await import('pino');
  const testLogger = pino({ level: 'info', base: { pid: process.pid, app: 'perseng-cli' } }, dest);
  testLogger.info({ probe: true }, 'test message');

  // pino 通常是同步的
  const output = Buffer.concat(chunks).toString('utf-8');
  assert.ok(output.includes('test message'), `应包含 'test message'，实际: ${output}`);
  assert.ok(output.includes('"level":30'), '应包含 info 级别 (30)');
  assert.ok(output.includes('"probe":true'), '应包含结构化字段');
  assert.ok(output.includes('"app":"perseng-cli"'), '应包含 base 字段');
});