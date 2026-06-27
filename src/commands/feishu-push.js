/**
 * perseng feishu push 子命令 (Phase 4.2)
 *
 * 启动飞书主动推送调度器：
 *   - 读 config（jobs 列表或单 job CLI 参数）
 *   - 启动 FeishuAdapter（仅用于发消息，不需要收消息 handler）
 *   - 启动 FeishuPushScheduler
 *   - SIGINT/SIGTERM 优雅退出
 *
 * 用法：
 *   # 单 job（CLI 参数）
 *   perseng feishu push --cron "0 9 * * *" --chat oc_xxx --prompt "今日简报" --role jiangziya
 *
 *   # 批量 job（配置文件）
 *   perseng feishu push --config ./feishu-push.json
 *
 *   # 试运行（立即触发所有 job 一次，不进入调度循环）
 *   perseng feishu push --config ./feishu-push.json --dry-run
 */

import { FeishuAdapter } from '../feishu-adapter.js';
import { FeishuPushScheduler } from '../feishu-push-scheduler.js';
import { TaskEngine } from '../task-engine.js';
import { PersengError, ErrorCode } from '../errors.js';
import { getConfig } from '../config.js';
import { loadRole, resolveRoleWorkspace } from '../role-loader.js';
import { existsSync, readFileSync } from 'node:fs';

export async function feishuPushCommand(options = {}) {
  const config = getConfig();
  const roleId = options.role || config.role;
  const model = options.model || config.model;

  // 1. 凭据
  const appId = options.appId || config.feishuAppId || '';
  const appSecret = options.appSecret || config.feishuAppSecret || '';
  if (!appId || !appSecret) {
    throw new PersengError({
      code: ErrorCode.CONFIG_MISSING,
      message: 'FEISHU_APP_ID and FEISHU_APP_SECRET are required',
      userMessage: '需要配置飞书应用凭据（FEISHU_APP_ID / FEISHU_APP_SECRET）',
    });
  }

  // 2. jobs 加载
  let jobs = [];
  if (options.config) {
    if (!existsSync(options.config)) {
      throw new PersengError({
        code: ErrorCode.CONFIG_MISSING,
        message: `Config not found: ${options.config}`,
        userMessage: `配置文件不存在: ${options.config}`,
      });
    }
    try {
      const raw = readFileSync(options.config, 'utf8');
      const parsed = JSON.parse(raw);
      jobs = Array.isArray(parsed) ? parsed : (parsed.jobs || []);
    } catch (err) {
      throw new PersengError({
        code: ErrorCode.CONFIG_MISSING,
        message: `Failed to parse ${options.config}: ${err.message}`,
        userMessage: `配置文件解析失败: ${err.message}`,
      });
    }
  } else if (options.cron && options.chat && options.prompt) {
    // 单 job CLI 模式
    jobs = [{
      name: options.name || `cli-${options.chat}`,
      cron: options.cron,
      chatId: options.chat,
      prompt: options.prompt,
      role: roleId,
    }];
  } else {
    throw new PersengError({
      code: ErrorCode.CONFIG_MISSING,
      message: 'Either --config or (--cron + --chat + --prompt) is required',
      userMessage:
        '用法：\n' +
        '  perseng feishu push --config ./jobs.json\n' +
        '  perseng feishu push --cron "0 9 * * *" --chat oc_xxx --prompt "今日简报"',
    });
  }

  const logger = {
    info: (...args) => console.error('[push]', ...args),
    warn: (...args) => console.error('[push:warn]', ...args),
    error: (...args) => console.error('[push:error]', ...args),
  };

  const adapter = new FeishuAdapter({
    appId,
    appSecret,
    logger,
    botOpenId: config.feishuBotOpenId,
  });

  const engineFactory = (job) => {
    const effectiveRoleId = job.role || roleId;
    const role = loadRole(effectiveRoleId);
    return new TaskEngine({
      model,
      roleId: effectiveRoleId,
      cwd: resolveRoleWorkspace(role, process.cwd()),
    });
  };

  // 3. dry-run 模式：只触发一次，不进入调度循环
  if (options.dryRun) {
    logger.info(`dry-run: ${jobs.length} job(s)`);
    await adapter.start();
    const scheduler = new FeishuPushScheduler({ jobs, adapter, engineFactory, logger });
    for (const j of jobs) {
      try {
        await scheduler.fireNow(j.name);
      } catch (err) {
        logger.error(`job "${j.name}" failed: ${err.message}`);
      }
    }
    await adapter.stop();
    return { ok: true, jobs: scheduler.status() };
  }

  // 4. 正常模式
  const scheduler = new FeishuPushScheduler({ jobs, adapter, engineFactory, logger });

  // 优雅退出
  let shuttingDown = false;
  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${sig}, shutting down...`);
    try { await scheduler.stop(); } catch { /* */ }
    try { await adapter.stop(); } catch { /* */ }
    logger.info('bye');
    process.exit(0);
  }
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await adapter.start();
  scheduler.start();
  logger.info('push scheduler running (Ctrl+C to stop)');

  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  // resolve 后外层 shutdown 触发
}
