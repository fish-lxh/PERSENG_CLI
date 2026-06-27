/**
 * 飞书会话存储 (Phase 1)
 *
 * 职责：
 *   - 按 chatId 缓存 Session（包含独立 TaskEngine 实例）
 *   - LRU 淘汰（默认 50 个会话上限）
 *   - 空闲回收（默认 30 分钟无活动清理）
 *   - v1 仅内存存储；Phase 2 升级到 SQLite 持久化
 */

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;   // 30 分钟
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;   // 5 分钟扫一次

export class FeishuSessionStore {
  /**
   * @param {object} options
   * @param {number} [options.maxSessions=50]
   * @param {number} [options.idleTimeoutMs=30*60_000]
   * @param {number} [options.sweepIntervalMs=5*60_000]
   * @param {function} [options.engineFactory] - (chatId, roleId) => TaskEngine 实例
   */
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.engineFactory = options.engineFactory || null;

    /** @type {Map<string, import('./feishu-session-store.js').Session>} */
    this.sessions = new Map();

    this._sweepTimer = null;
  }

  /**
   * 启动空闲回收定时器（需在 main 进程里调一次）
   */
  startSweep() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    // unref 防止它阻止进程退出
    this._sweepTimer.unref?.();
  }

  /**
   * 停止回收定时器
   */
  stopSweep() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  /**
   * 获取或创建会话
   * @param {string} chatId
   * @param {'p2p'|'group'} chatType
   * @param {string} roleId
   * @param {object} [opts]
   * @param {string} [opts.senderId] - 触发消息的 user
   * @returns {Session}
   */
  getOrCreate(chatId, chatType, roleId, opts = {}) {
    let s = this.sessions.get(chatId);
    if (s) {
      // LRU 标记：删除后重新插入到 Map 末尾（Map 保持插入顺序）
      this.sessions.delete(chatId);
      s.lastActiveAt = new Date();
      if (opts.senderId) s.senderId = opts.senderId;
      this.sessions.set(chatId, s);
      return s;
    }

    if (!this.engineFactory) {
      throw new Error('FeishuSessionStore: engineFactory is required');
    }

    s = {
      chatId,
      chatType,
      senderId: opts.senderId || '',
      roleId,
      taskEngine: this.engineFactory(chatId, roleId),
      history: [],         // {role, content, ts}[]
      lastActiveAt: new Date(),
      startedAt: new Date(),  // 会话首次消息时间，用于注入时间上下文
      abortCtl: null,      // 当前任务的 AbortController
      pendingReply: null,
    };

    // LRU 容量控制
    if (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) {
        const old = this.sessions.get(oldestKey);
        // 取消正在跑的任务（如果有）
        old.abortCtl?.abort('evicted by LRU');
        this.sessions.delete(oldestKey);
      }
    }

    this.sessions.set(chatId, s);
    return s;
  }

  /**
   * 获取会话（不创建）
   * @param {string} chatId
   * @returns {Session|undefined}
   */
  get(chatId) {
    return this.sessions.get(chatId);
  }

  /**
   * 显式移除会话（取消任务 + 释放）
   * @param {string} chatId
   */
  evict(chatId) {
    const s = this.sessions.get(chatId);
    if (!s) return false;
    s.abortCtl?.abort('evicted');
    this.sessions.delete(chatId);
    return true;
  }

  /**
   * 列出所有会话
   */
  allSessions() {
    return Array.from(this.sessions.values());
  }

  /**
   * 空闲回收：扫描并移除 idle 超时的会话
   * @returns {number} 被回收的数量
   */
  sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [chatId, s] of this.sessions) {
      if (now - s.lastActiveAt.getTime() > this.idleTimeoutMs) {
        s.abortCtl?.abort('idle timeout');
        this.sessions.delete(chatId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 全部清空（进程退出时调用）
   */
  clear() {
    for (const s of this.sessions.values()) {
      s.abortCtl?.abort('shutdown');
    }
    this.sessions.clear();
  }

  /**
   * 当前会话数
   */
  get size() {
    return this.sessions.size;
  }
}

/**
 * @typedef {object} Session
 * @property {string} chatId
 * @property {'p2p'|'group'} chatType
 * @property {string} senderId
 * @property {string} roleId
 * @property {object} taskEngine
 * @property {Array<{role: string, content: string, ts: string}>} history
 * @property {Date} lastActiveAt
 * @property {Date} startedAt
 * @property {AbortController|null} abortCtl
 * @property {Promise<void>|null} pendingReply
 */
