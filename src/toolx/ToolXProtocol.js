/**
 * ToolX Protocol — 统一工具接口层
 *
 * 将现有工具（ToolRuntime）包装为 ToolX 协议，提供 5 种模式：
 *   manual    — 查看工具文档（始终先做这一步）
 *   execute   — 执行工具
 *   configure — 设置工具环境变量
 *   dryrun    — 预览执行结果（不真正执行）
 *   log       — 查看工具执行日志
 *
 * 工具通过 tool:// URI 寻址：
 *   tool://filesystem     — 文件系统操作
 *   tool://pdf-reader     — PDF 文本提取
 *   tool://excel-tool     — Excel 读写
 *   tool://word-tool      — Word 文档读取
 *   tool://role-creator   — 角色创建（女娲）
 *   tool://tool-creator   — 工具创建（鲁班）
 *
 * 设计原则：
 *   1. 现有工具的 ToolRuntime 注册方式不变，ToolX 在其上包装一层
 *   2. 支持 JSON 和 YAML 两种输入格式
 *   3. 执行日志自动追踪，支持按工具 URI 查询
 *   4. 配置持久化到 ~/.perseng-cli/toolx-config.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { homedir, tmpdir } from 'os';
import { getConfig } from '../config.js';

import {
  validateUrl,
  resolveAndCheckIPv4,
  checkDomainPolicy,
  isNetworkAllowed,
} from './web-fetch-security.js';

import {
  webSearch,
  resolveBackendFromEnv,
} from './web-search.js';

import {
  createCustomToolScript,
  loadAllCustomTools,
  listCustomTools,
  deleteCustomTool,
  getCustomDir,
  getRegistryPath,
} from './custom-tools.js';

import { isGBrainConfigured, gbrainSearch, gbrainThink, gbrainCapture } from './gbrain-client.js';

import {
  addEvent,
  updateEvent,
  deleteEvent,
  listEvents,
  getEvent,
  stats as timelineStats,
  exportTimeline,
} from './timeline-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──── 内置工具定义 ────

const BUILTIN_TOOLS = {
  'tool://filesystem': {
    uri: 'tool://filesystem',
    name: '文件系统',
    description: '读取、写入、列出、搜索文件',
    actions: [
      { name: 'read', params: { path: { type: 'string', description: '文件路径' } }, required: ['path'] },
      { name: 'write', params: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '文件内容' } }, required: ['path', 'content'] },
      { name: 'list', params: { path: { type: 'string', description: '目录路径', default: '.' } } },
      { name: 'search', params: { pattern: { type: 'string', description: '搜索模式' }, glob: { type: 'string', description: '文件过滤' } }, required: ['pattern'] },
      { name: 'delete', params: { path: { type: 'string', description: '文件/目录路径' } }, required: ['path'] },
    ],
    manual: `## tool://filesystem — 文件系统工具

提供文件读写、目录列表、文本搜索功能。

### 使用方式

\`\`\`json
{
  "tool": "tool://filesystem",
  "mode": "execute",
  "parameters": {
    "action": "read",
    "path": "example.txt"
  }
}
\`\`\`

### 可用操作

| 操作 | 描述 | 必填参数 |
|------|------|---------|
| read | 读取文件内容 | path |
| write | 写入文件内容 | path, content |
| list | 列出目录内容 | path (可选) |
| search | 在文件中搜索文本 | pattern |
| delete | 删除文件或空目录 | path |

### 安全约束

- 默认不允许写出工作目录（cwd）之外
- 设置 PERSENG_ALLOW_PATH_OUTSIDE_CWD=1 可解除`,
    config: {
      allowPathOutsideCwd: { type: 'boolean', default: false, description: '允许操作工作目录外的路径' },
    },
  },

  'tool://pdf-reader': {
    uri: 'tool://pdf-reader',
    name: 'PDF 阅读器',
    description: '从 PDF 文件中提取文本内容',
    actions: [
      { name: 'extract', params: { path: { type: 'string', description: 'PDF 文件路径' } }, required: ['path'] },
    ],
    manual: `## tool://pdf-reader — PDF 阅读器

从 PDF 文件中提取文本内容。

### 使用方式

\`\`\`json
{
  "tool": "tool://pdf-reader",
  "mode": "execute",
  "parameters": {
    "action": "extract",
    "path": "document.pdf"
  }
}
\`\`\`

### 可用操作

| 操作 | 描述 | 必填参数 |
|------|------|---------|
| extract | 提取 PDF 文本内容 | path |

### 依赖

需要安装 \`pdf-parse\` 或系统中有 \`pdftotext\` 命令。`,
    config: {
      backend: { type: 'string', default: 'auto', description: '解析后端: auto/pdf-parse/pdftotext' },
    },
  },

  'tool://excel-tool': {
    uri: 'tool://excel-tool',
    name: 'Excel 工具',
    description: '读取 Excel (.xlsx/.xls) 文件内容',
    actions: [
      { name: 'read', params: { path: { type: 'string', description: 'Excel 文件路径' }, sheet: { type: 'string', description: '工作表名称（可选）' } }, required: ['path'] },
      { name: 'sheets', params: { path: { type: 'string', description: 'Excel 文件路径' } }, required: ['path'] },
    ],
    manual: `## tool://excel-tool — Excel 工具

读取 Excel 电子表格内容。

### 使用方式

\`\`\`json
{
  "tool": "tool://excel-tool",
  "mode": "execute",
  "parameters": {
    "action": "read",
    "path": "data.xlsx"
  }
}
\`\`\`

### 可用操作

| 操作 | 描述 | 必填参数 |
|------|------|---------|
| read | 读取工作表内容 | path, sheet(可选) |
| sheets | 列出所有工作表名称 | path |

### 依赖

需要安装 \`xlsx\` npm 包。`,
    config: {},
  },

  'tool://word-tool': {
    uri: 'tool://word-tool',
    name: 'Word 工具',
    description: '读取 Word (.docx) 文档内容',
    actions: [
      { name: 'read', params: { path: { type: 'string', description: 'Word 文件路径' } }, required: ['path'] },
    ],
    manual: `## tool://word-tool — Word 工具

读取 Word 文档内容。

### 使用方式

\`\`\`json
{
  "tool": "tool://word-tool",
  "mode": "execute",
  "parameters": {
    "action": "read",
    "path": "document.docx"
  }
}
\`\`\`

### 可用操作

| 操作 | 描述 | 必填参数 |
|------|------|---------|
| read | 读取文档内容 | path |

### 依赖

需要安装 \`mammoth\` npm 包。`,
    config: {},
  },

  'tool://role-creator': {
    uri: 'tool://role-creator',
    name: '角色创造者',
    description: '创建、修改、列出 AI 角色（女娲的 ToolX 接口）',
    actions: [
      { name: 'create', params: { name: { type: 'string', description: '角色名称' }, id: { type: 'string', description: '角色 ID' }, source: { type: 'string', description: 'Gherkin 行为描述' } }, required: ['name', 'source'] },
      { name: 'list', params: {} },
      { name: 'inspect', params: { id: { type: 'string', description: '角色 ID' } }, required: ['id'] },
      { name: 'delete', params: { id: { type: 'string', description: '角色 ID' } }, required: ['id'] },
    ],
    manual: `## tool://role-creator — 角色创造者

创建和管理 AI 角色。

### 使用方式

\`\`\`json
{
  "tool": "tool://role-creator",
  "mode": "execute",
  "parameters": {
    "action": "create",
    "name": "我的角色",
    "id": "my-role",
    "source": "Feature: My Role\\n  Scenario: ..."
  }
}
\`\`\`

### 可用操作

| 操作 | 描述 | 必填参数 |
|------|------|---------|
| create | 创建新角色 | name, source |
| list | 列出所有角色 | 无 |
| inspect | 查看角色详情 | id |
| delete | 删除角色 | id |`,
    config: {},
  },

  'tool://tool-creator': {
    uri: 'tool://tool-creator',
    name: '工具创造者',
    description: '创建新的 ToolX 工具（鲁班的 ToolX 接口）— 支持落盘脚本+自动加载',
    actions: [
      { name: 'create', params: { uri: { type: 'string', description: '工具 URI（如 tool://my-tool）' }, name: { type: 'string', description: '工具名称' }, description: { type: 'string', description: '工具描述' }, actions: { type: 'array', description: '操作定义' } }, required: ['uri', 'name', 'description', 'actions'] },
      { name: 'create_script', params: { uri: { type: 'string', description: '工具 URI' }, name: { type: 'string', description: '短名称（同时作为脚本文件名）' }, description: { type: 'string', description: '工具描述' }, code: { type: 'string', description: 'JS 源文件（必须含 export default）' }, actions: { type: 'array', description: '操作定义（可选）' }, manual: { type: 'string', description: 'manual 文档（可选）' } }, required: ['uri', 'name', 'description', 'code'] },
      { name: 'list', params: {} },
      { name: 'list_files', params: {} },
      { name: 'inspect', params: { uri: { type: 'string', description: '工具 URI' } }, required: ['uri'] },
      { name: 'delete', params: { uri: { type: 'string', description: '工具 URI' } }, required: ['uri'] },
    ],
    manual: `## tool://tool-creator — 工具创造者（鲁班）

鲁班是 PersEng 的工具铸造师。本工具让鲁班**直接**创建新工具 — 无需再依赖子代理写脚本。

### 核心改动（v2）

鲁班之前无法独立创建可执行工具：\`create\` action 只把元数据塞到内存 Map，
不写脚本、不持久化。现在新增 \`create_script\`：

- 接受完整 JS 源文件（\`code\` 参数）
- 写入 \`src/toolx/custom/<name>.js\`（原子写：tmp + rename）
- 落盘到 \`~/.perseng-cli/custom-tools.json\`
- 本次进程立即注册到 \`_customTools\`
- 下次 ToolXProtocol 启动时由 \`_loadCustomToolsAsync()\` 自动加载

### 脚本约定

\`export default\` 必须是：
- **函数**：\`export default async (action, params) => result\`
- **对象**：\`export default { execute, manual, config, actions }\`

错误以 throw 抛出，框架捕获并返回 \`{ ok: false, error }\`。

### 可用操作

| 操作              | 描述 | 必填参数 |
|-------------------|------|---------|
| create            | 仅注册元数据到内存（不写文件） | uri, name, description, actions |
| **create_script** | **写脚本到磁盘 + 注册，本次进程立即可用** | uri, name, description, code |
| list              | 列出当前进程已注册的所有自定义工具 | 无 |
| list_files        | 列出落盘注册表（含脚本路径） | 无 |
| inspect           | 查看单个工具的元数据 + 脚本路径 | uri |
| delete            | 从注册表移除并归档脚本（移到 .deleted.<ts>） | uri |

### create_script 用法

\`\`\`json
{
  "tool": "tool://tool-creator",
  "mode": "execute",
  "parameters": {
    "action": "create_script",
    "uri": "tool://web-search",
    "name": "web-search",
    "description": "多后端网络搜索",
    "actions": [{ "name": "search", "params": { "query": "string" } }],
    "code": "export default {\\n  async execute(action, params) {\\n    if (action === 'search') {\\n      return { results: [] };\\n    }\\n    throw new Error('unknown action');\\n  },\\n  manual: '## tool://web-search',\\n  actions: [{ name: 'search', params: {} }]\\n};"
  }
}
\`\`\`

写完后可立即调用：

\`\`\`bash
perseng toolx exec --tool tool://web-search --action search --query "hello"
\`\`\`

下次启动时已自动加载，**鲁班无需重做**。`,
    config: {},
  },

  'tool://gbrain': {
    uri: 'tool://gbrain',
    name: 'GBrain 知识大脑',
    description: '搜索知识大脑、向大脑提问、捕获内容到大脑（需配置 GBRAIN_URL）',
    actions: [
      { name: 'search', params: { query: { type: 'string', description: '搜索关键词' }, brainArea: { type: 'string', description: '脑区（可选，默认 perseng）' } }, required: ['query'] },
      { name: 'think', params: { question: { type: 'string', description: '问题' }, brainArea: { type: 'string', description: '脑区（可选）' } }, required: ['question'] },
      { name: 'capture', params: { content: { type: 'string', description: '要捕获的内容' }, slug: { type: 'string', description: 'slug（可选）' }, brainArea: { type: 'string', description: '脑区（可选）' } }, required: ['content'] },
    ],
    manual: `## tool://gbrain — GBrain 知识大脑

对接外部 GBrain 知识服务，提供语义检索、问答合成、内容捕获能力。

### 使用方式

\`\`\`json
{
  "tool": "tool://gbrain",
  "mode": "execute",
  "parameters": {
    "action": "search",
    "query": "如何配置飞书机器人"
  }
}
\`\`\`

### 可用操作

| 操作 | 描述 | 必填参数 |
|------|------|---------|
| search | 搜索知识大脑中的相关页面 | query |
| think | 向大脑提问，返回合成答案+引用+差距分析 | question |
| capture | 捕获内容到大脑 | content |

### 配置

需设置环境变量 GBRAIN_URL（GBrain 服务地址）。未配置时本工具不可用。`,
    config: {},
  },

  'tool://web-fetch': {
    uri: 'tool://web-fetch',
    name: 'Web Fetch',
    description: '受控的 HTTP/HTTPS 出站请求（默认禁用，需 PERSENG_ALLOW_NETWORK=1）',
    actions: [
      {
        name: 'get', params: {
          url: { type: 'string', description: '目标 URL（仅 http/https）' },
          headers: { type: 'object', description: '可选自定义请求头（键值对）' },
          maxBytes: { type: 'number', description: '最大下载字节数（默认受 config.maxBytes 限制）' },
        }, required: ['url']
      },
      {
        name: 'head', params: {
          url: { type: 'string', description: '目标 URL（仅 http/https）' },
          headers: { type: 'object', description: '可选自定义请求头（键值对）' },
        }, required: ['url']
      },
    ],
    manual: `## tool://web-fetch — 受控出站 HTTP/HTTPS 抓取

发起 HTTP GET / HEAD 请求。**默认禁用**，需设置环境变量
\`PERSENG_ALLOW_NETWORK=1\` 才可使用（用于保护用户在不知情时被外网访问）。

### 安全约束（强制）

- 仅允许 \`http://\` 与 \`https://\`，拒绝 file:// / gopher:// / dict:// 等
- 拒绝 URL 中携带 userinfo（防凭据注入，如 \`http://x@y\`）
- DNS 解析后必须落在公网 IPv4；私网 / 回环 / 链路本地 / CGNAT / 多播一律拒绝
- IPv6 字面量目标直接拒绝（保守策略）
- 不跟随重定向（避免重定向到内网绕过校验）
- 响应体大小受 \`maxBytes\` 限制（默认 1 MiB），超出截断
- 域名白名单/黑名单通过 configure 模式设置

### 使用方式

\`\`\`json
{
  "tool": "tool://web-fetch",
  "mode": "execute",
  "parameters": {
    "action": "get",
    "url": "https://example.com/api/data",
    "maxBytes": 524288
  }
}
\`\`\`

### 可用操作

| 操作 | 描述 | 必填参数 |
|------|------|---------|
| get  | HTTP GET，返回状态码、headers、body | url |
| head | HTTP HEAD，仅返回状态码与 headers   | url |

### 已知限制

- v1 未实现 DNS rebinding 防护（攻击者控制权威 DNS 时可绕过）。
  缓解建议：在受信任网络运行本工具，或通过 \`configure\` 配置白名单。`,
    config: {
      allowedDomains: { type: 'array', default: [], description: '域名白名单（支持 *.example.com 通配），空数组表示不限制' },
      blockedDomains: { type: 'array', default: [], description: '域名黑名单（精确或通配，优先于白名单）' },
      maxBytes: { type: 'number', default: 1048576, description: '默认最大下载字节数（1 MiB）' },
      timeoutMs: { type: 'number', default: 15000, description: '请求超时（毫秒）' },
    },
  },

  'tool://web-search': {
    uri: 'tool://web-search',
    name: 'Web Search',
    description: '多后端网络搜索（DDG 免费 / Brave / Tavily / SerpAPI），返回结构化结果列表',
    actions: [
      {
        name: 'search', params: {
          query: { type: 'string', description: '搜索关键词' },
          backend: { type: 'string', description: '后端：duckduckgo/brave/tavily/serpapi/auto，默认 auto' },
          apiKey: { type: 'string', description: '后端 API Key（可省略，会自动读对应环境变量）' },
          maxResults: { type: 'number', description: '最大返回条数（1-50，默认 10）' },
          safesearch: { type: 'string', description: '安全搜索：strict/moderate/off' },
          category: { type: 'string', description: 'Brave 专用：news/videos/images' },
        }, required: ['query']
      },
    ],
    manual: `## tool://web-search — 多后端网络搜索

在公网执行一次搜索查询，返回结构化的 [{title, url, snippet, source}] 列表。

### 安全约束（强制）

- **默认禁用**：必须设置环境变量 \`PERSENG_ALLOW_NETWORK=1\`
- 所有后端域名都被域名策略白名单锁定（不可被用户配置覆盖）
- 每次出站前先 DNS 解析 → 私网/回环/链路本地/CGNAT/多播一律拒绝
- 不跟随重定向（避免重定向到内网绕过校验）
- 默认超时 15s，响应体上限 2 MiB（DDG HTML 可能较大）

### 可用后端

| 后端       | 是否需 Key  | 来源       | 备注 |
|------------|------------|------------|------|
| duckduckgo | ❌ 免费     | DDG HTML   | 抓取 html.duckduckgo.com，无需注册；适合一般查询 |
| brave      | ✅          | Brave API  | 设置 \`BRAVE_API_KEY\`；结果质量高 |
| tavily     | ✅          | Tavily API | 设置 \`TAVILY_API_KEY\`；AI 友好，含原始 content |
| serpapi    | ✅          | SerpAPI    | 设置 \`SERPAPI_API_KEY\`；Google 结果 |

\`backend\` 不传或传 \`auto\` 时，按 brave → tavily → serpapi → duckduckgo 顺序
自动选择第一个有 Key 的后端；若都没有 Key，则回退到 duckduckgo。

### 使用方式

\`\`\`json
{
  "tool": "tool://web-search",
  "mode": "execute",
  "parameters": {
    "action": "search",
    "query": "Anthropic Claude Code CLI",
    "maxResults": 5
  }
}
\`\`\`

或显式指定后端：

\`\`\`json
{
  "tool": "tool://web-search",
  "mode": "execute",
  "parameters": {
    "action": "search",
    "query": "latest perseng-cli release",
    "backend": "duckduckgo",
    "safesearch": "strict",
    "maxResults": 10
  }
}
\`\`\`

### 返回结构

\`\`\`json
{
  "ok": true,
  "mode": "execute",
  "tool": "tool://web-search",
  "action": "search",
  "backend": "duckduckgo",
  "results": [
    {
      "title": "GitHub - anthropics/perseng-cli",
      "url": "https://github.com/anthropics/perseng-cli",
      "snippet": "...",
      "source": "duckduckgo"
    }
  ]
}
\`\`\`

### 已知限制

- DDG HTML 抓取依赖其页面结构，若 DDG 改版可能需要重新调整正则解析
- v1 未实现 DNS rebinding 防护（与 web-fetch 共用同一风险）`,
    config: {
      maxResults: { type: 'number', default: 10, description: '默认最大返回条数' },
      safesearch: { type: 'string', default: 'moderate', description: '默认安全搜索级别' },
      timeoutMs: { type: 'number', default: 15000, description: '默认请求超时（毫秒）' },
    },
  },

  'tool://timeline': {
    uri: 'tool://timeline',
    name: '时间线',
    description: '事件流跟踪工具 — 记录、查询、导出里程碑/发布/事故/会议等带时间戳的事件',
    actions: [
      {
        name: 'add', params: {
          title: { type: 'string', description: '事件标题（必填）' },
          time: { type: 'string', description: 'ISO 8601 时间戳，缺省=当前时间' },
          description: { type: 'string', description: '详细描述' },
          category: { type: 'string', description: '分类: release/milestone/incident/meeting/decision/note/task/custom' },
          tags: { type: 'array', description: '标签数组' },
          source: { type: 'string', description: '事件来源（如 manual/agent:jiangziya）' },
          metadata: { type: 'object', description: '任意附加数据' },
        }, required: ['title']
      },
      {
        name: 'list', params: {
          category: { type: 'string', description: '按分类过滤' },
          tags: { type: 'array', description: '必须包含的所有标签' },
          since: { type: 'string', description: '起始时间（ISO 8601）' },
          until: { type: 'string', description: '截止时间（ISO 8601）' },
          search: { type: 'string', description: '在 title/description 中模糊搜索' },
          limit: { type: 'number', description: '最大返回数（默认 50）' },
        }
      },
      {
        name: 'show', params: {
          id: { type: 'string', description: '事件 ID' },
        }, required: ['id']
      },
      {
        name: 'update', params: {
          id: { type: 'string', description: '事件 ID' },
          title: { type: 'string', description: '新标题' },
          time: { type: 'string', description: '新时间' },
          description: { type: 'string', description: '新描述' },
          category: { type: 'string', description: '新分类' },
          tags: { type: 'array', description: '新标签' },
          source: { type: 'string', description: '新来源' },
          metadata: { type: 'object', description: '新 metadata' },
        }, required: ['id']
      },
      {
        name: 'delete', params: {
          id: { type: 'string', description: '事件 ID' },
        }, required: ['id']
      },
      { name: 'stats', params: {} },
      {
        name: 'export', params: {
          format: { type: 'string', description: '导出格式: markdown/json，默认 markdown' },
          since: { type: 'string', description: '起始时间' },
          until: { type: 'string', description: '截止时间' },
          category: { type: 'string', description: '按分类过滤' },
        }
      },
    ],
    manual: `## tool://timeline — 时间线 / 事件流工具

为 perseng-cli 增加带时间戳的事件流：可记录项目里程碑、版本发布、事故、决策等，
也可让 agent 在跑任务时主动写入关键节点，供后续回顾 / 导出 / LLM 总结。

### 数据模型

每个事件形如：

\`\`\`json
{
  "id": "evt-1719000000-a1b2c3d4",
  "time": "2026-06-24T14:30:00.000Z",
  "title": "v1.2.0 发布",
  "description": "新增 tool://web-search",
  "category": "release",
  "tags": ["v1.2", "search"],
  "source": "manual",
  "metadata": { "commits": 47 },
  "createdAt": "2026-06-24T14:30:00.000Z",
  "updatedAt": "2026-06-24T14:30:00.000Z"
}
\`\`\`

### category 取值

| 取值 | 用途 |
|------|------|
| release    | 版本发布 |
| milestone  | 项目里程碑 |
| incident   | 事故 / 问题 |
| meeting    | 会议 |
| decision   | 决策 |
| note       | 备注 |
| task       | 任务 |
| custom     | 自定义 |

### 可用操作

| 操作 | 描述 | 必填参数 |
|------|------|---------|
| add     | 新增一个事件 | title |
| list    | 列出事件（按时间倒序），支持 since/until/category/tags/search 过滤 | 无 |
| show    | 按 id 获取单个事件 | id |
| update  | 局部更新事件（id/createdAt 不可改） | id + 任意字段 |
| delete  | 删除事件 | id |
| stats   | 统计：总数、按 category 分组、最早/最新 | 无 |
| export  | 导出为 markdown（默认）或 json | 无 |

### 存储

- 单 JSON 文件：\`~/.perseng-cli/timeline/timeline.json\`
- 原子写（tmp + rename），进程异常不会损坏
- 环境变量 \`PERSENG_CLI_TIMELINE_DIR\` 可覆盖路径（用于测试）

### 使用方式

\`\`\`json
{
  "tool": "tool://timeline",
  "mode": "execute",
  "parameters": {
    "action": "add",
    "title": "v1.2.0 发布",
    "category": "release",
    "tags": ["v1.2", "search"],
    "description": "新增 tool://web-search"
  }
}
\`\`\`

查询一周内所有 release：

\`\`\`json
{
  "tool": "tool://timeline",
  "mode": "execute",
  "parameters": {
    "action": "list",
    "category": "release",
    "since": "2026-06-17T00:00:00Z"
  }
}
\`\`\`

导出为 Markdown 周报：

\`\`\`json
{
  "tool": "tool://timeline",
  "mode": "execute",
  "parameters": {
    "action": "export",
    "format": "markdown",
    "since": "2026-06-17T00:00:00Z"
  }
}
\`\`\`

### 适合场景

- 任务回顾：agent 跑完重要任务后自动 add 一条
- LLM 时间线问答："过去一周发生了什么？" → list + since
- 项目日志：手动记录 release/incident 决策
- 周报：export markdown + since=上周`,
    config: {},
  },
};

// ──── 配置存储路径 ────

function getDefaultBaseDir() {
  const canUseDir = (dir) => {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(
        dir,
        `.probe.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
      );
      writeFileSync(probe, '1', 'utf-8');
      unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  };

  const candidates = [];
  if (getConfig().dataDir) candidates.push(getConfig().dataDir);
  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'perseng-cli'));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'perseng-cli'));
  }
  candidates.push(join(homedir(), '.perseng-cli'));
  candidates.push(join(process.cwd(), '.perseng-cli'));
  candidates.push(join(tmpdir(), 'perseng-cli'));

  for (const dir of candidates) {
    if (canUseDir(dir)) return dir;
  }

  return candidates[candidates.length - 1];
}

function getConfigPath() {
  const dir = getDefaultBaseDir();
  return join(dir, 'toolx-config.json');
}

function readConfigStore() {
  const path = getConfigPath();
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf-8')); }
  catch { return {}; }
}

function writeConfigStore(store) {
  const path = getConfigPath();
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
  renameSync(tmp, path);
}

// ──── ToolX 协议 ────

export class ToolXProtocol {
  /**
   * @param {object} options
   * @param {import('../tool-runtime.js').ToolRuntime} options.toolRuntime - 已注册工具的运行时
   * @param {string} options.cwd - 工作目录
   * @param {object} options.loadRole - loadRole 函数
   */
  constructor(options = {}) {
    this.toolRuntime = options.toolRuntime || null;
    this.cwd = options.cwd || process.cwd();
    this.loadRole = options.loadRole || null;

    // 执行日志（内存中，进程级）
    this._logs = [];

    // 加载持久化配置
    this._configStore = readConfigStore();

    // 自定义工具（通过 tool-creator 动态注册的）
    this._customTools = new Map();
    this._customToolsLoaded = false;

    // 启动时加载已落盘的自定义脚本（异步，下一次 microtask 完成）
    this._initCustomToolsPromise = this._loadCustomToolsAsync();
  }

  /**
   * 异步加载所有已落盘的自定义工具脚本
   * 失败不抛出 — 让单个坏脚本不会拖垮整个协议
   */
  async _loadCustomToolsAsync() {
    if (this._customToolsLoaded) return;
    try {
      const loaded = await loadAllCustomTools();
      for (const [uri, def] of loaded.entries()) {
        this._customTools.set(uri, def);
      }
      this._customToolsLoaded = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ToolXProtocol] 加载自定义工具失败: ${err.message}`);
    }
  }

  // ──── 核心分发 ────

  /**
   * 分发票据到对应工具+模式
   * @param {object} params
   * @param {string} params.tool - 工具 URI（如 tool://filesystem）
   * @param {string} params.mode - 模式（manual/execute/configure/dryrun/log）
   * @param {object} [params.parameters] - 执行参数（execute/dryrun 时使用）
   * @returns {Promise<object>}
   */
  async dispatch({ tool, mode, parameters = {} }) {
    if (!tool) {
      return { ok: false, error: '缺少 tool 参数，格式: tool://工具名' };
    }

    // 判断 URI 格式
    if (!tool.startsWith('tool://')) {
      // 兼容裸名称（如 "filesystem" → "tool://filesystem"）
      tool = `tool://${tool}`;
    }

    const toolName = tool.slice('tool://'.length);

    switch (mode) {
      case 'manual':
        return this._manual(tool);
      case 'execute':
        return this._execute(tool, toolName, parameters);
      case 'configure':
        return this._configure(tool, parameters);
      case 'dryrun':
        return this._dryrun(tool, toolName, parameters);
      case 'log':
        return this._log(tool);
      default:
        return { ok: false, error: `未知模式 "${mode}"，可用: manual, execute, configure, dryrun, log` };
    }
  }

  /**
   * 发现所有可用工具
   * @returns {object}
   */
  discover() {
    const tools = [];
    for (const [uri, def] of Object.entries(BUILTIN_TOOLS)) {
      // GBrain 工具仅在配置了 GBRAIN_URL 时才可见
      if (uri === 'tool://gbrain' && !isGBrainConfigured()) continue;
      tools.push({
        uri,
        name: def.name,
        description: def.description,
        actions: def.actions.map((a) => ({ name: a.name, params: Object.keys(a.params) })),
      });
    }
    for (const [uri, def] of this._customTools) {
      tools.push({
        uri,
        name: def.name,
        description: def.description,
        actions: def.actions.map((a) => ({ name: a.name, params: Object.keys(a.params) })),
      });
    }
    return { ok: true, tools };
  }

  // ──── 模式：manual ────

  _manual(tool) {
    // 先查内置工具
    const builtin = BUILTIN_TOOLS[tool];
    if (builtin) {
      if (tool === 'tool://gbrain' && !isGBrainConfigured()) {
        return { ok: false, error: 'GBrain 未启用，请配置 GBRAIN_URL' };
      }
      return {
        ok: true,
        mode: 'manual',
        tool,
        name: builtin.name,
        description: builtin.description,
        manual: builtin.manual,
        actions: builtin.actions,
        config: builtin.config,
      };
    }

    // 再查自定义工具
    const custom = this._customTools.get(tool);
    if (custom) {
      return {
        ok: true,
        mode: 'manual',
        tool,
        name: custom.name,
        description: custom.description,
        manual: custom.manual || `## ${tool}\n\n${custom.description}`,
        actions: custom.actions,
        config: custom.config || {},
      };
    }

    // 查 ToolRuntime 中注册的工具
    if (this.toolRuntime) {
      const rtTool = this.toolRuntime.getTool(toolName(tool));
      if (rtTool) {
        return {
          ok: true,
          mode: 'manual',
          tool,
          name: rtTool.name,
          description: rtTool.description,
          manual: `## ${tool}\n\n${rtTool.description}\n\nSchema:\n\`\`\`json\n${JSON.stringify(rtTool.schema, null, 2)}\n\`\`\``,
          actions: Object.keys(rtTool.schema.properties || {}),
          config: {},
        };
      }
    }

    return { ok: false, error: `工具 ${tool} 未找到。使用 discover 查看所有可用工具` };
  }

  // ──── 模式：execute ────

  async _execute(tool, toolName, params) {
    const { action, ...rest } = params;

    // --- 内置工具分发 ---
    switch (tool) {
      case 'tool://filesystem':
        return await this._execFilesystem(action, rest);
      case 'tool://pdf-reader':
        return await this._execPdfReader(action, rest);
      case 'tool://excel-tool':
        return await this._execExcelTool(action, rest);
      case 'tool://word-tool':
        return await this._execWordTool(action, rest);
      case 'tool://role-creator':
        return await this._execRoleCreator(action, rest);
      case 'tool://tool-creator':
        return await this._execToolCreator(action, rest);
      case 'tool://web-fetch':
        return await this._execWebFetch(action, rest);
      case 'tool://web-search':
        return await this._execWebSearch(action, rest);
      case 'tool://gbrain':
        return await this._execGBrain(action, rest);
      case 'tool://timeline':
        return await this._execTimeline(action, rest);
    }

    // --- 自定义工具 ---
    const custom = this._customTools.get(tool);
    if (custom) {
      return await this._execCustomTool(custom, action, rest);
    }

    // --- 回退到 ToolRuntime ---
    if (this.toolRuntime) {
      try {
        const result = await this.toolRuntime.execute(toolName, rest);
        this._addLog(tool, { mode: 'execute', action, params: rest, status: 'success' });
        return { ok: true, mode: 'execute', tool, result };
      } catch (err) {
        this._addLog(tool, { mode: 'execute', action, params: rest, status: 'error', error: err.message });
        return { ok: false, error: err.message };
      }
    }

    return { ok: false, error: `工具 ${tool} 未找到` };
  }

  // ──── 内置工具执行器 ────

  async _execFilesystem(action, params) {
    const { readFile, writeFile, readdir, stat, mkdir, rm } = await import('fs/promises');
    const { resolve, sep } = await resolvePath();

    const fullPath = resolve(this.cwd, params.path || '.');
    const allowed = (p) => {
      if (getConfig().allowPathOutsideCwd) return true;
      const cwdResolved = resolve(this.cwd);
      const fullResolved = resolve(p);
      return fullResolved === cwdResolved || fullResolved.startsWith(cwdResolved + sep);
    };

    if (!allowed(fullPath)) {
      this._addLog('tool://filesystem', { mode: 'execute', action, params, status: 'rejected', reason: 'path outside cwd' });
      return { ok: false, error: `路径 "${params.path}" 超出工作目录范围` };
    }

    try {
      let result;
      switch (action) {
        case 'read': {
          const content = await readFile(fullPath, 'utf-8');
          result = content;
          break;
        }
        case 'write': {
          if (params.content === undefined) return { ok: false, error: 'write 操作需要 content 参数' };
          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, params.content, 'utf-8');
          result = `文件已写入: ${fullPath}`;
          break;
        }
        case 'list': {
          const items = await readdir(fullPath);
          const details = await Promise.all(items.map(async (item) => {
            try {
              const s = await stat(resolve(fullPath, item));
              return `${s.isDirectory() ? 'dir' : 'file'}\t${item}`;
            } catch { return `?\t${item}`; }
          }));
          result = details.join('\n');
          break;
        }
        case 'search': {
          result = await this._searchInFiles(fullPath, params.pattern, params.glob || '*');
          break;
        }
        case 'delete': {
          await rm(fullPath, { recursive: true, force: true });
          result = `已删除: ${fullPath}`;
          break;
        }
        default:
          return { ok: false, error: `文件系统不支持操作 "${action}"。可用: read, write, list, search, delete` };
      }
      this._addLog('tool://filesystem', { mode: 'execute', action, params, status: 'success' });
      return { ok: true, mode: 'execute', tool: 'tool://filesystem', action, result };
    } catch (err) {
      this._addLog('tool://filesystem', { mode: 'execute', action, params, status: 'error', error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async _execPdfReader(action, params) {
    if (action !== 'extract') {
      return { ok: false, error: `PDF 阅读器不支持操作 "${action}"。可用: extract` };
    }

    // 尝试多种后端
    try {
      // 方案 1: 使用 pdf-parse (npm)
      const pdfParse = await tryImport('pdf-parse');
      if (pdfParse) {
        const { readFile } = await import('fs/promises');
        const dataBuffer = await readFile(resolve(this.cwd, params.path));
        const data = await pdfParse(dataBuffer);
        this._addLog('tool://pdf-reader', { mode: 'execute', action, params, status: 'success' });
        return { ok: true, mode: 'execute', tool: 'tool://pdf-reader', result: data.text, pages: data.numpages };
      }
    } catch { /* fall through */ }

    // 方案 2: 使用 pdftotext 系统命令
    try {
      const { execSync } = await import('child_process');
      const fullPath = resolve(this.cwd, params.path);
      const text = execSync(`pdftotext "${fullPath}" -`, { encoding: 'utf-8', timeout: 30000 });
      this._addLog('tool://pdf-reader', { mode: 'execute', action, params, status: 'success' });
      return { ok: true, mode: 'execute', tool: 'tool://pdf-reader', result: text };
    } catch { /* fall through */ }

    this._addLog('tool://pdf-reader', { mode: 'execute', action, params, status: 'error', error: 'no backend available' });
    return { ok: false, error: 'PDF 解析器不可用。请安装 pdf-parse (npm install pdf-parse) 或系统命令 pdftotext' };
  }

  async _execExcelTool(action, params) {
    try {
      const XLSX = await tryImport('xlsx');
      if (!XLSX) {
        return { ok: false, error: 'xlsx 模块未安装。请执行: npm install xlsx' };
      }

      const fullPath = resolve(this.cwd, params.path);
      const workbook = XLSX.readFile(fullPath);

      if (action === 'sheets') {
        return { ok: true, mode: 'execute', tool: 'tool://excel-tool', sheets: workbook.SheetNames };
      }

      if (action === 'read') {
        const sheetName = params.sheet || workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) {
          return { ok: false, error: `工作表 "${sheetName}" 未找到。可用: ${workbook.SheetNames.join(', ')}` };
        }
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        this._addLog('tool://excel-tool', { mode: 'execute', action, params, status: 'success' });
        return { ok: true, mode: 'execute', tool: 'tool://excel-tool', sheet: sheetName, rows: data.length, data };
      }

      return { ok: false, error: `Excel 工具不支持操作 "${action}"。可用: read, sheets` };
    } catch (err) {
      this._addLog('tool://excel-tool', { mode: 'execute', action, params, status: 'error', error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async _execWordTool(action, params) {
    if (action !== 'read') {
      return { ok: false, error: `Word 工具不支持操作 "${action}"。可用: read` };
    }

    try {
      const mammoth = await tryImport('mammoth');
      if (!mammoth) {
        return { ok: false, error: 'mammoth 模块未安装。请执行: npm install mammoth' };
      }

      const { readFile } = await import('fs/promises');
      const fullPath = resolve(this.cwd, params.path);
      const buffer = await readFile(fullPath);
      const result = await mammoth.extractRawText({ buffer });
      this._addLog('tool://word-tool', { mode: 'execute', action, params, status: 'success' });
      return { ok: true, mode: 'execute', tool: 'tool://word-tool', result: result.value };
    } catch (err) {
      this._addLog('tool://word-tool', { mode: 'execute', action, params, status: 'error', error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async _execRoleCreator(action, params) {
    const { writeFile, readFile, readdir, rm } = await import('fs/promises');
    const { resolve: res, existsSync } = await import('fs');
    const rolesDir = res(__dirname, '..', '..', 'roles');

    switch (action) {
      case 'list': {
        const files = await readdir(rolesDir);
        const roles = [];
        for (const f of files.filter((f) => f.endsWith('.json') && f !== 'index.json')) {
          try {
            const data = JSON.parse(await readFile(res(rolesDir, f), 'utf-8'));
            roles.push({ id: data.id, name: data.name, description: data.description });
          } catch { /* skip */ }
        }
        return { ok: true, mode: 'execute', tool: 'tool://role-creator', roles };
      }

      case 'inspect': {
        const filePath = res(rolesDir, `${params.id}.json`);
        if (!existsSync(filePath)) return { ok: false, error: `角色 "${params.id}" 未找到` };
        const data = JSON.parse(await readFile(filePath, 'utf-8'));
        return { ok: true, mode: 'execute', tool: 'tool://role-creator', role: data };
      }

      case 'create': {
        if (!params.name || !params.source) {
          return { ok: false, error: 'create 需要 name 和 source 参数' };
        }
        const id = params.id || params.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const filePath = res(rolesDir, `${id}.json`);

        // 从 Gherkin source 生成角色定义
        const v2Role = {
          id,
          name: params.name,
          description: `通过 tool://role-creator 创建的角色`,
          version: '1.0.0',
          type: 'v2',
          gherkin_source: params.source,
          persona: { type: 'custom', traits: [], thinking_patterns: [], dialogue_style: {} },
          principles: [],
          knowledge: [],
        };

        await writeFile(filePath, JSON.stringify(v2Role, null, 2) + '\n', 'utf-8');

        // 更新 index.json
        const indexPath = res(rolesDir, 'index.json');
        if (existsSync(indexPath)) {
          const index = JSON.parse(await readFile(indexPath, 'utf-8'));
          if (!index.find((e) => e.id === id)) {
            index.push({ id, name: params.name, description: v2Role.description });
            await writeFile(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
          }
        }

        this._addLog('tool://role-creator', { mode: 'execute', action, params, status: 'success' });
        return { ok: true, mode: 'execute', tool: 'tool://role-creator', action: 'create', roleId: id, filePath };
      }

      case 'delete': {
        if (!params.id) return { ok: false, error: 'delete 需要 id 参数' };
        const filePath = res(rolesDir, `${params.id}.json`);
        if (!existsSync(filePath)) return { ok: false, error: `角色 "${params.id}" 未找到` };
        await rm(filePath);
        return { ok: true, mode: 'execute', tool: 'tool://role-creator', action: 'delete', roleId: params.id };
      }

      default:
        return { ok: false, error: `角色创造者不支持操作 "${action}"。可用: create, list, inspect, delete` };
    }
  }

  async _execToolCreator(action, params) {
    switch (action) {
      case 'list': {
        const custom = [];
        for (const [uri, def] of this._customTools) {
          custom.push({ uri, name: def.name, description: def.description });
        }
        return { ok: true, mode: 'execute', tool: 'tool://tool-creator', customTools: custom };
      }

      case 'list_files': {
        // 返回落盘注册表（即使内存未加载也能查）
        const entries = listCustomTools();
        return {
          ok: true,
          mode: 'execute',
          tool: 'tool://tool-creator',
          registryPath: getRegistryPath(),
          scriptDir: getCustomDir(),
          count: entries.length,
          entries,
        };
      }

      case 'inspect': {
        // 查看单个工具的元数据 + 脚本路径
        const entry = listCustomTools().find((e) => e.uri === params.uri);
        if (!entry) return { ok: false, error: `工具 ${params.uri} 未注册` };
        return {
          ok: true,
          mode: 'execute',
          tool: 'tool://tool-creator',
          entry,
        };
      }

      case 'create': {
        if (!params.uri || !params.name || !params.description || !params.actions) {
          return { ok: false, error: 'create 需要 uri, name, description, actions 参数' };
        }
        if (!params.uri.startsWith('tool://')) {
          return { ok: false, error: 'uri 必须以 tool:// 开头' };
        }
        if (BUILTIN_TOOLS[params.uri]) {
          return { ok: false, error: `工具 ${params.uri} 是内置工具，不能覆盖` };
        }

        const toolDef = {
          uri: params.uri,
          name: params.name,
          description: params.description,
          actions: params.actions,
          manual: params.manual || `## ${params.uri}\n\n${params.description}`,
          config: params.config || {},
          execute: params.execute || null, // 可选的内联执行函数
        };

        this._customTools.set(params.uri, toolDef);
        this._addLog('tool://tool-creator', { mode: 'execute', action, params, status: 'success' });
        return { ok: true, mode: 'execute', tool: 'tool://tool-creator', created: params.uri };
      }

      case 'create_script': {
        // 鲁班最常用的入口：传 uri + code 直接创建可执行脚本
        if (BUILTIN_TOOLS[params.uri]) {
          return { ok: false, error: `工具 ${params.uri} 是内置工具，不能覆盖` };
        }

        const result = await createCustomToolScript({
          uri: params.uri,
          name: params.name,
          description: params.description,
          code: params.code,
          actions: params.actions,
          manual: params.manual,
        });

        if (!result.ok) {
          this._addLog('tool://tool-creator', {
            mode: 'execute', action,
            params: { uri: params.uri, name: params.name },
            status: 'error', error: result.error,
          });
          return result;
        }

        // 立即加载到内存（本次进程可用）
        const mod = await (await import('./custom-tools.js')).loadScript(result.scriptFile);
        const normalized = (await import('./custom-tools.js')).normalizeScriptModule(mod);

        this._customTools.set(params.uri, {
          uri: params.uri,
          name: params.name,
          description: params.description,
          actions: result.actions || [],
          manual: params.manual || `## ${params.uri}\n\n${params.description}`,
          config: {},
          execute: normalized.execute,
          scriptFile: result.scriptFile,
        });

        this._addLog('tool://tool-creator', {
          mode: 'execute', action,
          params: { uri: params.uri, name: params.name, scriptFile: result.scriptFile },
          status: 'success',
        });
        return {
          ok: true,
          mode: 'execute',
          tool: 'tool://tool-creator',
          uri: params.uri,
          scriptFile: result.scriptFile,
          lineCount: result.lineCount,
          note: '脚本已落盘并注册到 _customTools。可立即执行，下次启动自动加载。',
        };
      }

      case 'delete': {
        const result = deleteCustomTool(params.uri);
        if (result.ok) {
          this._customTools.delete(params.uri);
          this._addLog('tool://tool-creator', {
            mode: 'execute', action,
            params: { uri: params.uri },
            status: 'success',
          });
        }
        return result;
      }

      default:
        return { ok: false, error: `工具创造者不支持操作 "${action}"。可用: create, create_script, list, list_files, inspect, delete` };
    }
  }

  async _execWebFetch(action, params) {
    // ── 第 1 道闸：环境总开关 ──
    if (!isNetworkAllowed()) {
      this._addLog('tool://web-fetch', {
        mode: 'execute', action, params: { url: params.url },
        status: 'rejected', reason: 'PERSENG_ALLOW_NETWORK not set',
      });
      return {
        ok: false,
        error: 'web-fetch 默认禁用。请设置环境变量 PERSENG_ALLOW_NETWORK=1 后再试',
      };
    }

    if (action !== 'get' && action !== 'head') {
      return { ok: false, error: `web-fetch 不支持操作 "${action}"。可用: get, head` };
    }

    // ── 第 2 道闸：URL 形态校验 ──
    const urlCheck = validateUrl(params.url);
    if (!urlCheck.ok) {
      this._addLog('tool://web-fetch', {
        mode: 'execute', action, params: { url: params.url },
        status: 'rejected', reason: urlCheck.reason,
      });
      return { ok: false, error: urlCheck.reason };
    }
    const parsed = urlCheck.url;

    // ── 第 3 道闸：域名策略 ──
    const policy = checkDomainPolicy(parsed.hostname, this._configStore['tool://web-fetch'] || {});
    if (!policy.allowed) {
      this._addLog('tool://web-fetch', {
        mode: 'execute', action, params: { url: params.url },
        status: 'rejected', reason: policy.reason,
      });
      return { ok: false, error: policy.reason };
    }

    // ── 第 4 道闸：DNS 解析 + IP 私网校验 ──
    const dnsCheck = await resolveAndCheckIPv4(parsed.hostname);
    if (!dnsCheck.ok) {
      this._addLog('tool://web-fetch', {
        mode: 'execute', action, params: { url: params.url },
        status: 'rejected', reason: dnsCheck.reason,
      });
      return { ok: false, error: dnsCheck.reason };
    }

    // ── 准备请求参数 ──
    const cfg = this._configStore['tool://web-fetch'] || {};
    const defaultMax = cfg.maxBytes || 1048576;
    const timeoutMs = cfg.timeoutMs || 15000;
    // 用户传入的 maxBytes 不能超过 config 限制
    const maxBytes = (typeof params.maxBytes === 'number' && params.maxBytes > 0)
      ? Math.min(params.maxBytes, defaultMax)
      : defaultMax;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init = {
        method: action === 'head' ? 'HEAD' : 'GET',
        redirect: 'manual',  // 关键：不跟随重定向，避免绕过 SSRF 校验
        signal: controller.signal,
        headers: {
          'User-Agent': 'perseng-cli/1.0 (+web-fetch)',
          'Accept': '*/*',
          ...(params.headers || {}),
        },
      };

      const resp = await fetch(parsed.toString(), init);

      const headersObj = {};
      resp.headers.forEach((v, k) => { headersObj[k] = v; });

      if (action === 'head') {
        clearTimeout(timer);
        this._addLog('tool://web-fetch', {
          mode: 'execute', action, params: { url: params.url },
          status: 'success',
        });
        return {
          ok: true,
          mode: 'execute',
          tool: 'tool://web-fetch',
          action: 'head',
          status: resp.status,
          headers: headersObj,
        };
      }

      // GET：流式读取，限制总字节数
      const reader = resp.body.getReader();
      const chunks = [];
      let received = 0;
      let truncated = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          const overflow = received - maxBytes;
          chunks.push(value.slice(0, value.byteLength - overflow));
          truncated = true;
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
        chunks.push(value);
      }
      clearTimeout(timer);

      const body = Buffer.concat(chunks).toString('utf-8');

      this._addLog('tool://web-fetch', {
        mode: 'execute', action, params: { url: params.url },
        status: 'success',
      });
      return {
        ok: true,
        mode: 'execute',
        tool: 'tool://web-fetch',
        action: 'get',
        status: resp.status,
        headers: headersObj,
        bytes: received,
        truncated,
        body,
      };
    } catch (err) {
      clearTimeout(timer);
      this._addLog('tool://web-fetch', {
        mode: 'execute', action, params: { url: params.url },
        status: 'error', error: err.message,
      });
      if (err.name === 'AbortError') {
        return { ok: false, error: `请求超时（${timeoutMs}ms）` };
      }
      return { ok: false, error: err.message };
    }
  }

  /**
   * 内部执行器：tool://web-search — 多后端搜索
   *
   * 复用 web-search.js 的 4 道闸防护：
   *   1) 环境总开关 isNetworkAllowed（与 web-fetch 共享）
   *   2) URL 形态校验（内部）
   *   3) 域名策略（内置白名单，不可由用户配置覆盖）
   *   4) DNS + IPv4 私网判定
   *
   * action=search：query → 结果列表
   */
  async _execWebSearch(action, params) {
    if (action !== 'search') {
      return { ok: false, error: `web-search 不支持操作 "${action}"。可用: search` };
    }

    if (!params.query || typeof params.query !== 'string' || !params.query.trim()) {
      return { ok: false, error: 'query 不能为空' };
    }

    // ── 第 1 道闸：环境总开关 ──
    if (!isNetworkAllowed()) {
      this._addLog('tool://web-search', {
        mode: 'execute', action,
        params: { query: params.query, backend: params.backend },
        status: 'rejected', reason: 'PERSENG_ALLOW_NETWORK not set',
      });
      return {
        ok: false,
        error: 'web-search 默认禁用。请设置环境变量 PERSENG_ALLOW_NETWORK=1 后再试',
      };
    }

    // 解析后端 + apiKey
    const globalCfg = getConfig();
    const { backend: resolvedBackend, apiKey: envKey } = resolveBackendFromEnv(
      params.backend || globalCfg.webSearchBackend
    );
    const apiKey = params.apiKey || envKey;

    // 合并 config 默认值（优先级：参数 > toolx配置 > 环境变量 > 代码默认值）
    const cfg = this._configStore['tool://web-search'] || {};
    const searchOpts = {
      backend: resolvedBackend,
      apiKey,
      maxResults: params.maxResults ?? cfg.maxResults ?? globalCfg.webSearchMaxResults,
      safesearch: params.safesearch ?? cfg.safesearch,
      category: params.category,
      timeoutMs: params.timeoutMs ?? cfg.timeoutMs ?? globalCfg.webSearchTimeoutMs,
    };

    try {
      const result = await webSearch(params.query, searchOpts);
      if (!result.ok) {
        this._addLog('tool://web-search', {
          mode: 'execute', action,
          params: { query: params.query, backend: resolvedBackend },
          status: 'error', error: result.error,
        });
        return { ok: false, error: result.error };
      }
      this._addLog('tool://web-search', {
        mode: 'execute', action,
        params: { query: params.query, backend: result.backend, count: result.results.length },
        status: 'success',
      });
      return {
        ok: true,
        mode: 'execute',
        tool: 'tool://web-search',
        action: 'search',
        backend: result.backend,
        query: params.query,
        count: result.results.length,
        results: result.results,
      };
    } catch (err) {
      this._addLog('tool://web-search', {
        mode: 'execute', action,
        params: { query: params.query, backend: resolvedBackend },
        status: 'error', error: err.message,
      });
      return { ok: false, error: err.message };
    }
  }

  async _execGBrain(action, params) {
    if (!isGBrainConfigured()) {
      return { ok: false, error: 'GBrain 未启用，请配置 GBRAIN_URL' };
    }
    switch (action) {
      case 'search': {
        if (!params.query) return { ok: false, error: '缺少必填参数 query' };
        const result = await gbrainSearch({ query: params.query, brainArea: params.brainArea });
        return { ok: result.ok, mode: 'execute', tool: 'tool://gbrain', result, error: result.error };
      }
      case 'think': {
        if (!params.question) return { ok: false, error: '缺少必填参数 question' };
        const result = await gbrainThink({ question: params.question, brainArea: params.brainArea });
        return { ok: result.ok, mode: 'execute', tool: 'tool://gbrain', result, error: result.error };
      }
      case 'capture': {
        if (!params.content) return { ok: false, error: '缺少必填参数 content' };
        const result = await gbrainCapture({ content: params.content, slug: params.slug, brainArea: params.brainArea });
        return { ok: result.ok, mode: 'execute', tool: 'tool://gbrain', result, error: result.error };
      }
      default:
        return { ok: false, error: `未知操作 "${action}"，可用: search, think, capture` };
    }
  }

  /**
   * 内部执行器：tool://timeline — 时间线 / 事件流
   *
   * 把 timeline-store 的同步 JSON 存储包成 ToolX 接口：
   *   add / list / show / update / delete / stats / export
   *
   * 所有路径都进 _addLog 方便通过 toolx(mode:"log", tool:"tool://timeline") 复查。
   */
  async _execTimeline(action, params) {
    const tool = 'tool://timeline';
    try {
      switch (action) {
        case 'add': {
          if (!params.title) return { ok: false, error: 'add 需要 title 参数' };
          const event = addEvent({
            title: params.title,
            time: params.time,
            description: params.description,
            category: params.category,
            tags: params.tags,
            source: params.source,
            metadata: params.metadata,
          });
          this._addLog(tool, {
            mode: 'execute', action,
            params: { title: event.title, category: event.category },
            status: 'success',
          });
          return {
            ok: true,
            mode: 'execute',
            tool,
            action: 'add',
            event,
          };
        }

        case 'list': {
          const events = listEvents({
            category: params.category,
            tags: params.tags,
            since: params.since,
            until: params.until,
            search: params.search,
            limit: params.limit,
          });
          this._addLog(tool, {
            mode: 'execute', action,
            params: { count: events.length, filters: Object.keys(params).length },
            status: 'success',
          });
          return {
            ok: true,
            mode: 'execute',
            tool,
            action: 'list',
            count: events.length,
            events,
          };
        }

        case 'show': {
          if (!params.id) return { ok: false, error: 'show 需要 id 参数' };
          const event = getEvent(params.id);
          if (!event) {
            this._addLog(tool, {
              mode: 'execute', action, params: { id: params.id },
              status: 'error', error: 'not found',
            });
            return { ok: false, error: `事件 ${params.id} 不存在` };
          }
          this._addLog(tool, {
            mode: 'execute', action, params: { id: params.id },
            status: 'success',
          });
          return { ok: true, mode: 'execute', tool, action: 'show', event };
        }

        case 'update': {
          if (!params.id) return { ok: false, error: 'update 需要 id 参数' };
          const { id, ...patch } = params;
          if (Object.keys(patch).length === 0) {
            return { ok: false, error: 'update 至少需要一个可更新字段' };
          }
          const updated = updateEvent(id, patch);
          this._addLog(tool, {
            mode: 'execute', action, params: { id, fields: Object.keys(patch) },
            status: 'success',
          });
          return { ok: true, mode: 'execute', tool, action: 'update', event: updated };
        }

        case 'delete': {
          if (!params.id) return { ok: false, error: 'delete 需要 id 参数' };
          const result = deleteEvent(params.id);
          if (!result.ok) {
            this._addLog(tool, {
              mode: 'execute', action, params: { id: params.id },
              status: 'error', error: result.error,
            });
            return { ok: false, error: result.error };
          }
          this._addLog(tool, {
            mode: 'execute', action, params: { id: params.id },
            status: 'success',
          });
          return { ok: true, mode: 'execute', tool, action: 'delete', removed: result.removed };
        }

        case 'stats': {
          const s = timelineStats();
          this._addLog(tool, {
            mode: 'execute', action,
            params: {}, status: 'success',
          });
          return { ok: true, mode: 'execute', tool, action: 'stats', ...s };
        }

        case 'export': {
          const format = params.format || 'markdown';
          const text = exportTimeline(format, {
            since: params.since,
            until: params.until,
            category: params.category,
          });
          this._addLog(tool, {
            mode: 'execute', action,
            params: { format, length: text.length },
            status: 'success',
          });
          return {
            ok: true,
            mode: 'execute',
            tool,
            action: 'export',
            format,
            length: text.length,
            content: text,
          };
        }

        default:
          return {
            ok: false,
            error: `timeline 不支持操作 "${action}"。可用: add, list, show, update, delete, stats, export`,
          };
      }
    } catch (err) {
      this._addLog(tool, {
        mode: 'execute', action,
        params: { ...params },
        status: 'error', error: err.message,
      });
      return { ok: false, error: err.message };
    }
  }

  async _execCustomTool(toolDef, action, params) {
    // 检查操作是否被定义
    const actionDef = toolDef.actions.find((a) => a.name === action);
    if (!actionDef) {
      const available = toolDef.actions.map((a) => a.name).join(', ');
      return { ok: false, error: `工具 ${toolDef.uri} 不支持操作 "${action}"。可用: ${available}` };
    }

    if (toolDef.execute) {
      try {
        const result = await toolDef.execute(action, params);
        this._addLog(toolDef.uri, { mode: 'execute', action, params, status: 'success' });
        return { ok: true, mode: 'execute', tool: toolDef.uri, action, result };
      } catch (err) {
        this._addLog(toolDef.uri, { mode: 'execute', action, params, status: 'error', error: err.message });
        return { ok: false, error: err.message };
      }
    }

    return { ok: true, mode: 'execute', tool: toolDef.uri, action, note: '自定义工具已注册，但未定义execute逻辑' };
  }

  // ──── 模式：configure ────

  _configure(tool, config) {
    if (!BUILTIN_TOOLS[tool]) {
      return { ok: false, error: `工具 ${tool} 不支持配置` };
    }

    const toolConfig = BUILTIN_TOOLS[tool].config;
    if (!toolConfig || Object.keys(toolConfig).length === 0) {
      return { ok: false, error: `工具 ${tool} 无可配置项` };
    }

    // 校验配置项
    const updated = {};
    for (const [key, value] of Object.entries(config)) {
      if (!toolConfig[key]) {
        return { ok: false, error: `未知配置项 "${key}"。${tool} 支持的配置: ${Object.keys(toolConfig).join(', ')}` };
      }
      updated[key] = value;
    }

    // 持久化
    if (!this._configStore[tool]) this._configStore[tool] = {};
    Object.assign(this._configStore[tool], updated);
    writeConfigStore(this._configStore);

    return { ok: true, mode: 'configure', tool, config: this._configStore[tool] };
  }

  // ──── 模式：dryrun ────

  async _dryrun(tool, toolName, params) {
    const { action, ...rest } = params;

    // 内置工具 - 生成预览描述
    switch (tool) {
      case 'tool://filesystem': {
        switch (action) {
          case 'read':
            return { ok: true, mode: 'dryrun', tool, action, description: `将读取文件: ${rest.path}` };
          case 'write':
            return { ok: true, mode: 'dryrun', tool, action, description: `将写入文件: ${rest.path} (${(rest.content || '').length} 字节)` };
          case 'list':
            return { ok: true, mode: 'dryrun', tool, action, description: `将列出目录: ${rest.path || '.'}` };
          case 'search':
            return { ok: true, mode: 'dryrun', tool, action, description: `将在文件中搜索: ${rest.pattern}` };
          case 'delete':
            return { ok: true, mode: 'dryrun', tool, action, description: `将删除: ${rest.path}` };
          default:
            return { ok: false, error: `文件系统不支持操作 "${action}"` };
        }
      }
      case 'tool://pdf-reader':
        return { ok: true, mode: 'dryrun', tool, action, description: `将从 PDF 提取文本: ${rest.path}` };
      case 'tool://excel-tool':
        return { ok: true, mode: 'dryrun', tool, action, description: `将读取 Excel: ${rest.path}${rest.sheet ? ` (sheet: ${rest.sheet})` : ''}` };
      case 'tool://word-tool':
        return { ok: true, mode: 'dryrun', tool, action, description: `将读取 Word 文档: ${rest.path}` };
      case 'tool://role-creator':
        return { ok: true, mode: 'dryrun', tool, action, description: `将执行角色操作: ${action}` };
      case 'tool://tool-creator': {
        switch (action) {
          case 'create_script':
            return {
              ok: true, mode: 'dryrun', tool, action,
              description: `将创建脚本工具 ${rest.uri}（name=${rest.name}），写入 src/toolx/custom/${rest.name}.js 并落盘`,
            };
          case 'list_files':
            return { ok: true, mode: 'dryrun', tool, action, description: `将列出落盘的自定义工具注册表` };
          case 'inspect':
            return { ok: true, mode: 'dryrun', tool, action, description: `将查看工具 ${rest.uri} 的元数据` };
          case 'delete':
            return { ok: true, mode: 'dryrun', tool, action, description: `将删除工具 ${rest.uri}（脚本归档到 .deleted.<ts>）` };
          case 'create':
            return { ok: true, mode: 'dryrun', tool, action, description: `将注册工具元数据 ${rest.uri}（仅内存，不写脚本）` };
          case 'list':
            return { ok: true, mode: 'dryrun', tool, action, description: `将列出当前进程所有自定义工具` };
          default:
            return { ok: false, error: `tool-creator 不支持操作 "${action}"` };
        }
      }
      case 'tool://web-fetch': {
        switch (action) {
          case 'get':
            return { ok: true, mode: 'dryrun', tool, action, description: `将 HTTP GET ${rest.url}（需 PERSENG_ALLOW_NETWORK=1）` };
          case 'head':
            return { ok: true, mode: 'dryrun', tool, action, description: `将 HTTP HEAD ${rest.url}（需 PERSENG_ALLOW_NETWORK=1）` };
          default:
            return { ok: false, error: `web-fetch 不支持操作 "${action}"` };
        }
      }
      case 'tool://web-search': {
        switch (action) {
          case 'search': {
            const backend = rest.backend || 'auto';
            const max = rest.maxResults || 10;
            return {
              ok: true,
              mode: 'dryrun',
              tool,
              action,
              description: `将用 ${backend} 后端搜索 "${rest.query}"（最多 ${max} 条，需 PERSENG_ALLOW_NETWORK=1）`,
            };
          }
          default:
            return { ok: false, error: `web-search 不支持操作 "${action}"` };
        }
      }
      case 'tool://timeline': {
        switch (action) {
          case 'add': {
            const cat = rest.category ? ` [${rest.category}]` : '';
            return {
              ok: true, mode: 'dryrun', tool, action,
              description: `将新增事件${cat}: ${rest.title}`,
            };
          }
          case 'list': {
            const filters = [];
            if (rest.category) filters.push(`category=${rest.category}`);
            if (rest.since) filters.push(`since=${rest.since}`);
            if (rest.until) filters.push(`until=${rest.until}`);
            if (rest.search) filters.push(`search="${rest.search}"`);
            const tail = filters.length ? `（过滤: ${filters.join(', ')}）` : '';
            return {
              ok: true, mode: 'dryrun', tool, action,
              description: `将列出事件${tail}`,
            };
          }
          case 'show':
            return { ok: true, mode: 'dryrun', tool, action, description: `将获取事件 ${rest.id}` };
          case 'update':
            return {
              ok: true, mode: 'dryrun', tool, action,
              description: `将更新事件 ${rest.id}（${Object.keys(rest).filter((k) => k !== 'id').join(', ')}）`,
            };
          case 'delete':
            return { ok: true, mode: 'dryrun', tool, action, description: `将删除事件 ${rest.id}` };
          case 'stats':
            return { ok: true, mode: 'dryrun', tool, action, description: `将统计时间线（总数、按 category 分组、最早/最新）` };
          case 'export': {
            const fmt = rest.format || 'markdown';
            return {
              ok: true, mode: 'dryrun', tool, action,
              description: `将导出时间线为 ${fmt} 格式`,
            };
          }
          default:
            return { ok: false, error: `timeline 不支持操作 "${action}"` };
        }
      }
    }

    // 自定义工具
    if (this._customTools.has(tool)) {
      return { ok: true, mode: 'dryrun', tool, action, description: `将在 ${tool} 上执行 ${action} 操作` };
    }

    return { ok: false, error: `工具 ${tool} 未找到` };
  }

  // ──── 模式：log ────

  _log(tool) {
    const entries = this._logs
      .filter((entry) => entry.tool === tool)
      .slice(-50); // 保留最近 50 条

    return {
      ok: true,
      mode: 'log',
      tool,
      total: entries.length,
      entries: entries.map((e) => ({
        timestamp: e.timestamp,
        mode: e.mode,
        action: e.action,
        status: e.status,
        ...(e.error ? { error: e.error } : {}),
        ...(e.reason ? { reason: e.reason } : {}),
      })),
    };
  }

  // ──── 辅助方法 ────

  _addLog(tool, entry) {
    this._logs.push({
      tool,
      timestamp: new Date().toISOString(),
      ...entry,
    });
    // 防止内存泄漏，最多保留 1000 条
    if (this._logs.length > 1000) {
      this._logs = this._logs.slice(-500);
    }
  }

  async _searchInFiles(searchPath, pattern, glob) {
    const { readdir, readFile, stat } = await import('fs/promises');
    const { resolve, sep } = await resolvePath();

    let regex;
    try { regex = new RegExp(pattern, 'g'); } catch (err) {
      return `无效搜索模式: ${err.message}`;
    }

    // 将 glob 转为正则（简化版）
    const escapeGlob = (s) => s.replace(/[.+^${}()|\[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const globRegex = new RegExp(`^${escapeGlob(glob)}$`);

    const matches = [];
    const visit = async (dir) => {
      try {
        const items = await readdir(dir);
        for (const item of items) {
          const fullPath = resolve(dir, item);
          try {
            const s = await stat(fullPath);
            if (s.isDirectory()) {
              await visit(fullPath);
            } else if (s.isFile() && globRegex.test(item)) {
              const content = await readFile(fullPath, 'utf-8').catch(() => '');
              const lines = content.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                regex.lastIndex = 0;
                if (regex.test(lines[i])) {
                  matches.push(`${fullPath}:${i + 1}:${lines[i]}`);
                  if (matches.length >= 100) return;
                }
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    };

    await visit(searchPath);
    return matches.length > 0 ? matches.join('\n') : '未找到匹配';
  }
}

// ──── 模块级辅助 ────

async function resolvePath() {
  const { resolve, sep } = await import('path');
  return { resolve, sep };
}

/**
 * 安全尝试 import 一个模块，失败返回 null
 */
async function tryImport(moduleName) {
  try {
    const mod = await import(moduleName);
    return mod.default || mod;
  } catch {
    return null;
  }
}

function toolName(uri) {
  return uri.replace('tool://', '');
}
