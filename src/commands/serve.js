/**
 * serve 命令 — Multica 兼容守护模式
 * NDJSON over stdin/stdout 协议
 *
 * Multica 协议格式:
 *   输入 (stdin) : NDJSON task assignment
 *   输出 (stdout): NDJSON streaming messages
 *   错误 (stderr): 调试日志
 */

import { getConfig } from '../config.js';
import { loadRoleAsync, resolveRoleWorkspace } from '../role-loader.js';
import { buildSystemPrompt } from '../prompt-builder.js';
import { TaskEngine } from '../task-engine.js';
import { MulticaBridge } from '../multica-bridge.js';
import { recall, rememberFromResult, bumpRecallFrequency } from '../cognition/MemoryStore.js';
import { resolveLifecycleModel } from '../rolex/LifecycleModelPolicy.js';
import { isGBrainConfigured, gbrainThink, gbrainCapture } from '../toolx/gbrain-client.js';

// NDJSON 输入侧 DoS 防护：单行最大 1MB，总 buffer 最大 10MB
const MAX_LINE_BYTES = 1 * 1024 * 1024;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export async function serveCommand(options) {
  const config = getConfig();
  const roleId = options.role || config.role;

  // 确保有 API Key (支持 Anthropic 或 OpenAI)
  if (!config.anthropicApiKey && !config.openaiApiKey) {
    const bridge = new MulticaBridge(null, { roleId, sessionId: 'init' });
    bridge.sendError('未设置 API Key。请设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 环境变量');
    process.exit(1);
  }

  // 预加载角色（启动时加载，后续复用）
  let role;
  try {
    role = await loadRoleAsync(roleId);
  } catch (err) {
    const bridge = new MulticaBridge(null, { roleId, sessionId: 'init' });
    bridge.sendError(`角色加载失败: ${err.message}`);
    process.exit(1);
  }

  const sessionId = `perseng-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 预构造 system prompt（无记忆版本，任务到来时再注入记忆）
  const baseSystemPrompt = buildSystemPrompt(role, { memories: [] });

  // 发送就绪状态
  const bridge = new MulticaBridge(null, { roleId, sessionId });
  bridge.sendStatus('ready', 'PersEng agent ready');
  bridge.sendStatus('role_loaded', `Role: ${role.name || roleId}`);

  // 创建共享的 task engine（每次任务复用，按生命周期阶段切换 model）
  const initialModel = resolveLifecycleModel({
    roleId,
    role,
    explicitModel: options.model,
    defaultModel: config.model,
  }).model;
  const engine = new TaskEngine({
    model: initialModel,
    cwd: options.cwd || resolveRoleWorkspace(role, process.cwd()),
    systemPrompt: baseSystemPrompt,
  });

  // ---- 输入流监听 ----
  let buffer = '';
  let overflowed = false;

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    if (overflowed) return; // 已经溢出，后续输入直接丢弃直到对端断开

    buffer += chunk;

    // 总 buffer 防护：超过上限就报错并丢弃后续输入
    if (buffer.length > MAX_BUFFER_BYTES) {
      overflowed = true;
      bridge.sendError(`NDJSON buffer overflow (max ${MAX_BUFFER_BYTES} bytes); dropping further input`);
      buffer = '';
      return;
    }

    // NDJSON: 逐行解析
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      // 单行长度防护
      if (line.length > MAX_LINE_BYTES) {
        bridge.sendError(`NDJSON line too long (max ${MAX_LINE_BYTES} bytes); skipping`);
        continue;
      }

      try {
        const msg = JSON.parse(line);
        handleMessage(msg);
      } catch {
        bridge.sendError('Invalid NDJSON input: ' + line.slice(0, 100));
      }
    }
  });

  process.stdin.on('end', () => {
    // 处理最后的 buffer
    if (buffer.trim()) {
      try {
        const msg = JSON.parse(buffer.trim());
        handleMessage(msg);
      } catch {
        // ignore
      }
    }
    // 给 stdin 'end' 一个自然的退出信号，避免 stdin 重启后 buffer 状态不一致
    shutdown('stdin_closed');
  });

  process.stdin.on('error', () => {
    // stdin 关闭，进程自然结束
    shutdown('stdin_error');
  });

  // ---- 优雅退出 ----
  let shuttingDown = false;
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      bridge.sendStatus('shutting_down', `Reason: ${reason}`);
    } catch { /* ignore */ }
    // 给 stderr flush 一段时间
    setTimeout(() => process.exit(0), 50).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ---- 消息处理 ----
  async function handleMessage(msg) {
    switch (msg.type) {
      case 'task':
        await handleTask(msg);
        break;
      case 'cancel':
        bridge.sendStatus('cancelled', `Task ${msg.taskId || 'unknown'} cancelled`);
        break;
      case 'ping':
        bridge.send('pong', { timestamp: Date.now() });
        break;
      default:
        if (msg.type) {
          bridge.sendError(`Unknown message type: ${msg.type}`);
        }
    }
  }

  async function handleTask(msg) {
    const taskId = msg.id || `task-${Date.now()}`;
    const prompt = msg.prompt || '';
    const taskRoleId = msg.role || roleId;
    const taskContext = msg.context || {};

    bridge.sendStatus('task_received', `Task ${taskId} received`);
    bridge.sendStatus('loading_memory', 'Loading relevant memories...');

    // 检索记忆
    const memories = await recall(taskRoleId, prompt);
    const memoryTexts = memories.map((m) => m.content);

    // 显式递增 recall frequency（仅当结果确实被消费时）
    const activatedWords = memories
      .map((m) => m?.activatedBy)
      .filter((w) => typeof w === 'string' && w.length > 0);
    if (activatedWords.length > 0) {
      await bumpRecallFrequency(taskRoleId, activatedWords);
    }

    // GBrain think 预检索（可选，失败降级为无结果）
    let gbrainGap = '';
    let gbrainAnswer = '';
    let gbrainCitations = [];
    if (isGBrainConfigured()) {
      try {
        const gbrainResult = await gbrainThink({ question: prompt, brainArea: taskRoleId });
        if (gbrainResult.ok) {
          gbrainGap = gbrainResult.gap || '';
          gbrainAnswer = gbrainResult.answer || '';
          gbrainCitations = gbrainResult.citations || [];
        }
      } catch { /* GBrain 失败不阻断主流程 */ }
    }

    // 重新构造带记忆的 system prompt
    const systemPrompt = buildSystemPrompt(role, { memories: memoryTexts, gbrainGap, gbrainAnswer, gbrainCitations });
    engine.systemPrompt = systemPrompt;
    const selectedModel = resolveLifecycleModel({
      roleId: taskRoleId,
      role,
      explicitModel: msg.model || options.model,
      defaultModel: config.model,
    }).model;
    engine.setModel(selectedModel);

    bridge.sendStatus('processing', 'Processing task with AI...');

    try {
      // 替换 bridge 的 engine 为当前引擎
      const taskBridge = new MulticaBridge(engine, { roleId: taskRoleId, sessionId });

      // 覆盖 bridge 的 send 方法，保持使用同一个 stdout
      const result = await engine.run(prompt, {
        roleId: taskRoleId,
        taskId,
        ...taskContext,
        onText: (text) => {
          taskBridge.sendText(text);
        },
      });

      // 保存记忆
      if (result && result !== '(No output generated)') {
        await rememberFromResult(taskRoleId, prompt, result);

        // 异步捕获对话到 GBrain 深层记忆（不阻塞输出）
        if (isGBrainConfigured()) {
          gbrainCapture({
            content: `[${taskRoleId}] 用户: ${prompt}\n助手: ${result}`,
            slug: `${taskRoleId}-${Date.now()}`,
            brainArea: taskRoleId,
          }).catch(() => { /* 失败不影响主流程 */ });
        }
      }

      taskBridge.sendStatus('completed', `Task ${taskId} completed`);

    } catch (err) {
      bridge.sendStatus('failed', err.message);
      bridge.sendError(err.message);
    }
  }

  // 保持进程存活，直到 shutdown() 被调用
  await new Promise((resolve) => {
    const onShutdown = () => resolve();
    process.once('SIGINT', onShutdown);
    process.once('SIGTERM', onShutdown);
  });
}
