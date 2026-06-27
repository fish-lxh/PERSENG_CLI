import { getConfig } from './config.js';

/**
 * 飞书适配器 (Phase 1)
 *
 * 设计原则：
 *   - 通过动态 import 加载 @larksuiteoapi/node-sdk，避免硬依赖
 *   - lark 模块可通过构造函数注入（测试用 mock）
 *   - 消息解析逻辑与 SDK 解耦（parseMessage 是纯函数，可独立测）
 *   - 回复接口最小化：replyText + replyCard
 *
 * 不支持（v1）：
 *   - 文件/图片/语音消息（统一回复"暂不支持"）
 *
 * Phase 3 lite 新增：
 *   - 流式更新（updateMessage — im.message.update）
 */

const FEISHU_MSG_TYPE_TEXT = 'text';
const FEISHU_CHAT_TYPE_GROUP = 'group';

// ─── 回复去重配置（默认） ──────────────────────────────────────────
const DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000;  // 5 分钟
const DEFAULT_DEDUP_MAX_ENTRIES = 20;        // 每个 chat 最多缓存 20 条指纹
const DEDUP_MIN_LEN = 20;                    // 短文本（如 "好的"、"收到"）不去重
const ECHO_PREFIX_MATCH_LEN = 100;           // 用户消息前 100 字参与 echo 检测
const ECHO_MIN_RATIO = 0.6;                  // 回复前缀 ≥ 60% 等于用户输入 → 视为 echo

/**
 * 简易指纹函数（djb2 变种）：normalize + 取前 200 字符 + 哈希到 32-bit 无符号
 * 不追求加密强度，只求短文本碰撞概率足够低。
 */
function contentFingerprint(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return String(h >>> 0);
}

/**
 * 纯函数：从飞书事件数据中解析出业务字段。
 * 可独立测试，不依赖 SDK。
 *
 * @param {object} data - EventDispatcher 传入的完整 data
 * @returns {{
 *   text: string,
 *   chatId: string,
 *   chatType: 'p2p'|'group',
 *   senderId: string,
 *   messageId: string,
 *   messageType: string,
 *   isGroup: boolean,
 *   mentions: Array<{key?: string, id?: {open_id?: string}}>
 * } | null} - 不应处理时返回 null
 */
export function parseMessage(data) {
  if (!data || typeof data !== 'object') return null;
  const { message, sender } = data;
  if (!message || !sender) return null;

  const messageType = message.message_type || 'unknown';
  const chatType = message.chat_type === FEISHU_CHAT_TYPE_GROUP ? 'group' : 'p2p';
  const isGroup = chatType === 'group';
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];

  // text 类型才解析 content；其他类型给 handler 留空字符串
  let text = '';
  if (messageType === FEISHU_MSG_TYPE_TEXT && typeof message.content === 'string') {
    try {
      const parsed = JSON.parse(message.content);
      text = parsed?.text || '';
    } catch {
      text = '';
    }
  }

  // 群聊：清理 mentions 文本（@_user_1 这类占位符）
  if (isGroup && text) {
    for (const m of mentions) {
      if (m?.key) {
        text = text.split(m.key).join('');
      }
    }
    // 飞书在 mentions 旁还会插入不可见分隔符   等，清掉
    text = text.replace(/ /g, '').trim();
  }

  return {
    text,
    chatId: message.chat_id || '',
    chatType,
    senderId: sender.sender_id?.user_id || sender.sender_id?.open_id || '',
    messageId: message.message_id || '',
    messageType,
    isGroup,
    mentions,
  };
}

/**
 * 飞书适配器
 *
 * 用法：
 *   const feishu = new FeishuAdapter({ appId, appSecret });
 *   feishu.onMessage(async (msg) => { ... });
 *   await feishu.start();
 *
 * 测试用法（注入 mock）：
 *   const feishu = new FeishuAdapter({ appId: 'x', appSecret: 'y', lark: mockLark });
 */
