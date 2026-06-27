/**
 * 任务引擎
 * 完整执行流水线: 角色加载 → prompt 构造 → LLM 调用 → 工具循环 → 记忆保存
 */

import { buildSystemPrompt, buildMessages, discoverAvailableToolsAsync } from './prompt-builder.js';
import { getConfig } from './config.js';
import { checkCommand } from './command-policy.js';
import { PersengError, ErrorCode } from './errors.js';
import { incrementCounter } from './metrics-registry.js';

export class TaskEngine {
  constructor(options = {}) {
    this.model = options.model || getConfig().model;
    this.cwd = options.cwd || process.cwd();
    this.systemPrompt = options.systemPrompt || '';
    this.maxToolRounds = options.maxToolRounds || getConfig().maxToolRounds;
    this.llmTimeout = options.llmTimeout || getConfig().llmTimeout;
    this._loadRole = options.loadRole || null;
    this.roleId = options.roleId || null;

    // 延迟初始化（在首次运行时按需加载）
    this._llmClient = options.llmClient || null;
    this._toolRuntime = options.toolRuntime || null;
    // 时间线储存（内存中，每次任务独立）
    this._timeline = { milestones: [], phase: 'planning', startedAt: new Date().toISOString() };
  }

  setModel(model) {
    // 修复：原逻辑在 model === null 且 this.model 已设置时早返，
    // 导致 _llmClient 永远不会被清掉，下次 getLlmClient 返回的还是旧 client。
    // 改为：仅当 model 真正发生变化时才清 client。
    if (model === this.model) return;
    this.model = model;
    this._llmClient = null;
  }

  async getLlmClient() {
    if (!this._llmClient) {
      const config = getConfig();
      const { LlmClient } = await import('./llm-client.js');
      this._llmClient = new LlmClient({
        anthropicApiKey: config.anthropicApiKey,
        openaiApiKey: config.openaiApiKey,
        apiBase: config.apiBase,
        model: this.model,
        timeout: this.llmTimeout,
      });
    }
    return this._llmClient;
  }

  async getToolRuntime() {
    if (!this._toolRuntime) {
      const { ToolRuntime } = await import('./tool-runtime.js');
      this._toolRuntime = new ToolRuntime();
      // 注册内置工具
      await this.registerBuiltinTools();
    }
    return this._toolRuntime;
  }

