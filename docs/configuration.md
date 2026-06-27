# 配置说明

`perseng-cli` 现在统一通过同一套配置链路加载运行参数：

1. 项目根 `.env`
2. 若 `.env` 不存在，则回退项目根 `.evn`
3. 进程级 `process.env`
4. `~/.perseng-cli/config.json`
5. 内置默认值

注意：
- 实际优先级是 `process.env / .env > config.json > default`
- `.env` 加载时不会覆盖已存在的进程环境变量
- `config.json` 只会覆盖“非空值”，避免空字符串误覆盖有效环境配置

## 常用排查

- 查看配置健康：`node bin/perseng.js doctor --mode all`
- 查看关键配置来源：`node bin/perseng.js doctor --show-config-sources`
- JSON 输出：`node bin/perseng.js doctor --show-config-sources --json`
- 参考模板：项目根 `.env.example`

## 关键配置

### Core

- `PERSENG_ROLE`: 默认角色 ID
- `PERSENG_MODEL`: 默认模型名
- `PERSENG_MODEL_IDLE/GOAL/PLANNING/EXECUTION/REFLECTION`: 生命周期阶段模型覆盖

### LLM

- `ANTHROPIC_API_KEY`: Anthropic Key
- `OPENAI_API_KEY`: OpenAI 兼容 Key
- `PERSENG_API_BASE`: OpenAI 兼容端点，例如 Moonshot / DeepSeek / OpenRouter
- `PERSENG_LLM_RETRY`: 是否启用 retry，`1` 启用，`0` 关闭
- `PERSENG_LLM_MAX_RETRIES`: 最大重试次数
- `PERSENG_LLM_BASE_DELAY_MS`: 基础退避时间

### Feishu

- `FEISHU_APP_ID`: 飞书应用 App ID
- `FEISHU_APP_SECRET`: 飞书应用 App Secret
- `FEISHU_BOT_OPEN_ID`: 机器人 open_id
- `PERSENG_FEISHU_ALLOW_USERS`: 允许访问的用户 ID，逗号分隔
- `PERSENG_FEISHU_ALLOW_GROUPS`: 允许访问的群 ID，逗号分隔
- `PERSENG_FEISHU_ROLE_ADMINS`: 允许切换角色的管理员列表
- `PERSENG_ASR_MODEL`: 语音转写模型

### GBrain

- `GBRAIN_URL`: GBrain 服务 URL
- `GBRAIN_HTTP_TOKEN`: GBrain Bearer Token
- `GBRAIN_BRAIN_AREA`: 默认脑区
- `GBRAIN_TIMEOUT_MS`: 请求超时毫秒数

### HTTP / WebUI

- `PERSENG_HTTP_HOST`: HTTP 管理服务监听地址
- `PERSENG_HTTP_PORT`: HTTP 管理服务端口
- `PERSENG_HTTP_TOKEN`: HTTP / WebSocket 鉴权 token
- `PERSENG_HTTP_MAX_SESSIONS`: 最大 Web 会话数

### Storage

- `PERSENG_CLI_DATA_DIR`: 统一数据根目录
- `PERSENG_CLI_COGNITION_DIR`: cognition 目录覆盖
- `PERSENG_CLI_ROLEX_DIR`: rolex 目录覆盖
- `PERSENG_CLI_BLACKBOARD_DIR`: blackboard 目录覆盖
- `PERSENG_CLI_TIMELINE_DIR`: timeline 目录覆盖

### Policy

- `PERSENG_ALLOW_NETWORK`: 是否允许外网访问
- `PERSENG_ALLOW_PATH_OUTSIDE_CWD`: 是否允许访问工作目录外路径
- `PERSENG_BLOCK_RUN_COMMAND`: 是否禁用 `run_command`
- `PERSENG_RUN_COMMAND_ALLOWLIST`: 允许执行的命令白名单，逗号分隔
- `PERSENG_FOLLOW_SYMLINKS`: 是否跟随符号链接

### Observability

- `PERSENG_DEBUG`: 是否启用 debug 模式
- `PERSENG_LOG_LEVEL`: `trace|debug|info|warn|error|fatal`
- `PERSENG_LOG_PRETTY`: 是否启用可读日志格式

### Limits

- `PERSENG_MAX_MEMORIES_PER_ROLE`: 每角色最大记忆数
- `PERSENG_ROLES_CACHE_LIMIT`: 角色缓存上限

## 配置来源判定

`doctor --show-config-sources` 会对关键配置项输出来源：

- `env-file`: 来自项目根 `.env` 或 `.evn`
- `process-env`: 来自外部进程环境变量
- `config-file`: 来自 `~/.perseng-cli/config.json`
- `default`: 使用内置默认值

这可以直接定位“为什么当前运行值不是我以为的那个值”。
