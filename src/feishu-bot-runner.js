/**
 * 飞书 bot 运行器（共享核心）
 *
 * 抽出来让 feishu（单租户）和 feishu-multi（多租户）共用。
 * 不直接导出 CLI 参数解析，只导出"启动一个 bot"的逻辑。
 *
 * 用法：
 *   const { startFeishuBot } = await import('./feishu-bot-runner.js');
 *   const handle = await startFeishuBot({
 *     appId, appSecret, role, model, allowUsers, allowGroups, taskTimeoutMs, logger,
 *   });
 *   // 等待：await handle.done
 *   // 停止：await handle.stop()
 */

import { TaskEngine } from './task-engine.js';
import { FeishuAdapter } from './feishu-adapter.js';
import { FeishuSessionStore } from './feishu-session-store.js';
import { handleRoleCommand } from './feishu-role-switch.js';
import { loadRole, resolveRoleWorkspace } from './role-loader.js';
import { getConfig } from './config.js';
import { recall } from './cognition/MemoryStore.js';
import { isGBrainConfigured, gbrainThink, gbrainCapture } from './toolx/gbrain-client.js';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { randomBytes } from 'crypto';

// ──── 角色偏好持久化 ────
// 角色切换后写入磁盘，session 过期重建时恢复用户选择的角色，避免回退到默认角色。

function getRolePrefDir() {
  const config = getConfig();
  const envDir = config.dataDir;
  const candidates = [];
  if (envDir) candidates.push(envDir);
  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'perseng-cli'));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'perseng-cli'));
  }
  candidates.push(join(homedir(), '.perseng-cli'));
  candidates.push(join(process.cwd(), '.perseng-cli'));
  candidates.push(join(tmpdir(), 'perseng-cli'));
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch { /* continue */ }
  }
  return candidates[candidates.length - 1];
}

function getRolePrefPath() {
  return join(getRolePrefDir(), 'feishu-role-prefs.json');
}

function readRolePrefs() {
  const path = getRolePrefPath();
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return {}; }
}

function writeRolePrefs(prefs) {
  const path = getRolePrefPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(prefs, null, 2), 'utf-8');
  try {
    renameSync(tmp, path);
  } catch {
    try { writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf-8'); } catch { /* ignore */ }
    try { if (existsSync(tmp)) { try { renameSync(tmp, `${path}.broken.${Date.now()}`); } catch { /* ignore */ } } } catch { /* ignore */ }
  }
}

function saveRolePref(sessionKey, roleId) {
  const prefs = readRolePrefs();
  prefs[sessionKey] = roleId;
  writeRolePrefs(prefs);
}

function loadRolePref(sessionKey) {
  const prefs = readRolePrefs();
  return prefs[sessionKey] || null;
}

/**
 * 估算消息列表的 token 数（粗略：中文 ~0.5 字/token，英文 ~4 字符/token）
 * 用于在发送前判断是否需要压缩上下文。
 */
function estimateTokenCount(messages) {
  let total = 0;
  for (const msg of messages) {
    const text = String(msg.content || '');
    // 粗略：非中文按 4 字符/token，中文按 2 字/token
    const chineseChars = (text.match(/[一-鿿]/g) || []).length;
    const nonChinese = text.length - chineseChars;
    total += Math.ceil(nonChinese / 4) + Math.ceil(chineseChars * 2);
  }
  return total;
}

/**
 * 压缩会话历史：把中间的消息汇总为一段摘要，保留最近 N 条和最初 1 条系统上下文
 * @param {Array} history - [{role, content, ts}]
 * @param {number} keepRecent - 保留最近几条
 * @param {number} targetTokens - 目标 token 上限
 * @returns {Array} 压缩后的消息列表
 */