  async registerBuiltinTools() {
    const rt = this._toolRuntime;
    if (!rt) return;

    const { resolve, sep } = await import('path');

    // 路径边界检查 helper：限制文件操作不逃出 this.cwd
    // 通过 PERSENG_ALLOW_PATH_OUTSIDE_CWD=1 可关闭（逃生口）
    const isPathAllowed = (fullPath) => {
      if (getConfig().allowPathOutsideCwd) return true;
      const cwdResolved = resolve(this.cwd);
      const fullResolved = resolve(fullPath);
      if (fullResolved === cwdResolved) return true;
      // 必须以 <cwd>/ 或 <cwd>\<sep> 开头
      return fullResolved.startsWith(cwdResolved + sep);
    };

    // 文件系统工具
    rt.register({
      name: 'read_file',
      description: '读取文件内容。M4.4: 默认限制 200 行 + 50KB，超过时返回结构化截断信息。',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          offset: { type: 'number', description: '起始行号（0-based，默认 0）', default: 0 },
          limit: { type: 'number', description: '最多返回多少行（默认 200，0 = 全部）', default: 200 },
          maxBytes: { type: 'number', description: '最大字节数（默认 51200 = 50KB）', default: 51200 },
        },
        required: ['path'],
      },
      execute: async ({ path, offset = 0, limit = 200, maxBytes = 51200 }) => {
        const { resolve } = await import('path');
        const fullPath = resolve(this.cwd, path);
        if (!isPathAllowed(fullPath)) {
          return `Error: path "${path}" is outside the working directory`;
        }
        try {
          const { readFile, stat } = await import('fs/promises');
          const st = await stat(fullPath);
          const totalBytes = st.size;

          // 大文件直接拒绝全量读
          if (totalBytes > 10 * 1024 * 1024) {
            return {
              truncated: true,
              reason: 'file_too_large',
              totalBytes,
              hint: '文件超过 10MB，请用 offset/limit 分页读取，或用 grep_search 定位关键行。',
            };
          }

          const content = await readFile(fullPath, 'utf-8');
          const allLines = content.split(/\r?\n/);
          const totalLines = allLines.length;

          const startLine = Math.max(0, offset);
          const endLine = limit > 0 ? Math.min(startLine + limit, totalLines) : totalLines;
          const lines = allLines.slice(startLine, endLine);
          const text = lines.join('\n');

          // 字节截断
          let resultText = text;
          let byteTruncated = false;
          if (Buffer.byteLength(resultText, 'utf-8') > maxBytes) {
            // 找到不超过 maxBytes 的最长前缀
            const buf = Buffer.from(resultText, 'utf-8');
            resultText = buf.slice(0, maxBytes).toString('utf-8');
            // 防止切碎多字节字符
            const lastNewline = resultText.lastIndexOf('\n');
            if (lastNewline > 0) resultText = resultText.slice(0, lastNewline);
            byteTruncated = true;
          }

          // 判断是否截断
          const lineTruncated = endLine < totalLines;
          if (!lineTruncated && !byteTruncated) {
            return resultText; // 完整内容，纯文本返回（向后兼容）
          }

          return {
            truncated: true,
            content: resultText,
            range: { startLine: startLine + 1, endLine, totalLines },
            byteTruncated,
            nextOffset: endLine,
            hint: byteTruncated
              ? `已截断到 ${maxBytes} 字节。增加 maxBytes 参数重读，或用 grep_search 定位。`
              : `仅显示 ${startLine + 1}-${endLine} 行（共 ${totalLines} 行）。用 offset=${endLine} 继续读。`,
          };
        } catch (err) {
          return `Error reading file: ${err.message}`;
        }
      },
    });

    rt.register({
      name: 'write_file',
      description: '写入内容到文件',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
      execute: async ({ path, content }) => {
        const { resolve, dirname } = await import('path');
        const fullPath = resolve(this.cwd, path);
        if (!isPathAllowed(fullPath)) {
          return `Error: path "${path}" is outside the working directory`;
        }
        try {
          const { writeFile, mkdir } = await import('fs/promises');
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, content, 'utf-8');
          return `File written: ${fullPath}`;
        } catch (err) {
          return `Error writing file: ${err.message}`;
        }
      },
    });

    rt.register({
      name: 'list_dir',
      description: '列出目录内容',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径', default: '.' },
        },
      },
      execute: async ({ path = '.' }) => {
        const { resolve } = await import('path');
        const fullPath = resolve(this.cwd, path);
        try {
          const { readdir, stat } = await import('fs/promises');
          const items = await readdir(fullPath);
          const result = await Promise.all(items.map(async (item) => {
            try {
              const s = await stat(resolve(fullPath, item));
              const type = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
              return `${type}\t${item}`;
            } catch {
              return `?\t${item}`;
            }
          }));
          return result.join('\n');
        } catch (err) {
          if (err.code === 'ENOENT') return `Directory not found: ${fullPath}`;
          return `Error listing directory: ${err.message}`;
        }
      },
    });

    rt.register({
      name: 'grep_search',
      description: '在文件中搜索文本模式。M4.4: 默认限制 50 个匹配项，超过时返回结构化截断信息 + 建议。',
      schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '搜索模式（正则）' },
          glob: { type: 'string', description: '文件过滤模式，如 *.js', default: '*' },
          path: { type: 'string', description: '搜索目录', default: '.' },
          limit: { type: 'number', description: '最多返回多少匹配（默认 50）', default: 50 },
        },
        required: ['pattern'],
      },
      execute: async ({ pattern, glob = '*', path = '.', limit = 50 }) => {
        const { resolve } = await import('path');
        const fullPath = resolve(this.cwd, path);
        if (!isPathAllowed(fullPath)) {
          return `Error: path "${path}" is outside the working directory`;
        }
        return await searchInFiles(fullPath, pattern, glob, { limit });
      },
    });

    // 命令执行工具（默认行为：shell exec；可通过 env 收紧）
    // - PERSENG_BLOCK_RUN_COMMAND=1  全局禁用
    // - PERSENG_RUN_COMMAND_ALLOWLIST="a,b,c"  仅允许列表内二进制
    // - 内置元字符检测 + 绝对路径拒绝
    rt.register({
      name: 'run_command',
      description:
        '直接执行 shell 命令（multica CLI 命令如 issue get / comment add 等）。' +
        '返回命令的标准输出和标准错误。超时 60 秒。' +
        '⚠️ 安全控制：PERSENG_BLOCK_RUN_COMMAND=1 全局禁用；' +
        'PERSENG_RUN_COMMAND_ALLOWLIST="multica,git" 仅允许指定二进制；' +
        '含 shell 元字符或绝对路径的命令将被拒绝。',
      schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 shell 命令（如 multica issue get xxx --output json）' },
          cwd: { type: 'string', description: '工作目录（默认为当前任务目录）' },
          timeout: { type: 'number', description: '超时时间（毫秒，默认 60000）' },
        },
        required: ['command'],
      },
      execute: async ({ command, cwd, timeout }) => {
        if (getConfig().blockRunCommand) {
          return 'Error: run_command is disabled by PERSENG_BLOCK_RUN_COMMAND=1';
        }
        // P0.2: 命令策略校验
        const check = checkCommand(command);
        if (!check.ok) {
          return `Error: command rejected by policy — ${check.reason}`;
        }
        const { execSync } = await import('child_process');
        const { resolve } = await import('path');
        const workDir = cwd ? resolve(this.cwd, cwd) : this.cwd;
        try {
          const stdout = execSync(command, {
            cwd: workDir,
            encoding: 'utf-8',
            timeout: timeout || 60000,
            maxBuffer: 10 * 1024 * 1024, // 10MB
            windowsHide: true,
          });
          return stdout || '(Command completed with no output)';
        } catch (err) {
          const stderr = err.stderr || '';
          const stdout = err.stdout || '';
          return [
            `[Exit code ${err.status || '?'}]`,
            stderr ? `stderr: ${stderr}` : '',
            stdout ? `stdout: ${stdout}` : '',
            err.message && !stderr ? `Error: ${err.message}` : '',
          ].filter(Boolean).join('\n');
        }
      },
    });

    // 时间线工具（项目规划与进度管理）
    rt.register({
      name: 'timeline',
      description: '创建和管理项目时间线。支持添加里程碑、阶段任务、分配负责人。每次调用会返回最新的完整时间线表。每个任务实例有独立的时间线。',
      schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['init', 'add_milestone', 'add_task', 'update_status', 'show', 'rollup'],
            description: '操作类型：init=初始化, add_milestone=添加里程碑, add_task=添加任务, update_status=更新状态, show=显示完整时间线, rollup=生成阶段汇总',
          },
          milestone: { type: 'string', description: '里程碑名称（add_milestone/update_status 时使用）' },
          task: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '任务名称' },
              description: { type: 'string', description: '任务描述' },
              assignee: { type: 'string', description: '负责人/执行代理' },
              estimate: { type: 'string', description: '预估工时/工期' },
            },
            description: '任务定义（add_task 时使用）',
          },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
            description: 'milestone 或任务的新状态',
          },
          phase_name: { type: 'string', description: '当前阶段名称（用于 rollup）' },
        },
        required: ['action'],
      },
      execute: async ({ action, milestone, task, status, phase_name }) => {
        const tl = this._timeline;
        switch (action) {
          case 'init': {
            tl.milestones = [];
            tl.phase = phase_name || 'planning';
            tl.startedAt = new Date().toISOString();
            return formatTimeline(tl);
          }
          case 'add_milestone': {
            if (!milestone) return 'Error: milestone name is required';
            tl.milestones.push({
              name: milestone,
              status: status || 'pending',
              tasks: [],
              addedAt: new Date().toISOString(),
            });
            return formatTimeline(tl);
          }
          case 'add_task': {
            if (!task || !task.name) return 'Error: task name is required';
            const found = tl.milestones.find((m) => m.name === milestone);
            if (!found) return `Error: milestone "${milestone}" not found. Available: ${tl.milestones.map(m => m.name).join(', ') || '(none)'}`;
            found.tasks.push({
              name: task.name,
              description: task.description || '',
              assignee: task.assignee || '',
              estimate: task.estimate || '',
              status: 'pending',
              addedAt: new Date().toISOString(),
            });
            return formatTimeline(tl);
          }
          case 'update_status': {
            if (!milestone) return 'Error: milestone name is required';
            const found = tl.milestones.find((m) => m.name === milestone);
            if (!found) return `Error: milestone "${milestone}" not found`;
            if (status) found.status = status;
            return formatTimeline(tl);
          }
          case 'show': {
            return formatTimeline(tl);
          }
          case 'rollup': {
            const total = tl.milestones.reduce((s, m) => s + m.tasks.length, 0);
            const done = tl.milestones.reduce((s, m) => s + m.tasks.filter((t) => t.status === 'completed').length, 0);
            const blocked = tl.milestones.filter((m) => m.status === 'blocked').map((m) => m.name);
            return [
              `## 时间线汇总 — ${tl.phase}`,
              `开始: ${tl.startedAt}`,
              `里程碑数: ${tl.milestones.length}`,
              `总任务数: ${total} (已完成: ${done})`,
              blocked.length ? `阻塞: ${blocked.join(', ')}` : '',
              '---',
              formatTimeline(tl),
            ].filter(Boolean).join('\n');
          }
          default:
            return `Error: unknown action "${action}". Valid: init, add_milestone, add_task, update_status, show, rollup`;
        }
      },
    });

    // ToolX 协议工具（统一工具接口）
    rt.register({
      name: 'toolx',
      description:
        '统一工具接口层 (ToolX Protocol)。支持 6 种模式：\n' +
        '  discover  — 发现所有可用工具\n' +
        '  manual    — 查看工具文档（首次使用前必做）\n' +
        '  execute   — 执行工具操作\n' +
        '  configure — 配置工具参数（持久化）\n' +
        '  dryrun    — 预览执行效果（不真正执行）\n' +
        '  log       — 查看工具执行历史\n' +
        '工具通过 tool:// URI 寻址，例如 tool://filesystem。',
      schema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['discover', 'manual', 'execute', 'configure', 'dryrun', 'log'],
            description: '操作模式。先用 discover 了解有什么工具，再用 manual 看具体文档。',
          },
          tool: {
            type: 'string',
            description: '工具 URI，如 tool://filesystem。discover 模式不需要此参数。',
          },
          parameters: {
            type: 'object',
            description: '执行参数。execute 模式需要 action 字段指定操作名。',
            properties: {
              action: {
                type: 'string',
                description: '操作名称，如 read/write/list/search/extract 等',
              },
            },
          },
        },
        required: ['mode'],
      },
      execute: async ({ mode, tool, parameters }) => {
        const { ToolXProtocol } = await import('./toolx/ToolXProtocol.js');
        const tx = new ToolXProtocol({
          toolRuntime: rt,
          cwd: this.cwd,
          loadRole: this._loadRole,
        });

        if (mode === 'discover') {
          const result = tx.discover();
          const lines = [`发现 ${result.tools.length} 个工具:\n`];
          for (const t of result.tools) {
            const acts = t.actions?.length ? ` [操作: ${t.actions.map((a) => a.name).join(', ')}]` : '';
            lines.push(`- **${t.uri}**: ${t.description}${acts}`);
          }
          lines.push('\n使用 toolx(mode:"manual", tool:"tool://...") 查看具体工具文档。');
          return lines.join('\n');
        }

        if (!tool) {
          return '请指定 tool 参数，如 tool://filesystem';
        }

        const params = parameters || {};
        const result = await tx.dispatch({ tool, mode, parameters: params });
        if (!result.ok) return `ToolX 错误: ${result.error}`;

        switch (mode) {
          case 'manual': return result.manual;
          case 'execute':
            return typeof result.result === 'string' ? result.result : JSON.stringify(result, null, 2);
          case 'dryrun': return `🔍 [Dry Run] ${result.description}`;
          case 'configure':
          case 'log':
            return JSON.stringify(result, null, 2);
          default:
            return JSON.stringify(result, null, 2);
        }
      },
    });

    // ─── Phase 5: 跨 agent 通信工具 ─────────────────────
    // 通过 blackboard 让多个 role 互通消息，不污染主会话
    const blackboard = await import('./blackboard-store.js');
    const selfRoleId = this.roleId || 'unknown';

    rt.register({
      name: 'agent_message',
      description: '发送私聊消息给其他 agent。私聊仅发送方与接收方可见。返回消息 id。',
      schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '接收方 roleId（如 jiangziya/nuwa/luban/hr/boduan/rotation）' },
          subject: { type: 'string', description: '主题（可选）' },
          body: { type: 'string', description: '消息正文' },
          conversationId: { type: 'string', description: '对话 thread id（续接已有对话时传）' },
        },
        required: ['to', 'body'],
      },
      execute: async ({ to, subject, body, conversationId }) => {
        if (to === selfRoleId) throw new Error('不能给自己发消息');
        const msg = blackboard.sendMessage({ from: selfRoleId, to, subject, body, conversationId });
        return JSON.stringify({ ok: true, id: msg.id, conversationId: msg.conversationId || null });
      },
    });

    rt.register({
      name: 'agent_broadcast',
      description: '向公共频道广播消息。频道里所有 agent 都能看到。',
      schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: '频道名（如 general/project-x）' },
          subject: { type: 'string', description: '主题（可选）' },
          body: { type: 'string', description: '消息正文' },
        },
        required: ['channel', 'body'],
      },
      execute: async ({ channel, subject, body }) => {
        const msg = blackboard.sendMessage({ from: selfRoleId, channel, subject, body });
        return JSON.stringify({ ok: true, id: msg.id, channel });
      },
    });

    rt.register({
      name: 'agent_inbox',
      description: '查看自己的收件箱（其他 agent 发来的私聊）。默认只返回未读。',
      schema: {
        type: 'object',
        properties: {
          unreadOnly: { type: 'boolean', description: '是否只看未读（默认 true）', default: true },
          limit: { type: 'number', description: '最多返回条数（默认 20）', default: 20 },
        },
      },
      execute: async ({ unreadOnly = true, limit = 20 } = {}) => {
        const msgs = blackboard.inbox(selfRoleId, { unreadOnly, limit });
        return JSON.stringify(msgs, null, 2);
      },
    });

    rt.register({
      name: 'agent_mark_read',
      description: '标记消息已读。',
      schema: {
        type: 'object',
        properties: {
          messageIds: { type: 'array', items: { type: 'number' }, description: '消息 id 列表' },
          all: { type: 'boolean', description: '是否清空所有未读（默认 false）', default: false },
        },
      },
      execute: async ({ messageIds, all = false } = {}) => {
        let changed;
        if (all) changed = blackboard.markAllRead(selfRoleId);
        else if (Array.isArray(messageIds) && messageIds.length > 0) {
          changed = blackboard.markRead(messageIds, selfRoleId);
        } else {
          throw new Error('需要提供 messageIds 或 all=true');
        }
        return JSON.stringify({ ok: true, markedRead: changed });
      },
    });

    rt.register({
      name: 'agent_conversation',
      description: '查看某个对话 thread 的全部消息（按时间正序）。',
      schema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string', description: '对话 thread id' },
        },
        required: ['conversationId'],
      },
      execute: async ({ conversationId }) => {
        const thread = blackboard.conversation(conversationId);
        return JSON.stringify(thread, null, 2);
      },
    });

    rt.register({
      name: 'agent_channel_history',
      description: '查看公共频道最近的消息。',
      schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: '频道名' },
          limit: { type: 'number', description: '最多返回条数（默认 20）', default: 20 },
        },
        required: ['channel'],
      },
      execute: async ({ channel, limit = 20 }) => {
        const msgs = blackboard.channelHistory(channel, { limit });
        return JSON.stringify(msgs, null, 2);
      },
    });
  }

  /**
   * 运行一个任务
   * @param {string} task - 任务描述
   * @param {object} context - 上下文
   * @param {string} context.roleId - 角色 ID
   * @param {string[]} context.memories - 相关记忆
   * @param {AbortSignal} [context.signal] - 取消信号（飞书模式用）
   * @returns {Promise<string>} 任务结果
   */
  async run(task, context = {}) {
    const llm = await this.getLlmClient();
    const tools = await this.getToolRuntime();
    const onText = typeof context.onText === 'function' ? context.onText : null;
    const signal = context.signal || null;

    // 1. 构造 system prompt
    let system = this.systemPrompt;
    if (!system) {
      const roleLoader = await import('./role-loader.js');
      // 热路径：用 loadRoleAsync 避免阻塞事件循环
      // 如果调用方注入了自定义 loadRole（mock / 测试），则用 sync 版本
      const loadRole = this._loadRole
        ? this._loadRole
        : (rid) => roleLoader.loadRoleAsync(rid);
      const roleId = context.roleId || this.roleId || 'jiangziya';
      const role = await loadRole(roleId);
      // 异步 discover，等待落盘的 custom tools 加载完成
      const tools = await discoverAvailableToolsAsync();
      system = buildSystemPrompt(role, {
        memories: context.memories || [],
        gbrainGap: context.gbrainGap,
        gbrainAnswer: context.gbrainAnswer,
        gbrainCitations: context.gbrainCitations,
        roleId,
        tools,
        sessionStartedAt: this._startedAt,
      });
    }

    // 2. 构造消息
    const messages = buildMessages(task, context);
    const toolDefinitions = tools.getToolDefinitions();

    // 3. 执行 LLM 调用循环
    let round = 0;
    let finalText = '';
    const allToolResults = [];

    while (round < this.maxToolRounds) {
      round++;

      // 在每轮 LLM 调用前检查 signal
      if (signal?.aborted) {
        throw new PersengError({
          code: ErrorCode.AGENT_TIMEOUT,
          message: 'Task aborted by signal',
          userMessage: '任务已被取消',
        });
      }

      const { text, toolCalls, usage } = await llm.streamMessages({
        system,
        messages,
        tools: toolDefinitions,
        signal,
        onText: (chunk) => {
          finalText += chunk;
          if (onText) onText(chunk);
        },
      });

      // M4.5: 累计 LLM token 用量（含 cache 命中/创建）
      if (usage) {
        const model = this.model || 'unknown';
        const role = this.roleId || 'unknown';
        if (usage.input_tokens) {
          incrementCounter('perseng_llm_tokens_total', { model, role, kind: 'input' }, usage.input_tokens);
        }
        if (usage.output_tokens) {
          incrementCounter('perseng_llm_tokens_total', { model, role, kind: 'output' }, usage.output_tokens);
        }
        if (usage.cache_creation_input_tokens) {
          incrementCounter('perseng_llm_tokens_total', { model, role, kind: 'cache_creation' }, usage.cache_creation_input_tokens);
        }
        if (usage.cache_read_input_tokens) {
          incrementCounter('perseng_llm_tokens_total', { model, role, kind: 'cache_read' }, usage.cache_read_input_tokens);
        }
      }

      // 如果没有工具调用，任务完成
      if (!toolCalls || toolCalls.length === 0) {
        break;
      }

      // 有工具调用 — 添加 assistant 消息
      messages.push({
        role: 'assistant',
        content: toolCalls.map((tc) => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
      });

      // 执行工具
      const results = [];
      for (const tc of toolCalls) {
        try {
          const output = await tools.execute(tc.name, tc.input);
          // M4.4: tool 返回对象时用 JSON.stringify，让 LLM 看到结构化截断信息
          const serialized = typeof output === 'string'
            ? output
            : JSON.stringify(output, null, 2);
          results.push({ id: tc.id, type: 'tool_result', output: serialized });
          allToolResults.push({ name: tc.name, input: tc.input, output });
          // M4.5: 业务指标
          incrementCounter('perseng_tool_invocations_total', { tool: tc.name, status: 'success' });
        } catch (err) {
          results.push({ id: tc.id, type: 'tool_result', output: `Error: ${err.message}` });
          incrementCounter('perseng_tool_invocations_total', { tool: tc.name, status: 'error' });
        }
      }

      // 将工具结果返回给 LLM
      for (const result of results) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: result.id,
              content: result.output,
            },
          ],
        });
      }
    }

    return finalText || '(No output generated)';
  }
}