export class FeishuAdapter {
  /**
   * @param {object} options
   * @param {string} options.appId
   * @param {string} options.appSecret
   * @param {object} [options.lark] - 注入的 lark 模块（默认动态 import）
   * @param {object} [options.logger] - { info, warn, error } 接口
   * @param {string} [options.botOpenId] - 机器人自己的 open_id，用于精确 @ 判定
   * @param {number} [options.dedupTtlMs] - 回复指纹 TTL（毫秒；0 = 禁用）
   * @param {number} [options.dedupMaxEntries] - 每个 chat 缓存的最大条数
   * @param {boolean} [options.enableEchoStrip] - 是否截掉 LLM echo 的用户消息前缀（默认 true）
   */
  constructor(options = {}) {
    if (!options.appId || !options.appSecret) {
      throw new Error('FeishuAdapter: appId and appSecret are required');
    }
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.botOpenId = options.botOpenId || getConfig().feishuBotOpenId || '';
    this.logger = options.logger || console;

    this._lark = options.lark || null;
    this._client = null;
    this._wsClient = null;
    this._dispatcher = null;
    this._handler = null;
    this._running = false;

    // 回复去重状态（按 chatId 分组）
    this._dedupTtlMs = options.dedupTtlMs !== undefined ? options.dedupTtlMs : DEFAULT_DEDUP_TTL_MS;
    this._dedupMaxEntries = options.dedupMaxEntries || DEFAULT_DEDUP_MAX_ENTRIES;
    this._enableEchoStrip = options.enableEchoStrip !== false;
    this._recentReplies = new Map(); // chatId -> [{ fp, ts }]
    this._recentInputs = new Map();  // chatId -> [{ content, ts }]
  }

  /**
   * 清空去重缓存（测试或热重启用）
   */
  clearReplyDedup() {
    this._recentReplies.clear();
    this._recentInputs.clear();
  }

  /**
   * 记录用户输入（用于 echo 检测）。在收到消息时调用一次。
   */
  _trackUserInput(chatId, content) {
    if (!chatId || !content) return;
    const text = String(content);
    if (!this._recentInputs.has(chatId)) this._recentInputs.set(chatId, []);
    const arr = this._recentInputs.get(chatId);
    arr.push({ content: text, ts: Date.now() });
    this._pruneMap(this._recentInputs, chatId, arr);
  }

  /**
   * 记录已发送回复的指纹
   */
  _trackReply(chatId, content) {
    if (!chatId) return;
    const text = String(content || '');
    if (text.length < DEDUP_MIN_LEN) return;  // 短文本不参与指纹
    if (!this._recentReplies.has(chatId)) this._recentReplies.set(chatId, []);
    const arr = this._recentReplies.get(chatId);
    arr.push({ fp: contentFingerprint(text), ts: Date.now() });
    this._pruneMap(this._recentReplies, chatId, arr);
  }

  /**
   * 剪枝：TTL 过期 + LRU 上限
   */
  _pruneMap(map, key, arr) {
    if (this._dedupTtlMs > 0) {
      const cutoff = Date.now() - this._dedupTtlMs;
      const pruned = arr.filter((e) => e.ts > cutoff);
      if (pruned.length !== arr.length) map.set(key, pruned);
      else if (pruned.length > this._dedupMaxEntries) {
        map.set(key, pruned.slice(-this._dedupMaxEntries));
      }
    } else if (arr.length > this._dedupMaxEntries) {
      map.set(key, arr.slice(-this._dedupMaxEntries));
    }
  }

