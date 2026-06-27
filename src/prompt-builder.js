/**
 * Prompt 构造器
 * 从角色定义 + 任务 + 记忆 + 上下文构造 LLM 消息
 */

import { activateRole } from './role-loader.js';
import { summaryForRole } from './blackboard-store.js';
import { ToolXProtocol } from './toolx/ToolXProtocol.js';

// 共享缓存：异步 discover 后填充，让同步 buildSystemPrompt 也能拿到
let _toolsCache = null;
let _toolsCachePromise = null;

/**
 * 探测当前所有可用工具（builtin + 已落盘的 custom）
 * 用于注入到 system prompt，让 persona 实时感知工具能力
 *
 * 同步版本：仅返回缓存或 builtin。custom 工具若还没异步加载，则不会立即出现。
 * 推荐先用 discoverAvailableToolsAsync() 预热缓存，再调用 buildSystemPrompt。
 *
 * @returns {Array<{uri, name, description, actions}>}
 */
export function discoverAvailableTools() {
  if (_toolsCache) return _toolsCache;
  try {
    const tx = new ToolXProtocol({ cwd: process.cwd() });
    const tools = tx.discover().tools;
    // 即使同步路径也写入缓存（只是可能漏掉落盘的 custom）
    _toolsCache = tools;
    return tools;
  } catch {
    return [];
  }
}

/**
 * 异步版本：等待 custom tools 加载完成后返回 + 填充缓存
 * 建议：每次 run() / 会话开始前先 await 此函数，再 buildSystemPrompt
 */
export async function discoverAvailableToolsAsync() {
  // 防止并发：单例 Promise
  if (!_toolsCachePromise) {
    _toolsCachePromise = (async () => {
      try {
        const tx = new ToolXProtocol({ cwd: process.cwd() });
        if (tx._initCustomToolsPromise) {
          await tx._initCustomToolsPromise;
        }
        const tools = tx.discover().tools;
        _toolsCache = tools;
        return tools;
      } catch {
        return [];
      }
    })();
  }
  return _toolsCachePromise;
}

/**
 * 重置缓存（仅测试 / 工具创建后需要刷新时用）
 */
export function resetToolsCache() {
  _toolsCache = null;
  _toolsCachePromise = null;
}

/**
 * 格式化工具目录为可注入的 prompt 片段
 */
function formatToolCatalog(tools) {
  if (!tools || tools.length === 0) {
    return '（当前无可用工具）';
  }
  const lines = [`共 ${tools.length} 个工具:`];
  for (const t of tools) {
    const acts = t.actions?.length ? ` — 操作: ${t.actions.map((a) => a.name).join(', ')}` : '';
    lines.push(`- \`${t.uri}\`: ${t.description}${acts}`);
  }
  lines.push('');
  lines.push('**重要**：以上是**实时**工具目录。回答用户「你能做什么」「有什么工具」时，');
  lines.push('**必须以此处列表为准，不要凭印象猜测**（persona 的静态 knowledge 可能过时）。');
  lines.push('如需查看具体工具用法，调用 toolx(mode:"manual", tool:"<uri>") 工具。');
  return lines.join('\n');
}

/**
 * 构造完整的 system prompt
 * @param {object} role - 角色定义
 * @param {string[]} options.memories - 相关记忆
 * @param {string} [options.roleId] - 角色 ID（用于注入黑板摘要）
 * @param {object} options.context - 额外上下文
 * @param {Array}  [options.tools] - 显式传入的工具列表（跳过实时 discover）
 * @returns {string} 完整的 system prompt
 */
