# PersEng CLI

> **带角色生态的智能代理 CLI — Claude / GPT 双驱动，可被 Multica / 飞书 调度。**

[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#-许可证)
[![Version](https://img.shields.io/badge/version-1.0.0-orange)](./package.json)
[![Roles](https://img.shields.io/badge/roles-6_v2-purple)](./roles/index.json)

`perseng-cli`（二进制命令 `perseng`）是一个以"**角色**"为第一公民的 Node.js 命令行 AI 代理。它自动识别 `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY`，通过 NDJSON over stdio 与 [Multica](https://multica.ai) daemon 对接，并自带飞书 WebSocket 机器人、ToolX 工具协议、跨 Agent 黑板、SQLite 持久化记忆、联想图谱（Network）等能力。

> 🔖 本项目是从 `promptx-cli` 整体重命名而来（2026-06）。`@promptx/core` 第三方包仍保留。

---

## ✨ 特性

| 类别 | 能力 |
|---|---|
| **双 Provider** | 自动检测 Anthropic / OpenAI 兼容 API（Moonshot / DeepSeek / OpenRouter 等） |
| **角色生态** | `roles/*.json` 定义人格 / 思维 / 原则 / 知识域 / 路由目标，每次任务自动注入 system prompt |
| **V2/RoleX** | `action / lifecycle / organization / policy` 四类操作 — 激活、目标、组织、阶段策略 |
| **认知记忆** | SQLite + 联想图谱（cue_index + recall energy 传播）+ LRU 淘汰 |
| **ToolX 协议** | `tool:// URI` 抽象，6 模式（discover / manual / execute / dryrun / configure / log） |
| **飞书机器人** | WebSocket 长连接 · 多租户隔离 · cron 主动推送 · 回复去重（含 LLM echo 检测） |
| **子代理路由** | 把任务分派给 `claude-code` / `codex` / `openclaw` / `hermes` |
| **跨 Agent 黑板** | 多角色间的私聊 / 公共频道通信 |
| **纵深防御** | 命令白名单 · 子进程 env 过滤 · 路径边界 · symlink 跳过 · NDJSON DoS 防护 |
| **可观测性** | Prometheus 指标（`perseng_*` 前缀）+ `doctor` 一键自检 + HTTP 管理接口 |
| **协议兼容** | Multica NDJSON over stdio（v1 协议 + Claude Code 兼容输出） |

---

## 🚀 Quickstart

### 1. 安装

```bash
# 要求 Node.js >= 20
git clone https://github.com/perseng-ai/perseng-cli.git
cd perseng-cli
npm install

# 或本地一次性使用
npx perseng-cli --help
```

### 2. 配置 API Key

```bash
cp .env.example .env

# 至少设置一项（Anthropic 优先）
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
# 或 OpenAI 兼容（含 Moonshot / DeepSeek / OpenRouter）
echo "OPENAI_API_KEY=sk-..." >> .env
echo "PERSENG_API_BASE=https://api.moonshot.cn/v1" >> .env
```

> ⚠️ `.env` 在 `.gitignore` 中。**真实 key 切勿 commit**；建议放在 `~/.perseng-cli.env` 或 shell profile。

### 3. 运行第一个任务

```bash
# 直接模式（人类使用）
npx perseng run "用一句话介绍 TypeScript 的泛型"

# 指定角色
npx perseng run "分析这个 bug" --role jiangziya

# 指定模型
npx perseng run "写一首诗" --model kimi-k2.6

# Multica daemon 兼容输出
npx perseng run "task" --output-format json
```

### 4. 守护模式（与 Multica 集成）

```bash
npx perseng serve --role jiangziya
# 进入 NDJSON over stdin/stdout 协议，详见 docs/protocol.md
```

### 5. 飞书机器人

```bash
export FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
npx perseng feishu          # 启动 WS 长连接
# 或 npx perseng feishu-register   # 扫码一键授权（无需手动创建应用）
```

### 6. WebUI 聊天面板

```bash
# 启动 HTTP + WebSocket 服务（默认端口 7717）
npx perseng serve-http

# 开发模式：启动前端开发服务器（另开终端）
cd webui && npm run dev
# 访问 http://localhost:5173

# 生产模式：先构建再启动
cd webui && npm run build
npx perseng serve-http
# 访问 http://127.0.0.1:7717
```

完整指南：[docs/webui-guide.md](./docs/webui-guide.md)

---

## 🎭 内置角色（V2）

所有角色 schema 为 **V2**（`type: "v2"`），通过 `roles/index.json` 注册：

| ID | 名称 | 简介 |
|---|---|---|
| `jiangziya` | 姜子牙 | 领导代理 / 战略分析 — 辅佐者心态、战略大局观、识人用人、哲学思辨 |
| `nuwa` | 女娲 | 角色创造者 — AI 角色铸造师 |
| `luban` | 鲁班 | AI 工具集成专家 — 工具铸造师 |
| `boduan` | 波段猎手 | 波段交易专家 — 趋势跟踪 + 动量交易 |
| `rotation` | Sector Rotation Catcher | 行业轮动分析 — 追踪资金流向、捕捉板块轮动 |
| `hr` | 人力资源官 | AI 团队人才架构师 — 懂角色、善匹配、建组织 |

> 当前仓库内**没有 V1 角色**。`PERSENG_ENABLE_V2=0` 不会切换到 V1 角色框架，只是关闭 RoleX 调度器（所有角色仍按 V2 schema 加载）。

```bash
npx perseng role list                  # 查看所有角色
npx perseng role show jiangziya        # 角色详情
npx perseng role activate jiangziya    # 设为默认
```

新增角色：在 `roles/<id>.json` 写一份合规 schema，然后在 `roles/index.json` 注册。

---

## 📖 命令一览

> 所有命令支持 `-h` / `--help` 查看详细参数。

| 命令 | 说明 |
|---|---|
| `perseng run <task>` | 直接运行一个任务 |
| `perseng serve` | 启动 Multica 兼容守护模式（NDJSON over stdio） |
| `perseng action -o <op> -r <role>` | V2/RoleX 操作（activate / born / identity …） |
| `perseng lifecycle -o <op> -r <role>` | 目标与任务（want / plan / todo / finish / achieve / abandon / focus） |
| `perseng organization -o <op> -r <role>` | 组织 / 职位 / 个体（found / hire / establish / appoint …） |
| `perseng policy` | 查看或设置生命周期阶段 → 模型策略 |
| `perseng toolx discover` | 列出所有可用工具 |
| `perseng toolx manual -t <uri>` | 查看工具文档 |
| `perseng toolx exec -t <uri> -a <action>` | 执行工具 |
| `perseng toolx dryrun -t <uri> -a <action>` | 预览执行 |
| `perseng toolx configure -t <uri> -k <key> -v <val>` | 配置工具参数 |
| `perseng toolx log -t <uri>` | 查看工具执行历史 |
| `perseng feishu` | 启动飞书机器人（WebSocket 长连接） |
| `perseng feishu-push` | 启动飞书主动推送调度器（cron-based） |
| `perseng feishu-multi -c <config>` | 多飞书 bot（多租户、错误隔离） |
| `perseng feishu-register` | 扫码一键创建 / 授权飞书应用 |
| `perseng memory` | 记忆管理（list / show / forget / stats） |
| `perseng role` | 角色管理（list / show / activate / edit / reload） |
| `perseng doctor` | 一键自检（配置 / 模型 / systemd） |
| `perseng metrics` | 输出 Prometheus 指标（默认 stderr） |
| `perseng serve-http` | HTTP 管理接口（`/status` `/metrics` `/roles` `/memory`） |

---

## ⚙️ 环境变量

### API 凭证（必填其一）

| 变量 | 说明 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic Claude API Key（优先） |
| `OPENAI_API_KEY` | OpenAI 兼容 API Key（Moonshot / DeepSeek / OpenRouter …） |
| `PERSENG_API_BASE` | OpenAI 兼容 API 端点（仅 OpenAI 模式） |

### 模型与角色

| 变量 | 默认 | 说明 |
|---|---|---|
| `PERSENG_MODEL` | `claude-sonnet-4-20250514` | 默认模型 |
| `PERSENG_ROLE` | `jiangziya` | 默认角色 |
| `PERSENG_MODEL_IDLE / GOAL / PLANNING / EXECUTION / REFLECTION` | — | 各阶段模型策略 |

### 飞书

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用凭据 |
| `FEISHU_BOT_OPEN_ID` | 机器人自己的 open_id（精确 @ 判定；缺省宽松匹配） |
| `PERSENG_FEISHU_ALLOW_USERS` | 用户白名单（逗号分隔；空 = 全部） |
| `PERSENG_FEISHU_ALLOW_GROUPS` | 群白名单（逗号分隔；空 = 全部） |

### Multica 集成

| 变量 | 说明 |
|---|---|
| `MULTICA_TOKEN` / `MULTICA_SERVER_URL` / `MULTICA_WORKSPACE_ID` | Multica daemon 凭据与工作区 |

### 安全（纵深防御）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PERSENG_BLOCK_RUN_COMMAND` | `0` | `1` = 全局禁用 `run_command` 工具 |
| `PERSENG_RUN_COMMAND_ALLOWLIST` | — | 命令白名单（如 `multica,git`） |
| `PERSENG_ALLOW_PATH_OUTSIDE_CWD` | `0` | `1` = 允许 `read_file` / `write_file` 逃出 cwd |
| `PERSENG_FOLLOW_SYMLINKS` | `0` | `1` = `grep_search` 跟随符号链接 |
| `PERSENG_SPAWN_PASSTHROUGH_KEYS` | — | 额外透传给子进程的 env key |

### 性能与缓存

| 变量 | 默认 | 说明 |
|---|---|---|
| `PERSENG_MAX_MEMORIES_PER_ROLE` | `500` | 每角色最大记忆数（超出 LRU 淘汰） |
| `PERSENG_ROLES_CACHE_LIMIT` | `32` | 角色 LRU 缓存上限 |
| `PERSENG_CLI_COGNITION_DIR` | `~/.perseng-cli/cognition` | 认知数据目录 |
| `PERSENG_CLI_ROLEX_DIR` | `~/.perseng-cli/rolex` | 角色生命周期目录 |
| `PERSENG_CLI_BLACKBOARD_DIR` | `~/.perseng-cli/blackboard` | 跨 Agent 黑板目录 |

### 调试与开关

| 变量 | 默认 | 说明 |
|---|---|---|
| `PERSENG_DEBUG` | `0` | `1` = 打印完整 stack |
| `PERSENG_ENABLE_V2` | `1` | `0` = 禁用 V2/RoleX（等价 `--no-v2`） |
| `PERSENG_LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `PERSENG_LOG_PRETTY` | `0` | `1` = 人类可读输出（开发时） |
| `NO_COLOR` | — | 设置后禁用 ANSI 颜色 |

---

## 🗂️ 数据目录

数据默认存放在 `~/.perseng-cli/`：

```
~/.perseng-cli/
├── cognition/<roleId>/
│   ├── engrams.db          # SQLite 记忆
│   └── network.json        # 联想图谱
├── rolex/
│   ├── active.json         # 当前激活角色
│   └── lifecycle-state.json
├── blackboard/
│   └── blackboard.db       # 跨 agent 通信
└── config.json             # 用户配置（运行时保存）
```

**重要**：项目**不**自动迁移旧路径。仍持 `~/.promptx-cli/` 或 `~/.perseng-memory/` 的用户：
- `perseng` 会以**读时回退**方式继续访问旧数据（不丢失、不复制）
- `perseng doctor` 会列出检测到的旧路径，并提示手动 `mv`
- 手动迁移：`mv ~/.promptx-cli ~/.perseng-cli && mv ~/.perseng-memory ~/.perseng-cli/memory-v1`

可用 `PERSENG_CLI_DATA_DIR` / `PERSENG_CLI_COGNITION_DIR` / `PERSENG_CLI_ROLEX_DIR` / `PERSENG_CLI_BLACKBOARD_DIR` 覆盖。

---

## 🧪 测试

```bash
npm test                          # node --test（28+ 用例）
node --test test/                 # 同上
node --test test/feishu-adapter.test.js   # 单文件
```

测试覆盖：role-loader · source-normalizer · tool-runtime · task-engine · rolex-dispatcher-loader · serve 集成 · 安全修复 · feishu adapter / session / integration / push-scheduler / multi / bot-runner · blackboard · memory-store · prompt-builder · agent-tools · **回复去重（D1-D11）**。

---

## 🔌 集成协议

| 协议 | 文档 | 说明 |
|---|---|---|
| **启动指南** | [docs/start-guide.md](./docs/start-guide.md) | **按场景分类的启动命令：本地开发 / WebUI / 飞书单租户 / 飞书多租户 / Multica** |
| Multica NDJSON over stdio | [docs/protocol.md](./docs/protocol.md) | v1 主协议 + Claude Code 兼容输出子集 |
| 飞书 WebSocket | [docs/feishu-integration.md](./docs/feishu-integration.md) | 事件 / @ 判定 / Session 隔离 / 3 秒 ack / **回复去重** |
| 飞书多租户 | [docs/feishu-multi-tenant.md](./docs/feishu-multi-tenant.md) | `feishu-multi` 改造评估 · 5 场景实施清单 · 规模-工作量对照 |
| GBrain HTTP | [docs/gbrain-integration.md](./docs/gbrain-integration.md) | `search / think / capture` 三类能力、环境变量、自动注入链路与排障 |
| ToolX Protocol | （代码 + `toolx` 子命令） | `tool:// URI` 抽象，6 模式 |
| WebUI | [docs/webui-guide.md](./docs/webui-guide.md) | React + TypeScript 聊天面板，开发/生产双模式启动 |

---

## 🏗️ 架构

```
                 ┌──────────────┐
                 │   bin/       │  ← CLI 入口 (perseng.js)
                 └──────┬───────┘
                        ▼
       ┌────────────────────────────┐
       │     src/main.js            │  Commander 解析 + 路由
       └────┬─────┬─────┬─────┬─────┘
            │     │     │     │
            ▼     ▼     ▼     ▼
         run   serve  feishu  toolx ...
            │     │     │
            └─────┴─────┴──→ TaskEngine
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
          LlmClient    ToolRuntime    Cognition
          (Anthropic   (read/write/   (MemoryStore
          + OpenAI     run/grep/...)  + Network)
          compatible)        │
                              ▼
                       AgentRouter
                       (claude-code/
                        codex/openclaw/
                        hermes)
                              │
                              ▼
                       RoleX V2
                       (action/lifecycle/
                        organization/policy)
```

详见 `src/` 目录各文件头注释。

---

## 🚢 部署

> ⚠️ 旧版部署脚本/服务名（如 `promptx-feishu.service`、`Dockerfile.promptx`）已废弃，请使用以下新名。

### A. systemd（推荐单租户云服务器）

```bash
# 1. 准备目录
sudo useradd --system --home /opt/perseng-cli --shell /usr/sbin/nologin perseng
sudo mkdir -p /opt/perseng-cli /var/lib/perseng-cli /etc/perseng-cli
sudo chown -R perseng:perseng /opt/perseng-cli /var/lib/perseng-cli /etc/perseng-cli

# 2. 部署代码
sudo -u perseng git clone https://github.com/perseng-ai/perseng-cli.git /opt/perseng-cli
cd /opt/perseng-cli && sudo -u perseng npm ci --omit=dev

# 3. 写入凭据（mode 0600）
sudo tee /etc/perseng-cli/.env >/dev/null <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
PERSENG_ROLE=jiangziya
EOF
sudo chmod 0600 /etc/perseng-cli/.env
sudo chown perseng:perseng /etc/perseng-cli/.env

# 4. 安装 service（已提供 systemd/perseng-feishu.service）
sudo cp systemd/perseng-feishu.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now perseng-feishu
sudo journalctl -u perseng-feishu -f
```

完整步骤与故障排查：[docs/deploy-cloud-server.md](./docs/deploy-cloud-server.md)

### B. Docker / Docker Compose

```bash
# 构建并运行（单容器）
docker build -f Dockerfile.feishu -t perseng-feishu:latest .
docker run -d --name perseng-feishu --env-file .env -v perseng-data:/data perseng-feishu:latest

# 或 docker compose（推荐）
docker compose -f docker-compose.feishu.yml up -d
```

Compose 配置：[docker-compose.feishu.yml](./docker-compose.feishu.yml)，文档：[docs/deploy-docker-compose.md](./docs/deploy-docker-compose.md)

### C. 阿里云 / 腾讯云专线

国内云厂商上线的特殊配置（镜像源、备案、回调地址等）见 [docs/deploy-aliyun-tencent.md](./docs/deploy-aliyun-tencent.md)。

---

## 🛡️ 安全

- **命令白名单**：`run_command` 默认拒绝所有命令；通过 `PERSENG_RUN_COMMAND_ALLOWLIST=git,multica,...` 显式放行
- **路径边界**：`read_file` / `write_file` 默认禁止逃出 cwd（`PERSENG_ALLOW_PATH_OUTSIDE_CWD=1` 可放宽）
- **子进程 env**：白名单模式，仅透传安全 env（`PERSENG_SPAWN_PASSTHROUGH_KEYS` 可增补）
- **NDJSON DoS 防护**：单行最大 1 MB · 缓冲最大 10 MB（超出进入 overflow 状态）
- **符号链接**：`grep_search` 默认不跟随（`PERSENG_FOLLOW_SYMLINKS=1` 可放开）
- **凭据管理**：`FEISHU_APP_SECRET` / `API Key` 通过环境变量注入；`.env` 永远在 `.gitignore`

完整审计记录（含 25 个新回归测试）见 [AUDIT-REPORT.md](./AUDIT-REPORT.md)。

---

## 🩺 故障排查

```bash
# 一键自检：检测 .env / 数据目录 / systemd / 旧路径
perseng doctor

# 实时指标
perseng metrics

# HTTP 管理接口
perseng serve-http --port 9090
curl http://localhost:9090/metrics
```

| 现象 | 建议 |
|---|---|
| `Authentication failed` | 检查 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 是否正确，`doctor` 会先于 send 验证 |
| 飞书 bot 启动后无响应 | 确认 `FEISHU_BOT_OPEN_ID`（群聊 @ 判定需要）；`doctor` 检查 systemd |
| 同一回复发两次 | 飞书侧有 LLM echo 防护（`enableEchoStrip`，默认开）；调小 `dedupTtlMs` 关闭 |
| 数据找不到 | 旧路径用户：`doctor` 会列旧路径；不自动迁移，请手动 `mv` |
| 监控断点 | Prometheus 指标从 `promptx_*` 改为 `perseng_*`（破坏性变更），需同步更新 scrape config |

---

## 📦 项目结构

```
perseng-cli/
├── bin/perseng.js              ← CLI 入口
├── src/
│   ├── main.js                 ← Commander 路由
│   ├── task-engine.js          ← 单任务执行
│   ├── llm-client.js           ← Provider 抽象
│   ├── llm-providers/          ← Anthropic / OpenAI 实现
│   ├── tool-runtime.js         ← ToolX 调度
│   ├── toolx/                  ← 内置工具（read_file / write_file / run_command / …）
│   ├── cognition/              ← MemoryStore + Network
│   ├── rolex/                  ← RoleX V2 调度器
│   ├── feishu-*.js             ← 飞书集成
│   └── commands/               ← 各子命令实现
├── roles/                      ← 6 个 V2 角色 JSON
├── docs/                       ← 协议 / 部署 / 飞书 SOP
├── systemd/                    ← systemd unit 文件
├── Dockerfile.feishu           ← 飞书容器镜像
├── docker-compose.feishu.yml   ← 飞书 compose
└── test/                       ← node --test 测试套件
```

---

## 🤝 贡献

欢迎 PR / Issue。

1. 修改前阅读 [AGENTS.md](./AGENTS.md)（包含代码结构 + 工作约定）
2. 本地跑通 `npm test` 再提 PR
3. 角色改动：在 `roles/<id>.json` 改完后**同步更新** `roles/index.json`
4. 协议变更：先开 Issue 讨论，影响范围（Multica / 飞书 / 监控）

---

## 📄 许可证

MIT — 详见 [LICENSE](./LICENSE)（如未提供则以 `package.json` `license: MIT` 为准）

---

## 🙏 致谢

- [Anthropic Claude](https://www.anthropic.com) — 默认模型
- [OpenAI](https://openai.com) — 兼容协议参考
- [Moonshot](https://www.moonshot.cn) / [DeepSeek](https://www.deepseek.com) — 国内 LLM 提供方
- [Multica](https://multica.ai) — NDJSON 协议与 daemon
- [飞书开放平台](https://open.feishu.cn) — WebSocket 长连接接入
- [`@promptx/core`](https://www.npmjs.com/package/@promptx/core) — 第三方角色生态依赖（保留旧名）
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) / [pino](https://getpino.io) — 关键底层库