  /**
   * 检测回复内容是否与该 chat 最近发过的回复重复
   * @returns {boolean} true 表示应跳过发送
   */
  _shouldSkipAsDuplicate(chatId, content) {
    if (this._dedupTtlMs <= 0) return false;
    const text = String(content || '');
    if (text.length < DEDUP_MIN_LEN) return false;
    // 读取前先做一次 lazy TTL 剪枝（避免过期条目仍命中）
    const recent = this._recentReplies.get(chatId) || [];
    if (recent.length > 0) {
      const cutoff = Date.now() - this._dedupTtlMs;
      const fresh = recent.filter((e) => e.ts > cutoff);
      if (fresh.length !== recent.length) this._recentReplies.set(chatId, fresh);
    }
    const freshRecent = this._recentReplies.get(chatId) || [];
    const fp = contentFingerprint(text);
    return freshRecent.some((e) => e.fp === fp);
  }

  /**
   * 检测回复是否是 LLM echo 用户消息（典型表现：回复前缀复述了用户上一条消息）
   * 触发条件（任一满足即视为 echo）：
   *   (a) 回复 normalize 后以整个用户输入开头（最常见，LLM 原样复述）
   *   (b) 回复以用户输入前 N 字开头，且 N / 用户输入长度 >= ECHO_MIN_RATIO
   * @returns {{ isEcho: boolean, prefixLen: number }} - isEcho=true 时 prefixLen 是要截掉的长度
   */
  _detectEchoPrefix(chatId, content) {
    if (!this._enableEchoStrip) return { isEcho: false, prefixLen: 0 };
    const reply = String(content || '');
    // 短回复即使 echo 剥掉也没意义（已低于 DEDUP_MIN_LEN），交由 dedup 路径处理
    if (reply.length <= DEDUP_MIN_LEN) return { isEcho: false, prefixLen: 0 };

    const inputs = this._recentInputs.get(chatId) || [];
    if (inputs.length === 0) return { isEcho: false, prefixLen: 0 };

    const replyNorm = reply.replace(/\s+/g, ' ').trim();
    for (const inp of inputs) {
      const userNorm = String(inp.content || '').replace(/\s+/g, ' ').trim();
      if (userNorm.length < 10) continue;
      // (a) 回复以整个用户输入开头
      if (replyNorm.startsWith(userNorm)) {
        return { isEcho: true, prefixLen: userNorm.length };
      }
      // (b) 回复以用户输入前 N 字开头（N = min(80, 用户输入长度)）
      const N = Math.min(80, userNorm.length);
      const userPrefix = userNorm.slice(0, N);
      if (replyNorm.startsWith(userPrefix)) {
        const ratio = N / userNorm.length;
        if (ratio >= ECHO_MIN_RATIO) {
          return { isEcho: true, prefixLen: N };
        }
      }
    }
    return { isEcho: false, prefixLen: 0 };
  }

  /**
   * 统一去重入口：在 replyText / replyCard 之前调用
   * @returns {{ action: 'send'|'skip', content: string, reason?: string }}
   *   - 'send' 正常发送（content 可能是去掉了 echo 前缀的版本）
   *   - 'skip' 完全跳过（已发过相同内容）
   */
  _resolveBeforeReply(chatId, content) {
    // 1. 完全重复检测
    if (this._shouldSkipAsDuplicate(chatId, content)) {
      this.logger.warn?.({ chatId, fp: contentFingerprint(content) }, 'feishu reply deduped (exact duplicate)');
      return { action: 'skip', content: '', reason: 'duplicate' };
    }
    // 2. Echo 前缀检测
    const echo = this._detectEchoPrefix(chatId, content);
    if (echo.isEcho) {
      const stripped = content.slice(echo.prefixLen).trim();
      this.logger.warn?.({ chatId, prefixLen: echo.prefixLen }, 'feishu reply stripped echo prefix');
      if (stripped.length < DEDUP_MIN_LEN) {
        // 剥掉 echo 后几乎没了，也跳过
        return { action: 'skip', content: '', reason: 'echo-only' };
      }
      return { action: 'send', content: stripped, reason: 'echo-stripped' };
    }
    return { action: 'send', content };
  }

