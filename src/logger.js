/**
 * 结构化日志 (P2.12)
 *
 * 关键约束：
 *   - 日志一律写 **stderr**，stdout 留给 NDJSON 协议输出（serve / run --output-format json）
 *   - 默认 JSON 格式（便于日志聚合：Loki / ELK / Datadog 等）
 *   - PERSENG_LOG_LEVEL=trace|debug|info|warn|error|fatal 控制级别
 *   - PERSENG_LOG_PRETTY=1 切换人类可读格式（开发时用）
 *   - 子模块用 child logger: logger.child({ module: 'memory' })
 */

import { pino } from 'pino';
import { getConfig } from './config.js';

const config = getConfig();
const level = config.logLevel;

const baseOptions = {
  level,
  base: {
    pid: process.pid,
    app: 'perseng-cli',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const transport = config.logPretty
  ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } }
  : undefined;

export const logger = pino(transport ? { ...baseOptions, transport } : baseOptions);

/**
 * 为子模块派生 child logger
 * @param {string} module 模块名（如 'memory' / 'rolex' / 'feishu'）
 * @returns {import('pino').Logger}
 */
export function childLogger(module) {
  return logger.child({ module });
}

export default logger;