async function searchInFiles(searchPath, pattern, glob, options = {}) {
  const { resolve, relative } = await import('path');
  const { stat, readdir, readFile } = await import('fs/promises');
  const { existsSync } = await import('fs');

  // M4.4: limit 默认 50，超过返回结构化截断
  const limit = options.limit ?? 50;

  if (!existsSync(searchPath)) {
    return `Search path not found: ${searchPath}`;
  }

  let regex;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (err) {
    return `Invalid search pattern: ${err.message}`;
  }

  const normalizedGlob = normalizePathSeparators(glob || '*');
  const globRegex = globToRegex(normalizedGlob);
  const files = [];
  const rootPath = resolve(searchPath);
  const followSymlinks = getConfig().followSymlinks;

  const visit = async (currentPath) => {
    let statRes;
    try {
      // lstat 不跟随符号链接，能识别 symlink 本身
      statRes = await stat(currentPath); // 当前路径可能不存在；fallback 用 lstat
    } catch {
      try {
        const { lstat } = await import('fs/promises');
        statRes = await lstat(currentPath);
      } catch {
        return;
      }
    }

    // 安全：默认跳过符号链接，防止通过 symlink 逃出 cwd
    if (statRes.isSymbolicLink()) {
      if (!followSymlinks) return;
      // 显式开启 follow 时，再 stat 一次拿真实目标类型
      try { statRes = await stat(currentPath); } catch { return; }
    }

    if (statRes.isDirectory()) {
      let entries;
      try { entries = await readdir(currentPath); } catch { return; }
      for (const entry of entries) {
        await visit(resolve(currentPath, entry));
      }
      return;
    }

    if (!statRes.isFile()) return;

    const relativePath = normalizePathSeparators(relative(rootPath, currentPath) || currentPath);
    const candidatePath = relativePath.startsWith('..')
      ? normalizePathSeparators(currentPath)
      : relativePath;
    if (!globRegex.test(candidatePath)) return;
    files.push(currentPath);
  };

  await visit(rootPath);

  const matches = [];
  let totalFound = 0;
  let hitLimit = false;
  for (const filePath of files) {
    let content;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      regex.lastIndex = 0;
      if (!regex.test(lines[index])) continue;
      totalFound++;
      if (matches.length < limit) {
        matches.push(`${filePath}:${index + 1}:${lines[index]}`);
      } else {
        hitLimit = true;
        // 不立即 break，继续计数到文件末尾拿精确 total
      }
    }
  }

  if (matches.length === 0) {
    return 'No matches found.';
  }

  // M4.4: 截断时返回结构化对象，让 LLM 看到 hint
  if (hitLimit) {
    return {
      truncated: true,
      shown: matches.length,
      total: totalFound,
      sample: matches,
      hint: `匹配项超过 ${limit} 条（实际 ${totalFound}）。建议：
  1. 用更具体的 pattern 缩小范围
  2. 缩小 path 范围
  3. 用更严格的 glob 过滤
  4. 增加 limit 参数`,
    };
  }

  return matches.join('\n');
}