  /**
   * 加载 lark SDK（动态 import，便于测试注入）
   */
  async _loadLark() {
    if (this._lark) return this._lark;
    try {
      this._lark = await import('@larksuiteoapi/node-sdk');
      return this._lark;
    } catch (err) {
      throw new Error(
        '缺少依赖 @larksuiteoapi/node-sdk，请运行: npm install @larksuiteoapi/node-sdk'
      );
    }
  }

  /**
   * 懒加载：消息发送 Client
   */
  async _getClient() {
    if (this._client) return this._client;
    const lark = await this._loadLark();
    this._client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel?.info ?? 1,
    });
    return this._client;
  }

  /**
   * 懒加载：WSClient + EventDispatcher
   */
  async _getWs() {
    if (this._wsClient && this._dispatcher) {
      return { wsClient: this._wsClient, dispatcher: this._dispatcher };
    }
    const lark = await this._loadLark();
    this._dispatcher = new lark.EventDispatcher({});
    this._wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel?.info ?? 1,
    });
    return { wsClient: this._wsClient, dispatcher: this._dispatcher };
  }

  /**
   * 注册消息处理器（只注册一次）
   * @param {function} handler - 接收 (msg) => Promise<void>
   *   msg 形参：{ text, chatId, chatType, senderId, messageId, messageType, isGroup, mentions, raw }
   */
  onMessage(handler) {
    if (typeof handler !== 'function') {
      throw new Error('FeishuAdapter.onMessage: handler must be a function');
    }
    this._handler = handler;
  }

  /**
   * 启动 WebSocket 长连接
   */
  async start() {
    if (this._running) return;
    if (!this._handler) {
      throw new Error('FeishuAdapter.start: must call onMessage(handler) first');
    }

    const { wsClient, dispatcher } = await this._getWs();

    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        const parsed = parseMessage(data);
        if (!parsed) return;

        // 群聊：仅当机器人被 @ 时响应
        if (parsed.isGroup) {
          const botMentioned = parsed.mentions.some((m) => {
            if (!this.botOpenId) return true;  // 没配 botOpenId 时，宽松处理：任一 @ 都响应
            return m?.id?.open_id === this.botOpenId;
          });
          if (!botMentioned) return;
        }

        // 记录用户输入（用于后续 echo 检测：LLM 不小心复述用户消息时截掉前缀）
        this._trackUserInput(parsed.chatId, parsed.text);

        try {
          await this._handler({ ...parsed, raw: data });
        } catch (err) {
          this.logger.error?.(
            { err: err?.message, chatId: parsed.chatId },
            'feishu handler threw',
          );
        }
      },
    });

    await wsClient.start({ eventDispatcher: dispatcher });
    this._running = true;
    this.logger.info?.('[feishu] WSClient started');
  }

  /**
   * 停止 WebSocket
   */
  async stop() {
    if (!this._running) return;
    try {
      this._wsClient?.stop?.();
    } catch { /* ignore */ }
    this._running = false;
    this.logger.info?.('[feishu] WSClient stopped');
  }

  /**
   * 是否运行中
   */
  get running() {
    return this._running;
  }

  /**
   * 发送文本消息（飞书单条 text 限制 4000 字节）
   * 自动应用 reply 去重（完全重复跳过；LLM echo 前缀截掉）
   * @param {string} chatId
   * @param {string} text
   * @returns {Promise<object|null>} 飞书响应（被去重跳过时返回 null）
   */
  async replyText(chatId, text) {
    if (!chatId) throw new Error('FeishuAdapter.replyText: chatId is required');
    const safeText = String(text ?? '');
    const decision = this._resolveBeforeReply(chatId, safeText);
    if (decision.action === 'skip') return null;
    this._trackReply(chatId, decision.content);
    const client = await this._getClient();
    return client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: decision.content }),
        msg_type: 'text',
      },
    });
  }

  /**
   * 更新已发送的消息（用于流式输出）
   * 飞书 im.message.update 限制：
   *   - 必须在原消息发出后 5 分钟内
   *   - 仅 text / post / interactive 类型可更新
   *
   * @param {string} messageId - 飞书消息 ID
   * @param {string} text - 新文本（≤ 4000 字节）
   * @returns {Promise<object>}
   */
  async updateMessage(messageId, text) {
    if (!messageId) throw new Error('FeishuAdapter.updateMessage: messageId is required');
    const safeText = String(text ?? '');
    const client = await this._getClient();
    return client.im.message.update({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: safeText }),
        msg_type: 'text',
      },
    });
  }

  /**
   * 发送消息卡片（飞书 messageCard / interactive）
   * 用于长内容（>3000 字）。卡片有折叠面板，原生支持。
   * 自动应用 reply 去重（针对 card body content 检测）
   *
   * @param {string} chatId
   * @param {string} title - 卡片标题
   * @param {string} content - 卡片正文（纯文本；过长可加折叠 notes）
   * @param {object} [opts]
   * @param {string} [opts.headerColor='blue'] - 标题色：blue|green|red|orange|...
   */
  async replyCard(chatId, title, content, opts = {}) {
    if (!chatId) throw new Error('FeishuAdapter.replyCard: chatId is required');
    const safeContent = String(content ?? '');
    const decision = this._resolveBeforeReply(chatId, safeContent);
    if (decision.action === 'skip') return null;
    const client = await this._getClient();
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: String(title || 'PersEng') },
        template: opts.headerColor || 'blue',
      },
      elements: [
        {
          tag: 'markdown',
          content: decision.content,
        },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: `PersEng · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
            },
          ],
        },
      ],
    };
    this._trackReply(chatId, decision.content);
    return client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
  }

  /**
   * 下载消息中的资源（图片/文件/音频）
   * 飞书 SDK: client.im.messageResource.get({ path: { message_id }, params: { type, ... }, data: { file_name? } })
   *
   * @param {string} messageId - 飞书消息 ID
   * @param {string} type - 'image' | 'file' | 'audio'
   * @returns {Promise<Buffer>}
   */
  async getMessageResource(messageId, type) {
    if (!messageId) throw new Error('FeishuAdapter.getMessageResource: messageId is required');
    if (!['image', 'file', 'audio'].includes(type)) {
      throw new Error(`FeishuAdapter.getMessageResource: invalid type ${type}`);
    }
    const client = await this._getClient();
    const resp = await client.im.messageResource.get({
      path: { message_id: messageId },
      params: { type },
    });
    // 飞书 SDK 响应：{ code, msg, data: { ... } }，data 可能是 Buffer 或 stream
    if (resp?.data) {
      if (Buffer.isBuffer(resp.data)) return resp.data;
      if (resp.data instanceof Uint8Array) return Buffer.from(resp.data);
      if (typeof resp.data.pipe === 'function') {
        // stream → buffer
        const chunks = [];
        for await (const c of resp.data) chunks.push(c);
        return Buffer.concat(chunks);
      }
    }
    // 备选：直接返回
    if (Buffer.isBuffer(resp)) return resp;
    if (resp instanceof Uint8Array) return Buffer.from(resp);
    throw new Error('FeishuAdapter.getMessageResource: unexpected response shape');
  }

  /**
   * 智能回复：< 3000 字用 text，>= 3000 字用 card
   * 去重逻辑在 replyText / replyCard 内部统一处理
   *
   * @param {string} chatId
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.title] - card 标题（默认 'PersEng 回复'）
   * @returns {Promise<object|null>}
   */
  async replyTextOrCard(chatId, text, opts = {}) {
    const str = String(text ?? '');
    if (str.length <= 3000) {
      return this.replyText(chatId, str);
    }
    return this.replyCard(chatId, opts.title || 'PersEng 回复', str, opts);
  }
}
