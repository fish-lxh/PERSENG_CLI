/**
 * 跨 agent 通信黑板 (Phase 5)
 *
 * 设计目标：
 *   - 6 个角色（jiangziya / nuwa / luban / hr / boduan / rotation）
 *     可以互通消息而不污染主会话上下文
 *   - 主会话只看到"有 N 条未读"，不看到正文
 *   - 消息正文只能通过 agent_inbox 工具主动拉取
 *
 * 存储：SQLite 单库（与 cognition 共用 better-sqlite3）
 * 位置：~/.perseng-cli/blackboard/blackboard.db
 *
 * 消息流向：
 *   - 私聊：to_role 字段
 *   - 广播频道：channel 字段（to_role 为 NULL）
 *   - 对话线程：conversation_id（双向回复追踪）
 *
 * 主会话隔离：
 *   - summaryForRole() 只返回计数
 *   - 工具调用结果不会进入 system prompt
 */

let BetterSqlite3 = null;
try {
  ({ default: BetterSqlite3 } = await import('better-sqlite3'));
} catch {
  BetterSqlite3 = null;
}

let SqlJs = null;
if (!BetterSqlite3) {
  const { default: initSqlJs } = await import('sql.js');
  SqlJs = await initSqlJs();
}

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getBlackboardDir } from './data-paths.js';

let _db = null;
let _dbPath = '';

function createSqlJsAdapter(dbPath) {
  const loadFile = () => {
    if (!existsSync(dbPath)) return null;
    const buf = readFileSync(dbPath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };

  const persist = (db) => {
    const bytes = db.export();
    writeFileSync(dbPath, Buffer.from(bytes));
  };

  const raw = loadFile();
  const db = raw ? new SqlJs.Database(raw) : new SqlJs.Database();

  const adapter = {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      return {
        get(...params) {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            const ok = stmt.step();
            return ok ? stmt.getAsObject() : undefined;
          } finally {
            try { stmt.free(); } catch { }
          }
        },
        all(...params) {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            const rows = [];
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
          } finally {
            try { stmt.free(); } catch { }
          }
        },
        run(...params) {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            stmt.step();
            const changes = db.getRowsModified();
            persist(db);
            const last = db.exec('SELECT last_insert_rowid() AS id');
            const lastInsertRowid = last?.[0]?.values?.[0]?.[0] ?? 0;
            return { changes, lastInsertRowid };
          } finally {
            try { stmt.free(); } catch { }
          }
        },
      };
    },
    close() {
      try { persist(db); } catch { }
      try { db.close(); } catch { }
    },
  };

  return adapter;
}

/**
 * 打开/复用单例 DB
 */