function normalizePathSeparators(value) {
  return String(value || '').replace(/\\/g, '/');
}

function globToRegex(glob) {
  const source = normalizePathSeparators(glob || '*');
  let pattern = '^';

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const nextChar = source[index + 1];

    if (char === '*') {
      if (nextChar === '*') {
        const nextNext = source[index + 2];
        if (nextNext === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      pattern += '.';
      continue;
    }

    if ('\\.[]{}()+-^$|'.includes(char)) {
      pattern += `\\${char}`;
      continue;
    }

    pattern += char;
  }

  pattern += '$';
  return new RegExp(pattern);
}

// ---- 时间线格式化辅助函数 ----
function formatTimeline(tl) {
  const lines = [
    `# 项目时间线 — ${tl.phase}`,
    `开始: ${tl.startedAt}`,
    '',
  ];

  if (tl.milestones.length === 0) {
    lines.push('_时间线为空，请先添加里程碑。_');
    return lines.join('\n');
  }

  for (const ms of tl.milestones) {
    const statusIcon = { pending: '○', in_progress: '◐', completed: '●', blocked: '⊙', cancelled: '✕' }[ms.status] || '○';
    lines.push(`## ${statusIcon} ${ms.name} [${ms.status}]`);
    if (ms.tasks.length === 0) {
      lines.push('  _暂无任务_');
    } else {
      for (const t of ms.tasks) {
        const tIcon = { pending: '·', in_progress: '▶', completed: '✓', blocked: '!', cancelled: '✕' }[t.status] || '·';
        const assignee = t.assignee ? ` @${t.assignee}` : '';
        const estimate = t.estimate ? ` (${t.estimate})` : '';
        lines.push(`  ${tIcon} ${t.name}${assignee}${estimate}`);
        if (t.description) lines.push(`     ${t.description}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
