/**
 * perseng feishu-multi 子命令 (Phase 4.3)
 *
 * 启动多个飞书 bot（不同 appId/角色/白名单）共享一个进程。
 * 每个 tenant 独立 adapter / session store / role；
 * 错误隔离：单个 tenant 启动失败不影响其他。
 *
 * 用法：
 *   perseng feishu-multi --config ./feishu-tenants.json
 *
 * 配置文件格式（feishu-tenants.json）：
 *   [
 *     {
 *       "name": "team-a",
 *       "appId": "cli_xxx",
 *       "appSecret": "xxx",
 *       "role": "jiangziya",
 *       "model": "claude-sonnet-4-20250514",
 *       "allowUsers": ["u1", "u2"],
 *       "allowGroups": []
 *     },
 *     {
 *       "name": "team-b",
 *       "appId": "cli_yyy",
 *       "appSecret": "yyy",
 *       "role": "shenxiaobao"
 *     }
 *   ]
 *
 * 环境变量覆盖（每 tenant 都用）：
 *   PERSENG_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
 */

import { startFeishuBot } from '../feishu-bot-runner.js';
import { PersengError, ErrorCode } from '../errors.js';
import { existsSync, readFileSync } from 'node:fs';

export async function feishuMultiCommand(options = {}) {
  if (!options.config) {
    throw new PersengError({
      code: ErrorCode.CONFIG_MISSING,
      message: '--config is required',
      userMessage:
        '用法：perseng feishu-multi --config ./feishu-tenants.json\n' +
        '参考 examples/feishu-tenants.json 配置。',
    });
  }
  if (!existsSync(options.config)) {
    throw new PersengError({
      code: ErrorCode.CONFIG_MISSING,
      message: `Config not found: ${options.config}`,
      userMessage: `配置文件不存在: ${options.config}`,
    });
  }

  let tenants;
  try {
    const raw = readFileSync(options.config, 'utf8');
    const parsed = JSON.parse(raw);
    tenants = Array.isArray(parsed) ? parsed : (parsed.tenants || []);
  } catch (err) {
    throw new PersengError({
      code: ErrorCode.CONFIG_MISSING,
      message: `Failed to parse ${options.config}: ${err.message}`,
      userMessage: `配置文件解析失败: ${err.message}`,
    });
  }

  if (!tenants.length) {
    throw new PersengError({
      code: ErrorCode.CONFIG_MISSING,
      message: 'No tenants in config',
      userMessage: '配置文件中没有 tenant。',
    });
  }

  const logger = {
    info: (...args) => console.error('[multi]', ...args),
    warn: (...args) => console.error('[multi:warn]', ...args),
    error: (...args) => console.error('[multi:error]', ...args),
  };

  // 启动每个 tenant；错误隔离
  const handles = [];
  const started = [];
  const failed = [];

  for (const tenant of tenants) {
    const name = tenant.name || tenant.appId?.slice(0, 8) || '?';
    try {
      logger.info(`starting tenant "${name}"...`);
      const handle = await startFeishuBot({
        name,
        appId: tenant.appId,
        appSecret: tenant.appSecret,
        role: tenant.role || 'jiangziya',
        model: tenant.model,
        allowUsers: tenant.allowUsers,
        allowGroups: tenant.allowGroups,
        taskTimeoutMs: tenant.taskTimeoutMs,
        botOpenId: tenant.botOpenId,
        logger,
      });
      handles.push(handle);
      started.push(name);
    } catch (err) {
      logger.error(`tenant "${name}" failed to start: ${err.message}`);
      failed.push({ name, error: err.message });
    }
  }

  logger.info(`started ${started.length}/${tenants.length} tenants: ${started.join(', ')}`);
  if (failed.length > 0) {
    logger.warn(`failed tenants: ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`);
  }

  if (handles.length === 0) {
    throw new PersengError({
      code: ErrorCode.CONFIG_MISSING,
      message: 'No tenants started',
      userMessage: '所有 tenant 启动失败，请检查配置。',
    });
  }

  // 优雅退出：所有 handle 一起停
  let shuttingDown = false;
  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${sig}, stopping ${handles.length} tenant(s)...`);
    await Promise.allSettled(handles.map((h) => h.stop()));
    logger.info('all tenants stopped');
    process.exit(0);
  }
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
}
