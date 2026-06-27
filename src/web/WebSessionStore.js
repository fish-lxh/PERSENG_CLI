/**
 * WebSessionStore — WebUI 多会话存储
 *
 * 借鉴 src/feishu-session-store.js 的设计（LRU + 空闲回收 sweep + evict），
 * 但不复用——factory 签名、session 字段、持久化策略均不同：
 *   - key: tabId (UUID v4) — 由前端 sessionStorage 生成
 *   - session 字段精简为: { tabId, roleId, taskEngine, history, lastActiveAt, startedAt, abortCtl }
 *   - 容量上限 20（浏览器用户数远少于飞书）
 *
 * 角色切换：
 *   TaskEngine.roleId 是 constructor-only（src/task-engine.js:20），
 *   set_role 必须 evict(tabId) + getOrCreate(tabId, newRole) 重建 engine。
 */

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000; // 30 分钟
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 分钟

export class WebSessionStore {
  /**
   * @param {object} options
   * @param {number} [options.maxSessions=20]
   * @param {number} [options.idleTimeoutMs=30*60_000]
   * @param {number} [options.sweepIntervalMs=5*60_000]
   * @param {(tabId: string, roleId: string) => object} options.engineFactory
   *   - 必须返回一个具备 run(task, context) 方法的对象（通常是 TaskEngine 实例）
   */
  constructor(options = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.engineFactory = options.engineFactory;

    if (typeof this.engineFactory !== 'function') {
      throw new Error('WebSessionStore: engineFactory is required');
    }

    /** @type {Map<string, object>} */
    this.sessions = new Map();
    this._sweepTimer = null;
  }

  /** 启动空闲回收定时器 */
  startSweep() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this._sweepTimer.unref?.();
  }

  /** 停止回收定时器（仅在进程退出前调用） */
  stopSweep() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  /**
   * 获取或创建会话。
   * @param {string} tabId
   * @param {string} roleId
   * @returns {object} session
   */
  getOrCreate(tabId, roleId) {
    const existing = this.sessions.get(tabId);
    if (existing) {
      // LRU：删除后重新插入到 Map 末尾
      this.sessions.delete(tabId);
      existing.lastActiveAt = new Date();
      this.sessions.set(tabId, existing);
      return existing;
    }

    const session = {
      tabId,
      roleId,
      taskEngine: this.engineFactory(tabId, roleId),
      history: [], // {role, content, ts}[]
      lastActiveAt: new Date(),
      startedAt: new Date(),
      abortCtl: null,
    };

    // LRU 容量控制
    if (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey !== undefined) {
        const old = this.sessions.get(oldestKey);
        old.abortCtl?.abort('evicted by LRU');
        this.sessions.delete(oldestKey);
      }
    }

    this.sessions.set(tabId, session);
    return session;
  }

  /**
   * 获取会话（不创建）
   * @param {string} tabId
   */
  get(tabId) {
    return this.sessions.get(tabId);
  }

  /**
   * 显式移除会话（取消任务 + 释放）
   * @param {string} tabId
   */
  evict(tabId) {
    const s = this.sessions.get(tabId);
    if (!s) return false;
    s.abortCtl?.abort('evicted');
    this.sessions.delete(tabId);
    return true;
  }

  /**
   * 切换角色：evict(tabId) + getOrCreate(tabId, newRole)
   * 任何 in-flight 任务都会被 abort（context 丢失）。
   * @param {string} tabId
   * @param {string} roleId
   */
  setRole(tabId, roleId) {
    this.evict(tabId);
    return this.getOrCreate(tabId, roleId);
  }

  /**
   * 列出所有会话（用于 /sessions HTTP 端点）
   */
  allSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      tabId: s.tabId,
      roleId: s.roleId,
      lastActiveAt: s.lastActiveAt.toISOString(),
      startedAt: s.startedAt.toISOString(),
      historyCount: s.history.length,
    }));
  }

  /**
   * 空闲回收
   * @returns {number} 被回收的数量
   */
  sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [tabId, s] of this.sessions) {
      if (now - s.lastActiveAt.getTime() > this.idleTimeoutMs) {
        s.abortCtl?.abort('idle timeout');
        this.sessions.delete(tabId);
        removed++;
      }
    }
    return removed;
  }

  /** 全部清空（进程退出时调用） */
  clear() {
    for (const s of this.sessions.values()) {
      s.abortCtl?.abort('shutdown');
    }
    this.sessions.clear();
  }

  get size() {
    return this.sessions.size;
  }
}
