/**
 * run 命令 — 直接运行一个任务
 * 用法: perseng run <task> --role jiangziya
 */

import { getConfig } from '../config.js';
import { loadRoleAsync, resolveRoleWorkspace } from '../role-loader.js';
import { buildSystemPrompt } from '../prompt-builder.js';
import { TaskEngine } from '../task-engine.js';
import { recall, rememberFromResult, bumpRecallFrequency } from '../cognition/MemoryStore.js';
import { resolveLifecycleModel } from '../rolex/LifecycleModelPolicy.js';
import { isGBrainConfigured, gbrainThink, gbrainCapture } from '../toolx/gbrain-client.js';

export async function runCommand(task, options) {
  const config = getConfig();
  const roleId = options.role || config.role;
  const outputFormat = options.outputFormat || '';
  const isJsonOutput = outputFormat === 'json' || outputFormat === 'stream-json';
  const sessionId = 'perseng-' + Date.now().toString(36);

  // 检查 API Key (支持 Anthropic 或 OpenAI)
  if (!config.anthropicApiKey && !config.openaiApiKey) {
    const errMsg = [
      '错误: 未设置 API Key',
      '请设置以下任一环境变量:',
      '  export ANTHROPIC_API_KEY=sk-ant-...  (Anthropic Claude, 推荐)',
      '  export OPENAI_API_KEY=sk-...         (OpenAI / DeepSeek / OpenRouter 等)',
      '  export PERSENG_API_BASE=https://...  (仅 OpenAI 模式, 可选自定义端点)',
    ].join('\n');
    if (isJsonOutput) {
      process.stdout.write(JSON.stringify({
        type: 'session.start',
        data: { sessionId, selectedModel: '' },
      }) + '\n');
      process.stdout.write(JSON.stringify({
        type: 'session.error',
        data: { errorType: 'config_error', message: errMsg },
      }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'result', sessionId, exitCode: 1 }) + '\n');
    } else {
      console.error(errMsg);
    }
    process.exit(1);
  }

  // 先把 session.start 写出去（NDJSON 协议：start 必须在工作开始前到达）
  if (isJsonOutput) {
    process.stdout.write(JSON.stringify({
      type: 'session.start',
      data: { sessionId, selectedModel: options.model || config.model || '' },
    }) + '\n');
  }

  try {
    // 1. 加载角色
    const role = await loadRoleAsync(roleId);
    const cwd = options.cwd || resolveRoleWorkspace(role, process.cwd());

    // 1b. 根据生命周期阶段解析执行模型（CLI --model 优先级最高）
    const { model } = resolveLifecycleModel({
      roleId,
      role,
      explicitModel: options.model,
      defaultModel: config.model,
    });

    // 2. 检索相关记忆
    const memories = await recall(roleId, task);
    const memoryTexts = memories.map((m) => m.content);

    // 显式递增被激活 cue 的频率（仅当结果真的被消费）
    const activatedWords = memories
      .map((m) => m?.activatedBy)
      .filter((w) => typeof w === 'string' && w.length > 0);
    if (activatedWords.length > 0) {
      await bumpRecallFrequency(roleId, activatedWords);
    }

    // 2.5 GBrain think 预检索（可选，失败降级为无结果）
    let gbrainGap = '';
    let gbrainAnswer = '';
    let gbrainCitations = [];
    if (isGBrainConfigured()) {
      try {
        const gbrainResult = await gbrainThink({ question: task, brainArea: roleId });
        if (gbrainResult.ok) {
          gbrainGap = gbrainResult.gap || '';
          gbrainAnswer = gbrainResult.answer || '';
          gbrainCitations = gbrainResult.citations || [];
        }
      } catch { /* GBrain 失败不阻断主流程 */ }
    }

    // 3. 构造带记忆的 system prompt
    const systemPrompt = buildSystemPrompt(role, { memories: memoryTexts, gbrainGap, gbrainAnswer, gbrainCitations });

    // 4. 执行任务
    const engine = new TaskEngine({ model, cwd, systemPrompt });
    const result = await engine.run(task, { roleId, memories: memoryTexts });

    // 5. 保存记忆
    if (result && result !== '(No output generated)') {
      await rememberFromResult(roleId, task, result);

      // 5.5 异步捕获对话到 GBrain 深层记忆（不阻塞输出）
      if (isGBrainConfigured()) {
        gbrainCapture({
          content: `[${roleId}] 用户: ${task}\n助手: ${result}`,
          slug: `${roleId}-${Date.now()}`,
          brainArea: roleId,
        }).catch(() => { /* 失败不影响主流程 */ });
      }
    }

    // 6. 输出结果 — Multica Daemon 兼容的 perseng NDJSON 格式
    if (isJsonOutput) {
      // 文本内容逐行输出
      const lines = result.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          process.stdout.write(JSON.stringify({
            type: 'assistant.message_delta',
            data: { deltaContent: line + '\n' },
          }) + '\n');
        }
      }
      // 结果事件
      process.stdout.write(JSON.stringify({
        type: 'result',
        sessionId,
        exitCode: 0,
      }) + '\n');
    } else {
      process.stdout.write(result + '\n');
    }

  } catch (err) {
    if (isJsonOutput) {
      process.stdout.write(JSON.stringify({
        type: 'session.error',
        data: { errorType: 'execution_error', message: err.message },
      }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'result', sessionId, exitCode: 1 }) + '\n');
    } else {
      console.error('Error:', err.message);
    }
    process.exit(1);
  }
}