function compressHistory(history, keepRecent = 6, targetTokens = 8000) {
  if (history.length <= keepRecent) return history;
  const recent = history.slice(-keepRecent);
  const older = history.slice(0, -keepRecent);

  const recentTokens = estimateTokenCount(recent);
  const allowedOldTokens = Math.max(500, targetTokens - recentTokens);

  // 估算 older 部分 token 数
  let oldTokens = 0;
  for (const msg of older) {
    const text = String(msg.content || '');
    const chineseChars = (text.match(/[一-鿿]/g) || []).length;
    const nonChinese = text.length - chineseChars;
    oldTokens += Math.ceil(nonChinese / 4) + Math.ceil(chineseChars * 2);
  }

  if (oldTokens <= allowedOldTokens) return [...older, ...recent];

  // 超出目标，把 older 替换为一条摘要消息
  const summaryContent = older.length > 0
    ? `[${older.length} 条早期对话已省略，摘要如下]\n${older.map(m => m.content?.slice(0, 200)).join('\n---\n')}`
    : '';

  const summaryTokens = estimateTokenCount([{ content: summaryContent }]);
  if (summaryTokens > allowedOldTokens) {
    // 摘要本身也太长，直接截断
    const truncated = summaryContent.slice(0, allowedOldTokens * 2) + '...(已截断)';
    return [{ role: 'system', content: `[早期对话摘要 — 共 ${older.length} 条，已压缩]` }, ...recent];
  }

  return [
    { role: 'system', content: summaryContent || `[早期对话摘要 — 共 ${older.length} 条]` },
    ...recent,
  ];
}

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000;
const PROGRESS_INTERVAL_MS = 30_000;
const SUPPORTED_MSG_TYPES = new Set(['text', 'image', 'audio']);
const STREAM_UPDATE_THROTTLE_MS = 500;
const STREAM_UPDATE_MIN_CHARS = 80;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = (3500 * 4) / 3;

function shouldHandle(msg) {
  if (!SUPPORTED_MSG_TYPES.has(msg.messageType)) {
    return { ok: false, reason: `暂不支持 ${msg.messageType} 类型的消息` };
  }
  if (msg.messageType === 'text' && (!msg.text || !msg.text.trim())) {
    return { ok: false, reason: '空消息' };
  }
  return { ok: true };
}

