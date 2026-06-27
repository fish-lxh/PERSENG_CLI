# Multica NDJSON Protocol

> `perseng-cli` 与 Multica daemon 之间通过 **NDJSON over stdin/stdout** 通信。本文档描述完整的消息类型、字段约定、错误处理与时序。

---

## 1. 协议概览

| 通道 | 方向 | 内容 |
|---|---|---|
| **stdin** | daemon → perseng | NDJSON 任务分配、取消、心跳 |
| **stdout** | perseng → daemon | NDJSON 流式输出（文本 / 状态 / 工具调用 / 错误） |
| **stderr** | perseng → daemon | 调试日志（人类可读，daemon 不解析） |

**传输规则**：
- 每条消息是单个 JSON 对象 + `\n` 换行（`\n` 是唯一的帧边界）
- **必须**用 UTF-8 编码
- **不要**给一行消息加额外换行
- 大小写敏感：`type` 字段值是枚举字符串

**安全防护**：
- 单行最大 1 MB（超出丢弃该行并发 `error` 消息）
- 总 buffer 最大 10 MB（超出后整条连接进入 overflow 状态，新输入直接丢弃直到重连）

---

## 2. 启动时握手

daemon 启动 `perseng serve` 进程后，perseng 会立即发送：

```json
{ "type": "status", "status": "ready",           "message": "PersEng agent ready", "sessionId": "..." }
{ "type": "status", "status": "role_loaded",     "message": "Role: jiangziya",     "sessionId": "..." }
```

daemon 应等待 `ready` 状态后再发送 `task` 消息。

---

## 3. 输入消息（daemon → perseng）

### 3.1 `task` — 分配任务

