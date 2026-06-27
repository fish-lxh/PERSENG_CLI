/**
 * perseng feishu 命令 (Phase 1)
 *
 * 启动飞书机器人模式：
 *   - 每 chatId 独立 TaskEngine（通过 FeishuSessionStore 管理）
 *   - 3 秒 ack：收到消息立即回 "🤔 正在思考…"，再异步执行任务
 *   - AbortController 控制 10 分钟超时
 *   - SIGINT/SIGTERM 优雅退出（复用 serve.js 的 shutdown 模式）
 *
 * 用法：
 *   perseng feishu
 *   perseng feishu --role jiangziya --model claude-sonnet-4-20250514
 */

import { TaskEngine } from '../task-engine.js';
import { FeishuAdapter } from '../feishu-adapter.js';
import { FeishuSessionStore } from '../feishu-session-store.js';
import { PersengError, ErrorCode } from '../errors.js';
import { getConfig } from '../config.js';
import { handleRoleCommand } from '../feishu-role-switch.js';
import { loadRole, resolveRoleWorkspace } from '../role-loader.js';

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000;        // 10 分钟单任务上限
const PROGRESS_INTERVAL_MS = 30_000;                // 30s 发一次进度
const SUPPORTED_MSG_TYPES = new Set(['text', 'image', 'audio']);  // Phase 4.1: +image, +audio
const STREAM_UPDATE_THROTTLE_MS = 500;              // 流式更新节流：每 500ms 最多 1 次
const STREAM_UPDATE_MIN_CHARS = 80;                 // 或每累积 80 字符触发一次
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;            // 5MB 图片上限（飞书默认限制）
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;           // 10MB 音频上限
const MAX_IMAGE_BASE64_CHARS = 3500 * 4 / 3;        // base64 后的字符数 ≈ 4.6MB（避免 LLM 输入超限）

/**
 * 校验消息是否应被处理
 * - 必须是 text/image/audio 类型
 * - text 类型：文本不能为空
 * - image/audio：text 可能为空（caption 是可选的）
 */
function shouldHandle(msg) {
  if (!SUPPORTED_MSG_TYPES.has(msg.messageType)) {
    return { ok: false, reason: `暂不支持 ${msg.messageType} 类型的消息` };
  }
  if (msg.messageType === 'text' && (!msg.text || !msg.text.trim())) {
    return { ok: false, reason: '空消息' };
  }
  return { ok: true };
}

/**
 * Phase 4.1: 下载并构造附件
 * @returns {Promise<{attachments: Array, errors: string[]}>}
 */
async function fetchAttachments(adapter, msg) {
  const errors = [];
  const attachments = [];

  if (msg.messageType === 'image') {
    try {
      const buf = await adapter.getMessageResource(msg.messageId, 'image');
      if (buf.length > MAX_IMAGE_BYTES) {
        errors.push(`图片过大 (${(buf.length / 1024 / 1024).toFixed(1)}MB > 5MB)`);
      } else if (buf.length > MAX_IMAGE_BASE64_CHARS) {
        errors.push('图片过大，base64 后超 LLM 输入限制');
      } else {
        attachments.push({
          type: 'image',
          base64: buf.toString('base64'),
          mediaType: 'image/png',  // 飞书 SDK 不返回 mime，统一用 png（视觉模型自动识别）
        });
      }
    } catch (err) {
      errors.push(`下载图片失败: ${err.message}`);
    }
  } else if (msg.messageType === 'audio') {
    // Phase 4.1: 语音 → ASR（whisper）
    // 默认尝试用 OpenAI whisper（需 OPENAI_API_KEY）
    try {
      const buf = await adapter.getMessageResource(msg.messageId, 'audio');
      if (buf.length > MAX_AUDIO_BYTES) {
        errors.push(`语音过长 (${(buf.length / 1024 / 1024).toFixed(1)}MB > 10MB)`);
      } else {
        const transcript = await transcribeAudio(buf, msg);
        if (transcript) {
          attachments.push({ type: 'text', text: `[语音转写] ${transcript}` });
        } else {
          errors.push('语音转写失败（未配置 ASR）');
        }
      }
    } catch (err) {
      errors.push(`处理语音失败: ${err.message}`);
    }
  }

  return { attachments, errors };
}

/**
 * Phase 4.1: ASR 转写（默认 OpenAI whisper）
 * 失败时返回 null，由 caller 走错误路径
 */
async function transcribeAudio(audioBuffer, msg) {
  const config = getConfig();
  const openaiKey = config.openaiApiKey;
  if (!openaiKey) {
    // 没配 OPENAI_API_KEY：尝试用 anthropic 的话没有原生 whisper 接口
    return null;
  }
  try {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: openaiKey });
    // 转 buffer → Blob/File
    const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });
    const resp = await client.audio.transcriptions.create({
      file,
      model: config.asrModel,
      language: 'zh',
    });
    return resp?.text || null;
  } catch (err) {
    console.error('[feishu] ASR failed:', err.message);
    return null;
  }
}