async function transcribeAudio(audioBuffer) {
  const config = getConfig();
  const openaiKey = config.openaiApiKey;
  if (!openaiKey) return null;
  try {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: openaiKey });
    const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });
    const resp = await client.audio.transcriptions.create({
      file,
      model: config.asrModel,
      language: 'zh',
    });
    return resp?.text || null;
  } catch (err) {
    return null;
  }
}

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
          mediaType: 'image/png',
        });
      }
    } catch (err) {
      errors.push(`下载图片失败: ${err.message}`);
    }
  } else if (msg.messageType === 'audio') {
    try {
      const buf = await adapter.getMessageResource(msg.messageId, 'audio');
      if (buf.length > MAX_AUDIO_BYTES) {
        errors.push(`语音过长 (${(buf.length / 1024 / 1024).toFixed(1)}MB > 10MB)`);
      } else {
        const transcript = await transcribeAudio(buf);
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
 * 启动一个飞书 bot 实例
 * @param {object} cfg
 * @param {string} cfg.name - 标识（多租户时用于日志区分）
 * @param {string} cfg.appId
 * @param {string} cfg.appSecret
 * @param {string} cfg.role
 * @param {string} cfg.model
 * @param {string[]} [cfg.allowUsers]
 * @param {string[]} [cfg.allowGroups]
 * @param {number} [cfg.taskTimeoutMs]
 * @param {object} [cfg.logger]
 * @param {string} [cfg.botOpenId]
 * @returns {Promise<{stop: () => Promise<void>, done: Promise<void>, inflightCount: () => number}>}
 */
export async function startFeishuBot(cfg) {
  const config = getConfig();
  if (!cfg?.appId || !cfg?.appSecret) {
    throw new Error('startFeishuBot: appId and appSecret are required');
  }
  const name = cfg.name || cfg.appId.slice(0, 8);
  const log = cfg.logger || console;
  const taskTimeoutMs = cfg.taskTimeoutMs || DEFAULT_TASK_TIMEOUT_MS;
  const allowUsers = new Set((cfg.allowUsers || []).map(String));
  const allowGroups = new Set((cfg.allowGroups || []).map(String));
  const roleAdminsEnv = config.feishuRoleAdmins;
  const roleAdmins = new Set(
    (cfg.roleAdmins || roleAdminsEnv || []).map(String).filter(Boolean)
  );
  if (roleAdmins.size === 0 && allowUsers.size > 0) {
    for (const u of allowUsers) roleAdmins.add(u);
  }

  const adapter = new FeishuAdapter({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    logger: { info: (...a) => log.info?.(`[${name}]`, ...a), warn: (...a) => log.warn?.(`[${name}]`, ...a), error: (...a) => log.error?.(`[${name}]`, ...a) },
    botOpenId: cfg.botOpenId || config.feishuBotOpenId,
    lark: cfg.lark,  // 测试可注入 mock
  });
  const createEngineForRole = (rid) => {
    const role = loadRole(rid);
    return new TaskEngine({
      model: cfg.model,
      roleId: rid,
      cwd: resolveRoleWorkspace(role, process.cwd()),
    });
  };
  const store = new FeishuSessionStore({
    maxSessions: 50,
    idleTimeoutMs: 30 * 60_000,
    engineFactory: (chatId, rid) => createEngineForRole(rid),
  });
  store.startSweep();

  let shuttingDown = false;
  const inflightPromises = [];

  adapter.onMessage(async (msg) => {
    if (shuttingDown) return;

    // 白名单
    if (allowUsers.size > 0 && !allowUsers.has(msg.senderId)) {
      log.warn?.(`reject sender ${msg.senderId}`);
      return;
    }
    if (msg.isGroup && allowGroups.size > 0 && !allowGroups.has(msg.chatId)) {
      log.warn?.(`reject group ${msg.chatId}`);
      return;
    }

    const check = shouldHandle(msg);
    if (!check.ok) {
      try { await adapter.replyText(msg.chatId, `🤖 ${check.reason}`); } catch { /* */ }
      return;
    }

    const sessionKey = msg.isGroup ? `${msg.chatId}:${msg.senderId}` : msg.chatId;
    // session 重建时优先恢复用户上次切换的角色（持久化偏好）
    const persistedRole = loadRolePref(sessionKey);
    const initialRoleId = persistedRole || cfg.role;
    const session = store.getOrCreate(sessionKey, msg.chatType, initialRoleId, { senderId: msg.senderId });

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
        // 持久化角色切换，session 过期重建后恢复
        saveRolePref(sessionKey, roleHandled.nextRoleId);
        // role 切换后同步替换引擎，避免后续 agent_message 仍用旧 roleId 发信。
        session.taskEngine = createEngineForRole(roleHandled.nextRoleId);
      }
      try { await adapter.replyText(msg.chatId, roleHandled.reply); } catch { /* */ }
      return;
    }

    // 3 秒 ack
    let ackMessageId = null;
    try {
      const ackResp = await adapter.replyText(msg.chatId, '🤔 正在思考…');
      ackMessageId = ackResp?.data?.message_id || null;
    } catch { /* */ }

    // 附件
    let attachments = [];
    if (msg.messageType === 'image' || msg.messageType === 'audio') {
      try {
        const { attachments: att, errors: attErrors } = await fetchAttachments(adapter, msg);
        attachments = att;
        if (attachments.length === 0) {
          try { await adapter.replyText(msg.chatId, `❌ ${attErrors.join('; ')}`); } catch { /* */ }
          return;
        }
      } catch (err) {
        log.error?.(`fetch attachments failed: ${err.message}`);
      }
    }

    const abortCtl = new AbortController();
    session.abortCtl = abortCtl;
    const timeoutId = setTimeout(() => abortCtl.abort(`timeout after ${taskTimeoutMs}ms`), taskTimeoutMs);

    // 进度反馈
    const progressInterval = setInterval(async () => {
      if (abortCtl.signal.aborted) return;
      if (streamState.lastSent.length > 0) return;
      try { await adapter.replyText(msg.chatId, '⏳ 还在想…'); } catch { /* */ }
    }, PROGRESS_INTERVAL_MS);

    // 流式
    const streamState = { buffer: '', lastSent: '', lastUpdateAt: 0, pendingFlush: null };
    const flushStream = async () => {
      if (!ackMessageId) return;
      if (streamState.buffer === streamState.lastSent) return;
      if (streamState.buffer.length > 3500) return;
      try {
        await adapter.updateMessage(ackMessageId, streamState.buffer);
        streamState.lastSent = streamState.buffer;
        streamState.lastUpdateAt = Date.now();
      } catch { /* */ }
    };
    const onTextChunk = (chunk) => {
      streamState.buffer += chunk;
      const charDelta = streamState.buffer.length - streamState.lastSent.length;
      const timeDelta = Date.now() - streamState.lastUpdateAt;
      if (charDelta >= STREAM_UPDATE_MIN_CHARS || timeDelta >= STREAM_UPDATE_THROTTLE_MS) {
        if (streamState.pendingFlush) return;
        streamState.pendingFlush = flushStream().finally(() => { streamState.pendingFlush = null; });
      }
    };

    const taskPromise = (async () => {
      try {
        // 1. 获取相关记忆（recall）
        const memories = await recall(session.roleId, msg.text, { mode: 'balanced', limit: 5 });
        const memoryTexts = memories.map((m) => m.content);

        // 1.5 GBrain think 预检索（可选，失败降级为无结果）
        let gbrainGap = '';
        let gbrainAnswer = '';
        let gbrainCitations = [];
        if (isGBrainConfigured()) {
          try {
            const gbrainResult = await gbrainThink({ question: msg.text, brainArea: session.roleId });
            if (gbrainResult.ok) {
              gbrainGap = gbrainResult.gap || '';
              gbrainAnswer = gbrainResult.answer || '';
              gbrainCitations = gbrainResult.citations || [];
            }
          } catch {
            // GBrain 失败不阻断主流程
          }
        }

        // 2. 把当前用户消息追加到 session.history（保持最近 20 条）
        session.history.push({ role: 'user', content: msg.text, ts: new Date().toISOString() });
        if (session.history.length > 20) session.history = session.history.slice(-20);

        // 3. 压缩：基于 session.history（包含当前 msg）之前的消息，
        //    当前 msg 会在 buildMessages 里追加，避免重复。
        //    slice(0, -1) 排除当前 msg，只压缩历史。
        const compressedHistory = compressHistory(session.history.slice(0, -1), keepRecent = 6, targetTokens = 12000);

        const result = await session.taskEngine.run(msg.text, {
          roleId: session.roleId,
          sessionStartedAt: session.startedAt,
          signal: abortCtl.signal,
          onText: onTextChunk,
          attachments,
          // 传入压缩后的历史（让 LLM 记得之前的上下文）
          messages: compressedHistory,
          // 传入 recall 到的角色记忆
          memories: memoryTexts,
          // 传入 GBrain 检索结果（可选）
          gbrainGap,
          gbrainAnswer,
          gbrainCitations,
        });

        session.history.push({ role: 'assistant', content: result, ts: new Date().toISOString() });
        if (session.history.length > 20) session.history = session.history.slice(-20);
        if (ackMessageId && result.length <= 3000) {
          if (streamState.pendingFlush) await streamState.pendingFlush.catch(() => { });
          await adapter.updateMessage(ackMessageId, result);
        } else {
          await adapter.replyTextOrCard(msg.chatId, result);
        }

        // 4. 异步捕获对话到 GBrain 深层记忆（不阻塞用户已收到的回复）
        if (isGBrainConfigured()) {
          gbrainCapture({
            content: `[${session.roleId}] 用户: ${msg.text}\n助手: ${result}`,
            slug: `${session.roleId}-${Date.now()}`,
            brainArea: session.roleId,
          }).catch(() => { /* 失败不影响主流程 */ });
        }
      } catch (err) {
        const isAbort = abortCtl.signal.aborted;
        const userMsg = isAbort ? '⏱️ 任务超时，已取消' : `❌ 出错: ${err?.message || err}`;
        try {
          if (ackMessageId) await adapter.updateMessage(ackMessageId, userMsg);
          else await adapter.replyText(msg.chatId, userMsg);
        } catch { /* */ }
      } finally {
        clearTimeout(timeoutId);
        clearInterval(progressInterval);
        session.abortCtl = null;
        session.lastActiveAt = new Date();
      }
    })();

    inflightPromises.push(taskPromise);
    taskPromise.catch(() => { /* handled inside */ });
  });

  await adapter.start();
  log.info?.(`started (role=${cfg.role}, model=${cfg.model})`);

  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });

  return {
    name,
    adapter,
    store,
    inflightCount: () => inflightPromises.filter((p) => /* still pending */ true).length,
    done,
    async stop() {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info?.('stopping...');
      for (const s of store.allSessions()) s.abortCtl?.abort('shutdown');
      try { await adapter.stop(); } catch { /* */ }
      store.stopSweep();
      // 等待 inflight
      if (inflightPromises.length > 0) {
        await Promise.allSettled(inflightPromises);
      }
      store.clear();
      log.info?.('stopped');
      resolveDone();
    },
  };
}