function getDb() {
  if (_db) return _db;
  const dir = getBlackboardDir();
  _dbPath = join(dir, 'blackboard.db');
  const db = BetterSqlite3
    ? new BetterSqlite3(_dbPath)
    : createSqlJsAdapter(_dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_role TEXT NOT NULL,
      to_role TEXT,
      channel TEXT,
      conversation_id TEXT,
      subject TEXT,
      body TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_role, read_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_outbox ON messages(from_role, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_channel ON messages(channel, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_conversation ON messages(conversation_id, created_at);
  `);
  _db = db;
  return _db;
}

/**
 * 重置（仅测试用）
 */
export function resetBlackboard() {
  if (_db) {
    try { _db.close(); } catch { /* */ }
    _db = null;
  }
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    from: row.from_role,
    to: row.to_role,
    channel: row.channel,
    conversationId: row.conversation_id,
    subject: row.subject,
    body: row.body,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/**
 * 发私聊 / 频道消息
 * @param {object} msg
 * @param {string} msg.from - 发送方 roleId
 * @param {string} [msg.to] - 接收方 roleId（私聊）
 * @param {string} [msg.channel] - 频道名（频道消息；与 to 互斥）
 * @param {string} [msg.conversationId] - 对话 thread id
 * @param {string} [msg.subject] - 主题（可选）
 * @param {string} msg.body - 正文
 * @param {object} [msg.metadata] - 任意元数据
 * @returns {Message}
 */
export function sendMessage(msg) {
  if (!msg?.from) throw new Error('BlackboardStore.sendMessage: from is required');
  if (!msg?.body) throw new Error('BlackboardStore.sendMessage: body is required');
  if (!msg.to && !msg.channel) {
    throw new Error('BlackboardStore.sendMessage: either to or channel is required');
  }
  if (msg.to && msg.channel) {
    throw new Error('BlackboardStore.sendMessage: to and channel are mutually exclusive');
  }

  const db = getDb();
  const createdAt = Date.now();

  // ── 关键修复：首发消息若未指定 conversationId，自动用自身 id 作为 thread 标识
  //    这样后续 replyToConversation 用 firstId 作为 conversationId 时，能 join 上 root
  let conversationId = msg.conversationId || null;
  if (!conversationId) {
    // 先插入，拿 lastInsertRowid 作 conversationId
    const stmt = db.prepare(`
      INSERT INTO messages (from_role, to_role, channel, conversation_id, subject, body, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      msg.from,
      msg.to || null,
      msg.channel || null,
      null, // 临时为 null，等拿到 id 再 UPDATE
      msg.subject || null,
      msg.body,
      msg.metadata ? JSON.stringify(msg.metadata) : null,
      createdAt,
    );
    const newId = result.lastInsertRowid;
    // 自引用：把 conversation_id 设为自己的 id
    db.prepare(`UPDATE messages SET conversation_id = ? WHERE id = ?`).run(String(newId), newId);
    return getMessageById(newId);
  }

  // 续接 thread 的情况
  const stmt = db.prepare(`
    INSERT INTO messages (from_role, to_role, channel, conversation_id, subject, body, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    msg.from,
    msg.to || null,
    msg.channel || null,
    conversationId,
    msg.subject || null,
    msg.body,
    msg.metadata ? JSON.stringify(msg.metadata) : null,
    createdAt,
  );
  return getMessageById(result.lastInsertRowid);
}

/**
 * 群发到指定 receivers（不通过 channel 机制）
 */
export function sendToMany(from, receivers, body, opts = {}) {
  const ids = [];
  for (const to of receivers) {
    const m = sendMessage({ from, to, body, ...opts });
    ids.push(m.id);
  }
  return ids;
}

/**
 * 读取消息
 */
export function getMessageById(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  return rowToMessage(row);
}

/**
 * 收件箱（to_role = roleId）
 * @param {string} roleId
 * @param {object} [options]
 * @param {boolean} [options.unreadOnly=false]
 * @param {number} [options.limit=20]
 * @returns {Message[]}
 */
export function inbox(roleId, options = {}) {
  if (!roleId) return [];
  const db = getDb();
  const unreadOnly = options.unreadOnly !== false ? true : false;  // 默认只显示未读
  const limit = Math.min(options.limit || 20, 200);
  const where = unreadOnly
    ? 'WHERE to_role = ? AND read_at IS NULL'
    : 'WHERE to_role = ?';
  const rows = db.prepare(`
    SELECT * FROM messages ${where}
    ORDER BY created_at DESC LIMIT ?
  `).all(roleId, limit);
  return rows.map(rowToMessage);
}

/**
 * 发件箱（from_role = roleId）
 */
export function outbox(roleId, options = {}) {
  if (!roleId) return [];
  const db = getDb();
  const limit = Math.min(options.limit || 20, 200);
  const rows = db.prepare(`
    SELECT * FROM messages WHERE from_role = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(roleId, limit);
  return rows.map(rowToMessage);
}

/**
 * 标记消息已读
 */
export function markRead(messageIds, roleId) {
  if (!Array.isArray(messageIds) || messageIds.length === 0) return 0;
  const db = getDb();
  const placeholders = messageIds.map(() => '?').join(',');
  const stmt = db.prepare(`
    UPDATE messages SET read_at = ?
    WHERE id IN (${placeholders}) AND to_role = ? AND read_at IS NULL
  `);
  const result = stmt.run(Date.now(), ...messageIds, roleId);
  return result.changes || 0;
}

/**
 * 标记 role 的所有收件箱已读
 */
export function markAllRead(roleId) {
  if (!roleId) return 0;
  const db = getDb();
  const result = db.prepare(`
    UPDATE messages SET read_at = ?
    WHERE to_role = ? AND read_at IS NULL
  `).run(Date.now(), roleId);
  return result.changes || 0;
}

/**
 * 未读计数
 */
export function unreadCount(roleId) {
  if (!roleId) return 0;
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM messages
    WHERE to_role = ? AND read_at IS NULL
  `).get(roleId);
  return row?.c || 0;
}

/**
 * 频道历史
 */
export function channelHistory(channel, options = {}) {
  if (!channel) return [];
  const db = getDb();
  const limit = Math.min(options.limit || 20, 200);
  let where = 'WHERE channel = ?';
  const params = [channel];
  if (options.since) {
    where += ' AND created_at > ?';
    params.push(options.since);
  }
  const rows = db.prepare(`
    SELECT * FROM messages ${where}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params, limit);
  return rows.map(rowToMessage);
}

/**
 * 列出所有频道（最近活跃）
 */
export function listChannels() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT channel, COUNT(*) AS message_count, MAX(created_at) AS last_at
    FROM messages
    WHERE channel IS NOT NULL
    GROUP BY channel
    ORDER BY last_at DESC
  `).all();
  return rows.map((r) => ({
    name: r.channel,
    messageCount: r.message_count,
    lastMessageAt: r.last_at,
  }));
}

/**
 * 会话线程
 */
export function conversation(conversationId) {
  if (!conversationId) return [];
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC
  `).all(conversationId);
  return rows.map(rowToMessage);
}

/**
 * 续接某个对话（自动沿 conversation_id 回复）
 */
export function replyToConversation({ from, conversationId, body, metadata }) {
  // 找到原 thread 的初始消息
  const db = getDb();
  const root = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ?
    ORDER BY created_at ASC LIMIT 1
  `).get(conversationId);
  if (!root) {
    throw new Error(`BlackboardStore.replyToConversation: conversation "${conversationId}" not found`);
  }
  return sendMessage({
    from,
    to: root.to_role === from ? root.from_role : root.to_role,
    body,
    conversationId,
    metadata,
  });
}

/**
 * 为主会话生成隔离摘要（不暴露正文）
 * 用法：在 system prompt 里注入这段
 */
export function summaryForRole(roleId) {
  if (!roleId) return '';
  const unread = unreadCount(roleId);
  if (unread === 0) return '';
  return `## 你的收件箱\n你有 ${unread} 条未读消息。\n（如需查看正文，请调用 agent_inbox 工具）`;
}

/**
 * 关闭数据库
 */
export function closeBlackboard() {
  if (_db) {
    try { _db.close(); } catch { /* */ }
    _db = null;
  }
}