```json
{
  "type": "task",
  "id": "task-42",
  "prompt": "分析这个 bug 的根因",
  "role": "jiangziya",
  "model": "claude-sonnet-4-20250514",
  "context": {
    "memories": [],          // 可选：预加载记忆（通常由 perseng 自己 recall）
    "cwd": "/path/to/work",  // 可选：任务工作目录
    "metadata": {}           // 可选：透传给 TaskEngine 的额外字段
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | string | ✅ | 固定 `"task"` |
| `id` | string | ❌ | 任务 ID；不填则 perseng 自动生成 `task-<timestamp>` |
| `prompt` | string | ✅ | 任务描述（用户输入） |
| `role` | string | ❌ | 角色 ID（如 `jiangziya`）；不填则用启动时的 `--role` |
| `model` | string | ❌ | 覆盖默认模型（最高优先级，覆盖生命周期阶段策略） |
| `context` | object | ❌ | 透传给 TaskEngine.run 的 context |

### 3.2 `cancel` — 取消任务

```json
{ "type": "cancel", "taskId": "task-42" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | string | ✅ | 固定 `"cancel"` |
| `taskId` | string | ❌ | 要取消的任务 ID；不填则提示 `unknown` |

### 3.3 `ping` — 心跳

```json
{ "type": "ping" }
```

perseng 立即回复 `pong`：

```json
{ "type": "pong", "timestamp": 1719225600000, "sessionId": "..." }
```

---

## 4. 输出消息（perseng → daemon）

所有输出消息都带 `sessionId`（启动时生成，标识本次 daemon ↔ perseng 会话）。

### 4.1 `text` — 流式文本

```json
{ "type": "text", "content": "这是", "sessionId": "..." }
{ "type": "text", "content": "一部分", "sessionId": "..." }
{ "type": "text", "content": "文本", "sessionId": "..." }
```

LLM 流式输出，按 chunk 增量推送。

### 4.2 `thinking` — 思维链（Anthropic extended thinking）

```json
{ "type": "thinking", "content": "我需要先解析用户输入...", "sessionId": "..." }
```

仅 Anthropic 支持；OpenAI / DeepSeek 等不会发。

### 4.3 `status` — 状态变更

```json
{ "type": "status", "status": "task_received", "message": "Task task-42 received", "sessionId": "..." }
{ "type": "status", "status": "loading_memory", "message": "Loading relevant memories...", "sessionId": "..." }
{ "type": "status", "status": "processing",     "message": "Processing task with AI...", "sessionId": "..." }
{ "type": "status", "status": "completed",      "message": "Task task-42 completed", "sessionId": "..." }
{ "type": "status", "status": "failed",         "message": "Error: ...", "sessionId": "..." }
{ "type": "status", "status": "cancelled",      "message": "Task task-42 cancelled", "sessionId": "..." }
{ "type": "status", "status": "shutting_down",  "message": "Reason: SIGTERM", "sessionId": "..." }
```

`status` 字段是枚举，可能值：

| 值 | 含义 |
|---|---|
| `ready` | 启动就绪（首次握手） |
| `role_loaded` | 角色加载完成 |
| `task_received` | 收到 task 消息 |
| `loading_memory` | 正在检索记忆 |
| `processing` | LLM 调用中 |
| `completed` | 任务成功完成 |
| `failed` | 任务失败（伴随 `error` 消息） |
| `cancelled` | 任务被取消 |
| `shutting_down` | 守护进程正在退出 |

### 4.4 `tool-use` — 工具调用

```json
{
  "type": "tool-use",
  "tool": "read_file",
  "callId": "toolu_01ABC",
  "input": { "path": "src/main.js" },
  "sessionId": "..."
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `tool` | string | 工具名（`read_file` / `write_file` / `run_command` / `grep_search` / `route_to_agent` / `agent_message` 等） |
| `callId` | string | Anthropic tool_use_id / OpenAI tool_call_id |
| `input` | object | 工具参数（与工具 schema 一致） |

### 4.5 `tool-result` — 工具结果

```json
{
  "type": "tool-result",
  "callId": "toolu_01ABC",
  "output": "import { ... }",
  "sessionId": "..."
}
```

### 4.6 `error` — 错误

```json
{ "type": "error", "content": "NDJSON line too long (max 1048576 bytes); skipping", "sessionId": "..." }
```

- 协议层错误（NDJSON 解析失败、消息过大等）走 `error`
- 任务执行错误先发 `status: failed`，再发 `error`

### 4.7 `log` — 日志

```json
{ "type": "log", "level": "info", "content": "...", "sessionId": "..." }
```

`level` ∈ `info` / `warn` / `error` / `debug`。daemon 可选择性地记录到日志系统，不强制要求实现。

### 4.8 `pong` — ping 响应

见 §3.3。

---

## 5. 任务生命周期时序

```
daemon                          perseng-cli
  │                                 │
  │──── spawn serve ──────────────►│
  │                                 │
  │◄─── status: ready ─────────────│
  │◄─── status: role_loaded ───────│
  │                                 │
  │──── task { id, prompt } ──────►│
  │                                 │
  │◄─── status: task_received ─────│
  │◄─── status: loading_memory ────│
  │                                 │
  │      (可选)                     │
  │◄─── tool-use { read_file } ────│
  │◄─── tool-result { ... } ───────│
  │      (循环)                     │
  │                                 │
  │◄─── status: processing ────────│
  │◄─── text "片段1" ──────────────│
  │◄─── text "片段2" ──────────────│
  │◄─── ...                        │
  │                                 │
  │◄─── status: completed ─────────│
  │                                 │
  │──── cancel { taskId } ────────►│ (可选)
  │◄─── status: cancelled ─────────│
  │                                 │
  │──── SIGTERM ──────────────────►│
  │◄─── status: shutting_down ─────│
  │──── process exit ─────────────►│
```

---

## 6. Multica Daemon 兼容子集（`perseng run --output-format json`）

> 这是 Multica daemon 直接调用 `perseng run` 而非 `serve` 时的协议子集。**与 `serve` 模式不同**，消息格式更接近 Claude Code CLI。

### 输入

无 stdin 交互；任务通过 CLI 参数传入：

```bash
perseng run "task description" --output-format json
```

### 输出（stdout NDJSON）

```json
{ "type": "session.start",       "data": { "sessionId": "perseng-abc", "selectedModel": "claude-sonnet-4-20250514" } }
{ "type": "assistant.message_delta", "data": { "deltaContent": "这是第一行\n" } }
{ "type": "assistant.message_delta", "data": { "deltaContent": "这是第二行\n" } }
{ "type": "result",              "sessionId": "perseng-abc", "exitCode": 0 }
```

### 错误（stdout NDJSON + 非零 exit code）

```json
{ "type": "session.start",       "data": { "sessionId": "perseng-abc", "selectedModel": "" } }
{ "type": "session.error",       "data": { "errorType": "config_error", "message": "..." } }
{ "type": "result",              "sessionId": "perseng-abc", "exitCode": 1 }
```

`errorType` 枚举：`config_error` / `execution_error` / `internal_error`

---

## 7. 错误码约定

`error.content` / `session.error.message` 字段是**人类可读字符串**。daemon 应通过以下关键字做语义识别：

| 关键字 | 含义 |
|---|---|
| `API Key` / `Authentication failed` | 凭证缺失或失效 |
| `NDJSON buffer overflow` | 客户端发送过快，连接将被关闭 |
| `NDJSON line too long` | 单行超过 1 MB |
| `Invalid NDJSON input` | JSON 解析失败 |
| `Unknown message type` | 收到未实现的 type |
| `Task aborted` / `cancelled` | 任务被取消 |
| `command rejected by policy` | run_command 命中安全策略（allowlist / metachar） |
| `path is outside the working directory` | 路径边界拦截 |

稳定字段（机器可读）建议 daemon 通过 `PersEngError.code` 字段识别 — 未来版本会在 `error` 消息里增加 `code: "llm_auth_failed" | "policy_rejected" | ...` 字段。

---

## 8. 多租户隔离（feishu-multi）

`perseng feishu-multi` 模式下，每个 tenant 独立进程或独立 sessionId，互不影响。详见 `docs/feishu-integration.md`。

---

## 9. 版本与兼容性

- **协议版本**：v1（2026-06 当前）
- **新增字段**：daemon 应忽略未知字段（forward compatibility）
- **新增消息 type**：daemon 应忽略未知 type（forward compatibility）
- **破坏性变更**：会通过 `status: protocol_upgrade` 通知（未来规划）

---

## 10. 示例：最小 daemon 集成

### Python

```python
import subprocess, json

proc = subprocess.Popen(
    ['perseng', 'serve', '--role', 'jiangziya'],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
    text=True,
)

# 等待 ready
for line in proc.stdout:
    msg = json.loads(line)
    if msg.get('type') == 'status' and msg.get('status') == 'ready':
        break

# 发送任务
task = {'type': 'task', 'id': 'task-1', 'prompt': '你好'}
proc.stdin.write(json.dumps(task) + '\n')
proc.stdin.flush()

# 接收流式输出
for line in proc.stdout:
    msg = json.loads(line)
    if msg['type'] == 'text':
        print(msg['content'], end='', flush=True)
    elif msg['type'] == 'status' and msg['status'] == 'completed':
        print()  # 换行
        break
    elif msg['type'] == 'error':
        print(f"\nERROR: {msg['content']}", file=sys.stderr)
        break

proc.terminate()
```

### Node.js

```js
import { spawn } from 'child_process';
import readline from 'readline';

const child = spawn('perseng', ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] });
const rl = readline.createInterface({ input: child.stdout });

child.stdin.write(JSON.stringify({
  type: 'task',
  id: 'task-1',
  prompt: '你好',
}) + '\n');

for await (const line of rl) {
  const msg = JSON.parse(line);
  if (msg.type === 'status' && msg.status === 'completed') break;
  if (msg.type === 'text') process.stdout.write(msg.content);
  if (msg.type === 'error') { console.error(msg.content); break; }
}

child.kill();
```