export function buildSystemPrompt(role, options = {}) {
  const parts = [];

  // 1. 角色核心定义
  const rolePrompt = activateRole(role);
  parts.push(rolePrompt);

  // 2. 记忆上下文
  if (options.memories && options.memories.length > 0) {
    parts.push('## 相关记忆');
    for (const mem of options.memories) {
      parts.push(`- ${mem}`);
    }
    parts.push('');
  }

  // 2.5 GBrain 检索结果（可选，由 feishu-bot-runner / run / serve 注入）
  if (options.gbrainAnswer && typeof options.gbrainAnswer === 'string' && options.gbrainAnswer.trim()) {
    parts.push('## Brain 检索');
    parts.push(options.gbrainAnswer.trim());
    if (Array.isArray(options.gbrainCitations) && options.gbrainCitations.length > 0) {
      parts.push('');
      parts.push('### 引用');
      for (const c of options.gbrainCitations) {
        parts.push(`- ${typeof c === 'string' ? c : (c.title || c.url || JSON.stringify(c))}`);
      }
    }
    parts.push('');
  }

  // 2.6 GBrain 差距分析（可选）
  if (options.gbrainGap && typeof options.gbrainGap === 'string' && options.gbrainGap.trim()) {
    parts.push('## Brain 差距');
    parts.push(options.gbrainGap.trim());
    parts.push('');
  }

  // 3. Phase 5：黑板摘要（只注入计数，不暴露正文）
  const roleId = options.roleId || role?.id || role?.roleId;
  if (roleId) {
    const bb = summaryForRole(roleId);
    if (bb) parts.push(bb);
  }

  // 4. 🆕 实时工具目录（注入到 system prompt，让 persona 立即感知所有工具）
  //    - builtin 工具（filesystem/pdf-reader/...）
  //    - 动态创建的 custom 工具（tool-creator 注册的）
  //    - 这是修复"记忆模块遗漏新工具"问题的关键
  const tools = options.tools || discoverAvailableTools();
  parts.push('## 当前可用工具（实时探测）');
  parts.push(formatToolCatalog(tools));
  parts.push('');

  // 5. 当前时间（让 Agent 知道日期/时间/时区/会话开始时间）
  const now = new Date();
  const cnWeekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  parts.push('## 当前时间');
  parts.push(`- 日期: ${dateStr}（星期${cnWeekday}）`);
  parts.push(`- 时间: ${timeStr}`);
  parts.push(`- 时区: ${tz}`);
  if (options.sessionStartedAt) {
    const st = new Date(options.sessionStartedAt);
    parts.push(`- 会话开始: ${st.toLocaleString('zh-CN', { timeZone: tz })}`);
  }
  parts.push('');

  // 6. 行为约束
  parts.push('## 行为约束');
  parts.push('- 你是 perseng-cli 中的 AI 代理，运行在命令行环境中');
  parts.push('- 你可以调用工具来完成任务，工具会由系统自动执行');
  parts.push('- 所有任务都通过内置工具自己完成；没有子代理可以委派');
  parts.push('- 如需查看其他 agent 发来的消息，使用 agent_inbox 工具');
  parts.push('- **回答能力问题前，先看上面的「当前可用工具」列表，不要凭印象猜测**');
  parts.push('- 在最终回复中提供完整、可执行的输出');
  parts.push('');

  // 7. 输出格式
  parts.push('## 输出要求');
  parts.push('- 思考过程请用 <thinking> 标签包裹');
  parts.push('- 最终回复应清晰、结构化');
  parts.push('- 如有代码输出，请标注语言类型');
  parts.push('');

  return parts.join('\n');
}

/**
 * 构造消息列表
 * @param {string} task - 任务描述（纯文本部分）
 * @param {object} options
 * @param {string[]} options.memories - 相关记忆
 * @param {object} options.context - 额外上下文
 * @param {Array} [options.attachments] - Phase 4.1: 多模态附件
 *   形如：[{ type: 'image', base64: '...', mediaType: 'image/png', fileName: 'xxx.png' }]
 * @param {Array} [options.messages] - 会话历史（[{role, content, ts}]），会被展平为消息列表
 * @returns {Array} 消息数组
 */
export function buildMessages(task, options = {}) {
  const messages = [];

  // 如果有额外系统指令，作为首条 user message
  if (options.instructions) {
    messages.push({
      role: 'user',
      content: options.instructions,
    });
    messages.push({
      role: 'assistant',
      content: '明白，我会遵循这些指令。请告诉我具体任务。',
    });
  }

  // 会话历史：把 [{role, content}] 转成 LLM 消息列表（保留之前的上下文）
  const history = Array.isArray(options.messages) ? options.messages : [];
  for (const msg of history) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      messages.push({ role: msg.role, content: String(msg.content || '') });
    }
  }

  // Phase 4.1: 多模态
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  if (attachments.length > 0) {
    // 多模态：content 必须是数组
    const contentParts = [];
    if (task) contentParts.push({ type: 'text', text: task });
    for (const att of attachments) {
      if (att.type === 'image' && att.base64) {
        contentParts.push({
          type: 'image',
          base64: att.base64,
          mediaType: att.mediaType || 'image/png',
        });
      }
      // 后续可扩展：audio / file
    }
    messages.push({ role: 'user', content: contentParts });
  } else {
    // 纯文本
    messages.push({ role: 'user', content: task });
  }

  return messages;
}
