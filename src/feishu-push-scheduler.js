/**
 * 飞书主动推送调度器 (Phase 4.2)
 *
 * 设计：
 *   - 每个 push job 独立 cron
 *   - 每 30s 检查一次：是否到点
 *   - 触发时构造 task，调 TaskEngine 拿结果，主动发到指定 chat
 *   - 任务不阻塞主调度循环（每条消息并行）
 *
 * 配置示例（feishu-push.json）：
 *   [
 *     { "name": "morning_report", "cron": "0 9 * * *", "chatId": "oc_xxx", "prompt": "请生成今日简报", "role": "jiangziya" },
 *     { "name": "evening_summary", "cron": "0 18 * * 1-5", "chatId": "oc_yyy", "prompt": "今天的工作总结" }
 *   ]
 *
 * 用法：
 *   const scheduler = new FeishuPushScheduler({ jobs, adapter, engineFactory, logger });
 *   scheduler.start();
 *   // 停止：scheduler.stop()
 */

import cronParser from 'cron-parser';

const TICK_INTERVAL_MS = 30_000;  // 检查周期

export class FeishuPushScheduler {
  /**
   * @param {object} options
   * @param {Array} options.jobs - push job 列表
   * @param {object} options.adapter - FeishuAdapter 实例（已 start）
   * @param {function} options.engineFactory - (job) => TaskEngine 实例
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    if (!options.adapter) throw new Error('FeishuPushScheduler: adapter is required');
    if (typeof options.engineFactory !== 'function') {
      throw new Error('FeishuPushScheduler: engineFactory must be a function');
    }
    this.adapter = options.adapter;
    this.engineFactory = options.engineFactory;
    this.logger = options.logger || console;
    this.jobs = (options.jobs || []).map((j) => this._normalizeJob(j));
    this._timer = null;
    this._inflight = new Set();
    this._running = false;
  }

  /**
   * 校验并补全 job 字段；为每个 job 算 nextRun
   */
  _normalizeJob(job) {
    if (!job?.name) throw new Error('push job missing name');
    if (!job?.cron) throw new Error(`push job "${job.name}" missing cron`);
    if (!job?.chatId) throw new Error(`push job "${job.name}" missing chatId`);
    if (!job?.prompt) throw new Error(`push job "${job.name}" missing prompt`);

    // 预解析 cron
    try {
      const it = cronParser.parseExpression(job.cron, { currentDate: new Date() });
      const next = it.next();
      return {
        name: job.name,
        cron: job.cron,
        chatId: job.chatId,
        prompt: job.prompt,
        role: job.role || 'jiangziya',
        nextRunAt: next.toDate(),
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
      };
    } catch (err) {
      throw new Error(`push job "${job.name}" invalid cron "${job.cron}": ${err.message}`);
    }
  }

  /**
   * 启动调度循环
   */
  start() {
    if (this._running) return;
    this._running = true;
    this.logger.info?.(`[push] scheduler started, ${this.jobs.length} job(s)`);
    for (const j of this.jobs) {
      this.logger.info?.(`[push] job "${j.name}" cron="${j.cron}" next=${j.nextRunAt.toISOString()}`);
    }
    this._timer = setInterval(() => this._tick().catch((e) => {
      this.logger.error?.(`[push] tick error: ${e.message}`);
    }), TICK_INTERVAL_MS);
  }

  /**
   * 停止调度
   */
  async stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    // 等所有 inflight 完成
    if (this._inflight.size > 0) {
      await Promise.allSettled([...this._inflight]);
    }
    this.logger.info?.('[push] scheduler stopped');
  }

  /**
   * 每 30s 检查一次；到点的 job 触发
   */
  async _tick() {
    const now = new Date();
    for (const job of this.jobs) {
      if (now < job.nextRunAt) continue;
      if (this._inflight.has(job.name)) continue;  // 上一轮还没跑完
      this._fireJob(job, now);
    }
  }

  /**
   * 触发一个 job（不 await，让 inflight 集合管理并发）
   */
  _fireJob(job, now) {
    // 立即算下一次执行时间（避免重入）
    try {
      const it = cronParser.parseExpression(job.cron, { currentDate: now });
      job.nextRunAt = it.next().toDate();
    } catch (err) {
      this.logger.error?.(`[push] job "${job.name}" cron reparse failed: ${err.message}`);
      return;
    }

    const promise = this._runJob(job).catch((err) => {
      this.logger.error?.(`[push] job "${job.name}" failed: ${err.message}`);
    });
    this._inflight.add(job.name);
    promise.finally(() => { this._inflight.delete(job.name); });
  }

  /**
   * 实际执行：调 engine → 发到 chat
   */
  async _runJob(job) {
    this.logger.info?.(`[push] firing job "${job.name}" → chat ${job.chatId}`);
    job.lastRunAt = new Date();
    try {
      const engine = this.engineFactory(job);
      const result = await engine.run(job.prompt, { roleId: job.role });
      await this.adapter.replyTextOrCard(job.chatId, result);
      job.lastStatus = 'ok';
      job.lastError = null;
      this.logger.info?.(`[push] job "${job.name}" sent ${result.length} chars`);
    } catch (err) {
      job.lastStatus = 'error';
      job.lastError = err.message;
      // 错误也尝试通知用户
      try {
        await this.adapter.replyText(job.chatId, `❌ [定时任务 ${job.name}] 失败: ${err.message}`);
      } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * 手动触发一次（测试用 / Webhook 触发）
   */
  async fireNow(name) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) throw new Error(`push job "${name}" not found`);
    return this._runJob(job);
  }

  /**
   * 查看所有 job 状态
   */
  status() {
    return this.jobs.map((j) => ({
      name: j.name,
      cron: j.cron,
      chatId: j.chatId,
      role: j.role,
      nextRunAt: j.nextRunAt,
      lastRunAt: j.lastRunAt,
      lastStatus: j.lastStatus,
      lastError: j.lastError,
    }));
  }
}