/**
 * feishu 子命令入口
 * @param {object} options
 * @param {string} [options.role] - 角色 ID（默认 config.role）
 * @param {string} [options.model] - 模型（默认 config.model）
 * @param {string} [options.appId] - 飞书 appId（覆盖 env）
 * @param {string} [options.appSecret] - 飞书 appSecret（覆盖 env）
 * @param {number} [options.timeoutMs] - 单任务超时（默认 10 分钟）
 */
export async function feishuCommand(options = {}) {
  const config = getConfig();
  const roleId = options.role || config.role;
  const model = options.model || config.model;

  // 1. 凭据校验
  const appId = options.appId || config.feishuAppId || '';
  const appSecret = options.appSecret || config.feishuAppSecret || '';

  if (!appId || !appSecret) {
    throw new PersengError({
      code: ErrorCode.CONFIG_MISSING,
      message: 'FEISHU_APP_ID and FEISHU_APP_SECRET are required',
      userMessage:
        '需要配置飞书应用凭据。请在 .env 中设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。\n' +
        '参考 docs/feishu-integration.md §3 配置步骤。',
      context: { envVars: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'] },
    });
  }

  // 2. 用户/群白名单（可选）
  const allowUsers = new Set(
    config.feishuAllowUsers,
  );
  const allowGroups = new Set(
    config.feishuAllowGroups,
  );
  const roleAdminsEnv = new Set(
    config.feishuRoleAdmins,
  );
  const roleAdmins = roleAdminsEnv.size > 0 ? roleAdminsEnv : allowUsers;

  const logger = {
    info: (...args) => console.error('[feishu]', ...args),
    warn: (...args) => console.error('[feishu:warn]', ...args),
    error: (...args) => console.error('[feishu:error]', ...args),
  };

  // 3. 初始化适配器与会话存储
  const adapter = new FeishuAdapter({
    appId,
    appSecret,
    logger,
    botOpenId: config.feishuBotOpenId,
  });
  const taskTimeoutMs = options.timeoutMs || DEFAULT_TASK_TIMEOUT_MS;
  const createEngineForRole = (rid) => {
    const role = loadRole(rid);
    return new TaskEngine({
      model,
      roleId: rid,
      cwd: resolveRoleWorkspace(role, process.cwd()),
      loadRole: null,  // 用默认 loadRole
    });
  };

  const store = new FeishuSessionStore({
    maxSessions: 50,
    idleTimeoutMs: 30 * 60_000,
    engineFactory: (chatId, rid) => createEngineForRole(rid),
  });
  store.startSweep();

  // 4. 优雅退出
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, shutting down...`);

    // 1. 取消所有活跃任务
    for (const s of store.allSessions()) {
      s.abortCtl?.abort(`shutdown(${signal})`);
    }

    // 2. 停止 WSClient
    try { await adapter.stop(); } catch { /* ignore */ }

    // 3. 停止回收定时器
    store.stopSweep();

    // 4. 清空会话
    store.clear();

    logger.info('bye');
    process.exit(0);
  }
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // 5. 注册消息处理器
  adapter.onMessage(async (msg) => {
    if (shuttingDown) return;

    // 5a. 凭据/白名单校验
    if (allowUsers.size > 0 && !allowUsers.has(msg.senderId)) {
      logger.warn(`reject sender ${msg.senderId} (not in allowlist)`);
      return;
    }
    if (msg.isGroup && allowGroups.size > 0 && !allowGroups.has(msg.chatId)) {
      logger.warn(`reject group ${msg.chatId} (not in allowlist)`);
      return;
    }

    // 5b. 消息类型校验
    const check = shouldHandle(msg);
    if (!check.ok) {
      try {
        await adapter.replyText(msg.chatId, `🤖 ${check.reason}`);
      } catch (err) {
        logger.error(`failed to reply: ${err.message}`);
      }
      return;
    }

    const sessionKey = msg.isGroup ? `${msg.chatId}:${msg.senderId}` : msg.chatId;
    const session = store.getOrCreate(sessionKey, msg.chatType, roleId, {
      senderId: msg.senderId,
    });

    const roleHandled = handleRoleCommand({
      text: msg.text,
      currentRoleId: session.roleId,
      senderId: msg.senderId,
      roleAdmins,
    });
    if (roleHandled.handled) {
      if (roleHandled.nextRoleId) {
        session.abortCtl?.abort('role switched');
        session.roleId = roleHandled.nextRoleId;
        // role 切换后必须重建引擎；否则 agent_message 仍会带着旧 this.roleId 发消息。
        session.taskEngine = createEngineForRole(roleHandled.nextRoleId);
      }
      try {
        await adapter.replyText(msg.chatId, roleHandled.reply);
      } catch { /* ignore */ }
      return;
    }

    // 5c. 立即 ack（3 秒内）；捕获 messageId 以便流式更新
    let ackMessageId = null;
    try {
      const ackResp = await adapter.replyText(msg.chatId, '🤔 正在思考…');
      ackMessageId = ackResp?.data?.message_id || ackResp?.message_id || null;
    } catch (err) {
      logger.error(`ack failed: ${err.message}`);
    }

    // Phase 4.1: 拉取附件（image / audio）
    let attachments = [];
    if (msg.messageType === 'image' || msg.messageType === 'audio') {
      try {
        const { attachments: att, errors: attErrors } = await fetchAttachments(adapter, msg);
        attachments = att;
        if (attErrors.length > 0) {
          logger.warn(`attachment issues: ${attErrors.join('; ')}`);
        }
        if (attachments.length === 0) {
          try { await adapter.replyText(msg.chatId, `❌ ${attErrors.join('; ') || '附件处理失败'}`); } catch { /* */ }
          return;
        }
      } catch (err) {
        logger.error(`fetch attachments failed: ${err.message}`);
      }
    }

    const abortCtl = new AbortController();
    session.abortCtl = abortCtl;

    // 超时
    const timeoutId = setTimeout(() => {
      abortCtl.abort(`timeout after ${taskTimeoutMs}ms`);
    }, taskTimeoutMs);

    // 进度反馈（仅当没有任何流式更新时使用）
    const progressInterval = setInterval(async () => {
      if (abortCtl.signal.aborted) return;
      // 流式更新已发过至少一次 → 跳过进度提示，避免刷屏
      if (streamState.lastSent.length > 0) return;
      try {
        await adapter.replyText(msg.chatId, '⏳ 还在想…');
      } catch { /* ignore */ }
    }, PROGRESS_INTERVAL_MS);

    // 流式更新状态（throttle 触发器）
    const streamState = {
      buffer: '',
      lastSent: '',
      lastUpdateAt: 0,
      pendingFlush: null,
    };

    const flushStream = async () => {
      if (!ackMessageId) return;          // ack 没拿到 → 走一次性回复路径
      if (streamState.buffer === streamState.lastSent) return;
      if (streamState.buffer.length > 3500) return;  // 飞书 text 限制 4000 字节，避免溢出
      try {
        await adapter.updateMessage(ackMessageId, streamState.buffer);
        streamState.lastSent = streamState.buffer;
        streamState.lastUpdateAt = Date.now();
      } catch (err) {
        // 5 分钟内可更新；超时则忽略
        logger.warn?.(`stream update failed: ${err.message}`);
      }
    };

    const onTextChunk = (chunk) => {
      streamState.buffer += chunk;
      const now = Date.now();
      const charDelta = streamState.buffer.length - streamState.lastSent.length;
      const timeDelta = now - streamState.lastUpdateAt;
      if (charDelta >= STREAM_UPDATE_MIN_CHARS || timeDelta >= STREAM_UPDATE_THROTTLE_MS) {
        if (streamState.pendingFlush) return;  // 已有一次更新在飞
        streamState.pendingFlush = flushStream().finally(() => {
          streamState.pendingFlush = null;
        });
      }
    };

    const taskPromise = (async () => {
      try {
        const result = await session.taskEngine.run(msg.text, {
          roleId: session.roleId,
          signal: abortCtl.signal,
          onText: onTextChunk,
          attachments,  // Phase 4.1: 多模态附件
        });

        // 成功：更新历史 + 回复
        session.history.push({ role: 'user', content: msg.text, ts: new Date().toISOString() });
        session.history.push({ role: 'assistant', content: result, ts: new Date().toISOString() });
        if (session.history.length > 20) {
          session.history = session.history.slice(-20);
        }

        try {
          if (ackMessageId && result.length <= 3000) {
            // 短结果：覆盖 ack 消息为最终结果
            // 等待最后一批流式 flush 完
            if (streamState.pendingFlush) await streamState.pendingFlush.catch(() => { });
            await adapter.updateMessage(ackMessageId, result);
          } else {
            // 长结果 / 无 ack 能力 → 单独发一张卡
            await adapter.replyTextOrCard(msg.chatId, result);
          }
        } catch (err) {
          logger.error(`reply failed: ${err.message}`);
          if (!ackMessageId) {
            try { await adapter.replyText(msg.chatId, `(回复失败: ${err.message})`); } catch { /* */ }
          }
        }
      } catch (err) {
        // 失败：用户面 vs 内部错误分流
        const isAbort = abortCtl.signal.aborted;
        const userMsg = err instanceof PersengError
          ? err.userMessage
          : (isAbort ? '⏱️ 任务超时，已取消' : `❌ 出错: ${err?.message || err}`);
        try {
          // 优先更新 ack 消息为错误信息
          if (ackMessageId) {
            await adapter.updateMessage(ackMessageId, userMsg);
          } else {
            await adapter.replyText(msg.chatId, userMsg);
          }
        } catch (replyErr) {
          logger.error(`error reply failed: ${replyErr.message}`);
        }
      } finally {
        clearTimeout(timeoutId);
        clearInterval(progressInterval);
        session.abortCtl = null;
        session.lastActiveAt = new Date();
      }
    })();

    session.pendingReply = taskPromise;
    taskPromise.catch(() => { /* already handled inside */ });
  });

  // 6. 启动
  logger.info(`starting feishu bot, role=${roleId}, model=${model}`);
  await adapter.start();
  logger.info('feishu bot started, waiting for messages...');
  logger.info('(press Ctrl+C to stop)');

  // 7. 保持进程 — 通过等待信号退出
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  // resolve 后会落到外层 shutdown（已 once 注册）
}
