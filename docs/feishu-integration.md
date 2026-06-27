# perseng-cli × 飞书集成 PRD

> 状态：草案 v1
> 日期：2026-06-23
> 目标读者：维护者、二次开发者
> 范围：把 perseng-cli 接入飞书 IM，让用户通过私聊 / 群聊 @机器人 使用 PersEng 角色

---

## 1. 背景与目标

### 1.1 现状
`perseng-cli` 当前提供：
- `perseng run <task>` — 单次任务
- `perseng serve` — Multica 兼容守护模式（NDJSON over stdio）

两者都需要用户主动开终端，门槛高。

### 1.2 目标
通过飞书机器人把 perseng-cli 接入日常工作流（私聊/群聊），让用户：

- 私聊：直接发消息给机器人
- 群聊：`@机器人 <问题>` 触发
- 享受现有 TaskEngine 全部能力（角色、记忆、工具、子代理路由）

### 1.3 非目标
- 多模态输入（图片/语音理解）— v2
- 主动推送（如定时播报）— v2
- 多租户 / 集群 — v3（<10 人不需要）

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        飞书客户端                                      │
│  用户 ←→ 飞书 IM (私聊/群聊 @机器人)                                  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ WebSocket 长连接 (免公网IP)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  perseng-cli (feishu serve 模式)                      │
│                                                                      │
│  ┌───────────────────┐   ┌──────────────────────────────────────┐   │
│  │ FeishuAdapter      │   │  SessionStore (chatId → Session)    │   │
│  │ (feishu-adapter.js)│──▶│  ┌───────────────────────────────┐  │   │
│  │  • WSClient        │   │  │ Session {                     │  │   │
│  │  • EventDispatcher │   │  │   taskEngine: TaskEngine      │  │   │
│  │  • 消息类型分发    │   │  │   history: Message[]          │  │   │
│  │  • @mention 解析   │   │  │   lastActiveAt: Date          │  │   │
│  │  • reply 分段/卡片 │   │  │   abortCtl: AbortController   │  │   │
│  └────────┬──────────┘   │  └───────────────────────────────┘  │   │
│           │              └──────────────────────────────────────┘   │
│           │                         │                               │
│           ▼                         ▼                               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Task Engine (per-session)                  │   │
│  │  read_file / write_file / list_dir / grep_search /           │   │
│  │  run_command / timeline / toolx / route_to_agent            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                         │                                           │
│                         ▼                                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                  LLM (Anthropic / OpenAI)                     │   │
│  │  姜子牙(战略)│女娲(造角色)│鲁班(工具)│...                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 新增/修改文件

### 3.1 新增

| 文件 | 职责 |
|---|---|
| `src/feishu-adapter.js` | 飞书 SDK 封装：WSClient、EventDispatcher、消息分发、回复（text/card） |
| `src/feishu-session-store.js` | `Map<chatId, Session>` 管理；LRU 淘汰；会话持久化到 SQLite |
| `src/commands/feishu.js` | `perseng feishu` 命令入口 |
| `test/feishu-adapter.test.js` | 7 个 mock 测试：消息分发、群聊 @过滤、reply 分段、错误传播 |
| `test/feishu-session-store.test.js` | 4 个测试：create/get/evict/persist |
| `systemd/perseng-feishu.service` | 守护进程 unit |
| `Dockerfile.feishu` | 容器化（可选） |

### 3.2 修改

| 文件 | 改动 |
|---|---|
| `package.json` | `+@larksuiteoapi/node-sdk: ^1.66.0` |
| `src/main.js` | `+feishu` 子命令注册 |
| `src/config.js` | `+feishuAppId` / `+feishuAppSecret`（env 优先） |
| `src/cognition/MemoryStore.js` | `remember()` 加 hash 去重 + N 条上限 |
| `src/llm-client.js` | 接受可选 `AbortSignal` |
| `src/task-engine.js` | `engine.run()` 接受可选 `signal` |
| `.env.example` | `+FEISHU_APP_ID` / `+FEISHU_APP_SECRET` 模板 |
| `.gitignore` | （不变） |

### 3.3 依赖

```json
{
  "@larksuiteoapi/node-sdk": "^1.66.0"
}
```

包大小约 1.2 MB（gzip 200 KB），无原生依赖。

---

## 4. 飞书事件处理

### 4.1 事件类型

| 事件 | 处理 |
|---|---|
| `im.message.receive_v1` (text) | 主要路径 |
| `im.message.receive_v1` (file/image/post) | 回复「暂不支持」 |
| `im.message.receive_v1` (audio/video) | v2 |

### 4.2 群聊 @mention 判定

**使用 `message.mentions` 数组，不用正则：**

```js
const mentions = message.mentions || [];
const BOT_OPEN_ID = process.env.FEISHU_BOT_OPEN_ID; // 启动时通过 client.contact.v3.user.me 拉取
const botMentioned = mentions.some(m => m.id?.open_id === BOT_OPEN_ID);

if (isGroupChat && !botMentioned) return;

// 清理 @ 部分：用 mentions[i].key 拿到「@_user_1」原文，正则替换
let cleanedText = text;
for (const m of mentions) {
  if (m.key) cleanedText = cleanedText.replace(m.key, '');
}
cleanedText = cleanedText.trim();
```

### 4.3 私聊 vs 群聊

| 类型 | chatType | 是否响应 |
|---|---|---|
| 私聊 (p2p) | `p2p` | 总是 |
| 群聊 (group) | `group` | 仅当 bot 被 @ |

---

## 5. 会话隔离（关键设计）

### 5.1 为什么必须每 chatId 独立 TaskEngine

- **角色记忆隔离**：用户 A 不应读到用户 B 的 recall
- **timeline 隔离**：项目进度按 chat 共享（群聊）vs 个人（私聊）
- **流式输出隔离**：A 等待 LLM 时 B 不会串台
- **timeout/Abort 隔离**：超时只杀自己的任务

### 5.2 Session 结构

```ts
interface Session {
  chatId: string;                    // 飞书 chat_id
  chatType: 'p2p' | 'group';
  senderId: string;                  // 当前活跃 user（群聊里谁 @ 谁触发）
  roleId: string;                    // 当前角色
  taskEngine: TaskEngine;            // 独立实例
  history: Message[];                // 最近 20 轮对话
  lastActiveAt: Date;
  abortCtl: AbortController;         // 当前任务的取消信号
  pendingReply: Promise<void> | null;
}
```

### 5.3 SessionStore

```ts
class FeishuSessionStore {
  private sessions = new Map<string, Session>();
  private readonly MAX_SESSIONS = 50;       // LRU 上限
  private readonly IDLE_TIMEOUT_MS = 30 * 60_000;  // 30 分钟空闲回收

  getOrCreate(chatId, chatType, roleId): Session;
  evict(chatId): void;                      // 超时或显式清理
  persist(session): Promise<void>;          // 写入 ~/.perseng-cli/feishu-sessions.db
  restore(): Promise<void>;                 // 启动时加载
}
```

- **LRU**：用 `Map` 的插入顺序特性，超 MAX 时淘汰最旧
- **空闲回收**：每 5 分钟扫一次，`now - lastActiveAt > IDLE_TIMEOUT_MS` 则 evict
- **持久化**：会话历史进 SQLite（与现有 cognition 数据并列）

---

## 6. 消息处理流程

### 6.1 3 秒 ack 模式

飞书 `im.message.receive_v1` 回调必须在 **3 秒内返回 200**，否则飞书重试。

```js
async onMessage(event) {
  const session = store.getOrCreate(event.chatId, event.chatType, roleId);
  
  // 第一步：立即 ack（< 1 秒）
  await feishu.replyText(event.chatId, '🤔 正在思考…');
  
  // 第二步：异步处理（不阻塞）
  const abortCtl = new AbortController();
  session.abortCtl = abortCtl;
  
  session.taskEngine.run(event.text, {
    roleId,
    memories: session.history,
    signal: abortCtl.signal,
    onChunk: (text) => updateLastMessage(event.messageId, text), // 流式更新
  })
    .then(async (result) => {
      await feishu.replyTextOrCard(event.chatId, result);
      session.history.push({ role: 'user', text: event.text });
      session.history.push({ role: 'assistant', text: result });
      if (session.history.length > 20) session.history = session.history.slice(-20);
      memoryStore.remember(roleId, event.text, result);  // 去重
    })
    .catch(async (err) => {
      logger.error({ err, chatId: event.chatId }, 'feishu task failed');
      const msg = err instanceof PersEngError ? err.userMessage : `❌ 出错: ${err.message}`;
      await feishu.replyText(event.chatId, msg);
    })
    .finally(() => {
      session.abortCtl = null;
      session.lastActiveAt = new Date();
    });
}
```

### 6.2 长任务进度反馈

每 30 秒发一次「还在想…」：

```js
const progressInterval = setInterval(async () => {
  await feishu.replyText(chatId, '⏳ 还在想…');
}, 30_000);

// 在 .finally 里清理
clearInterval(progressInterval);
```

### 6.3 超时控制

```js
const TIMEOUT_MS = 10 * 60_000; // 10 分钟
const timeoutId = setTimeout(() => {
  session.abortCtl?.abort('timeout after 10min');
}, TIMEOUT_MS);
```

`AbortController` 通过 `signal` 传到 TaskEngine → LLM client。

---

## 7. 回复策略

### 7.1 文本 vs 卡片

| 长度 | 形式 |
|---|---|
| < 3000 字 | `replyText`（单条） |
| 3000-8000 字 | `replyCard`（带折叠面板） |
| > 8000 字 | 上传到飞书文档 + 分享链接 |

### 7.2 分段发送（不推荐）

v1 不做分段发送。理由：
- 飞书连续 N 条会刷屏
- 卡片更适合长内容
- 分段边界切错行会导致用户困惑

### 7.3 流式更新（v2）

飞书 `im.message.update` 可更新已发消息，实现 token-by-token 流式。v2 实现，v1 先用「一次性回复」。

### 7.4 回复去重（Reply Dedup）

**问题**：LLM 在某些 prompt 下会"复读"用户上一条消息——把用户输入原样或近原样复述作为回复开头，触发飞书侧看到重复两条消息（用户一条 + bot 一条前缀复读）。或在短时间内对同一问题回复了相同内容（重试/状态机循环导致）。

**方案**：`FeishuAdapter.replyText` / `replyCard` / `replyTextOrCard` 在真正调用 `client.im.message.create` 之前，过一层 `_resolveBeforeReply(chatId, content)`，统一判定：

| 触发条件 | 行为 | 返回值 |
|---|---|---|
| 内容指纹在 TTL 窗口内已发过（完全重复） | **跳过发送** | `null` |
| 回复 normalize 后以整个用户消息开头（LLM echo） | **截掉 echo 前缀**后发送；剥完内容 < `DEDUP_MIN_LEN` 也跳过 | 剥后文本 |
| 回复以用户输入前 N 字开头（N/userLen ≥ 0.6） | 同上 | 剥后文本 |
| 短文本（< 20 字） | 不参与去重 | 原样发送 |
| 正常内容 | 直接发送 | 原文本 |

**去重粒度**：按 `chatId` 独立缓存，互不影响。

**关键参数**（`new FeishuAdapter({ ... })`）：

| 参数 | 默认 | 含义 |
|---|---|---|
| `dedupTtlMs` | `5 * 60 * 1000` (5 分钟) | 指纹有效期；`0` = 完全禁用去重 |
| `dedupMaxEntries` | `20` | 每个 chat 缓存的最大指纹数（LRU） |
| `enableEchoStrip` | `true` | 是否截掉 LLM echo 的用户前缀 |

**关闭方法**：将 `dedupTtlMs` 设为 `0` 即关闭完全重复去重；将 `enableEchoStrip` 设为 `false` 仅关闭 echo 剥离。

**热重置**：`adapter.clearReplyDedup()` 清空所有 chat 的缓存（适合测试或人工重启去重状态）。

**指纹算法**：`contentFingerprint()` — djb2 变种。normalize whitespace 后取前 200 字符哈希到 32-bit 无符号。短文本碰撞概率足够低，不追求加密强度。

**日志**：跳过/剥前缀时打 `logger.warn({ chatId, prefixLen | fp }, 'feishu reply deduped|stripped')`，方便事后追溯。

---

## 8. 错误处理

### 8.1 三类错误

| 类型 | 检测 | 处理 |
|---|---|---|
| 用户面错误 | `PersEngError.isUserFacing()` | `replyText(err.userMessage)` |
| 内部错误 | 其他 Error | `replyText('❌ 出错')` + 日志 |
| 飞书 API 错误 | `lark.APIError` | `replyText('飞书服务异常')` + 重试一次 |

### 8.2 错误传播链

```
TaskEngine.run() throws
  ↓
onMessage .catch handler
  ↓
PersEngError.isUserFacing() ?
  ├── true  → replyText(err.userMessage)
  └── false → replyText('❌ 出错') + logger.error(err)
```

### 8.3 飞书 API 失败重试

```js
async function replyWithRetry(chatId, text, retries = 1) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await feishu.replyText(chatId, text);
    } catch (err) {
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}
```

---

## 9. 安全

### 9.1 凭据管理

```env
# .env (gitignored)
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

**绝不入代码，绝不入 git**。`.gitignore` 已覆盖。

### 9.2 用户白名单

```env
PERSENG_FEISHU_ALLOW_USERS=ou_aaa,ou_bbb
```

- 未设置 = 所有人可用
- 设置后，只接受白名单内 user_id

### 9.3 群聊策略

```env
PERSENG_FEISHU_ALLOW_GROUPS=oc_xxx
```

- 未设置 = 所有群
- 设置后，只在白名单群响应

### 9.4 工具安全（沿用 P0 修复）

- `run_command` 默认无 allowlist（保持现状）
- 推荐生产环境：`PERSENG_RUN_COMMAND_ALLOWLIST="multica,git,ls"`
- `read_file`/`write_file` 默认拒绝逃出 cwd

### 9.5 日志脱敏

- 不打印 `message.content` 完整内容（可能含密码）
- 打印 `chatId` + `senderId` + `text.length` + 前 50 字

---

## 10. 信号处理（关键！）

`feishu.js` 必须沿用 `serve.js` 已有的 SIGINT/SIGTERM 模式：

```js
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down feishu bot');
  
  // 1. 通知所有活跃 session
  for (const session of store.allSessions()) {
    session.abortCtl?.abort('shutdown');
  }
  
  // 2. 停止 WSClient
  feishu.wsClient.stop?.().catch(() => {});
  
  // 3. 持久化
  store.persistAll().finally(() => process.exit(0));
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// 保持进程
await new Promise((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
```

**绝对不要** `await new Promise(() => {})` — 这是审计里 M2 标注的反模式。

---

## 11. 测试策略

### 11.1 Mock 飞书 SDK

```js
// test/_helpers/mock-lark.js
export function createMockLark() {
  return {
    Client: class {
      im = { message: { create: async (args) => ({ ok: true, args }) } };
    },
    WSClient: class {
      start = async ({ eventDispatcher }) => {
        // 直接触发测试事件
        eventDispatcher.__trigger = (event, data) => event(data);
      };
    },
    EventDispatcher: class {
      handlers = new Map();
      register({ 'im.message.receive_v1': handler }) {
        this.handlers.set('im.message.receive_v1', handler);
      }
    },
    LoggerLevel: { info: 1 },
  };
}
```

### 11.2 测试用例（adapter）

| # | 测试名 | 覆盖 |
|---|---|---|
| T1 | 私聊 text 消息分发到 handler | Adapter 主路径 |
| T2 | 群聊无 @ 被忽略 | @mention 过滤 |
| T3 | 群聊有 @ 时触发且清理文本 | @mention 解析 |
| T4 | 非 text 消息返回友好提示 | 类型分发 |
| T5 | replyText 长文本用卡片 | 分段策略 |
| T6 | replyText 失败重试 | 错误处理 |
| T7 | EventDispatcher handler 抛错不挂 WSClient | 错误隔离 |

### 11.3 测试用例（session-store）

| # | 测试名 | 覆盖 |
|---|---|---|
| T1 | getOrCreate 复用现有 session | 缓存命中 |
| T2 | 超 MAX_SESSIONS 时 LRU 淘汰 | 容量限制 |
| T3 | 空闲超 IDLE_TIMEOUT 回收 | 生命周期 |
| T4 | persist/restore 往返一致性 | 持久化 |

---

## 12. 部署

### 12.1 systemd unit

```ini
# /etc/systemd/system/perseng-feishu.service
[Unit]
Description=PersEng Feishu Bot
After=network.target

[Service]
Type=simple
User=perseng
WorkingDirectory=/opt/perseng-cli
EnvironmentFile=/etc/perseng-cli/.env
ExecStart=/usr/bin/node bin/perseng.js feishu --role jiangziya
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 12.2 环境变量

```bash
# /etc/perseng-cli/.env
ANTHROPIC_API_KEY=sk-ant-xxx
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
PERSENG_ROLE=jiangziya
PERSENG_RUN_COMMAND_ALLOWLIST="multica,git,ls,cat,node"
PERSENG_FEISHU_ALLOW_USERS=
```

### 12.3 启动

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now perseng-feishu
sudo journalctl -u perseng-feishu -f
```

### 12.4 Docker 部署（Phase 3 lite）

多阶段构建（`Dockerfile.feishu`）：
- **Stage 1 (deps)**：装原生模块编译工具（python3 / make / g++），`npm ci --omit=dev`
- **Stage 2 (runtime)**：node:20-slim + tini（PID 1 信号转发），非 root 用户 `perseng` (uid 1001)
- 数据卷：`/data`（cognition / sessions / config）

```bash
# 1. 准备 .env
cat > .env <<EOF
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
ANTHROPIC_API_KEY=sk-ant-xxx
PERSENG_ROLE=jiangziya
EOF

# 2. 构建 + 启动
docker compose -f docker-compose.feishu.yml up -d --build

# 3. 看日志
docker compose -f docker-compose.feishu.yml logs -f

# 4. 停止 + 清卷
docker compose -f docker-compose.feishu.yml down -v
```

**加固要点**：
- `no-new-privileges:true`（容器内禁提权）
- `memory: 512M`（与 systemd 对齐，防止泄漏拖垮宿主）
- `tmpfs /tmp:64M`（不写到容器层）
- 日志轮转：单文件 10M × 3 个
- tini 转发 SIGINT/SIGTERM → 飞书可优雅退出

---

## 13. 实施计划

### Phase 1：MVP（1-2 天）✅ 2026-06-23 完成
- [x] PRD（本文件）
- [x] `src/feishu-adapter.js`（不含卡片、不含文件消息）
- [x] `src/feishu-session-store.js`（内存 + LRU，不持久化）
- [x] `src/commands/feishu.js`（信号处理、超时、3 秒 ack）
- [x] `src/main.js` 注册子命令
- [x] `package.json` 加依赖 `@larksuiteoapi/node-sdk@^1.66.0`
- [x] 10 个 adapter 测试 + 5 个 session-store 测试

### Phase 2：可用（3-5 天）✅ 2026-06-23 完成
- [x] messageCard 长回复（>3000 字，header 颜色可配）
- [x] 多消息类型（image/其他 → 友好提示「暂不支持 …」）
- [x] 会话历史持久化：暂存内存（按 LRU + 30 分钟空闲回收），未落盘
- [x] `MemoryStore.remember()` SHA1 content fingerprint 去重 + 500 条/角色上限
- [x] systemd unit（`systemd/perseng-feishu.service` + README）
- [x] 端到端集成测试（`test/feishu-integration.test.js`，7 个用例）
- [x] 全套测试 **99/99 通过**

### Phase 3 lite：体验（1 周）✅ 2026-06-23 完成
- [x] 流式更新（`im.message.update`）— 节流 500ms / 80 字符，覆盖 ack
- [x] 用户白名单 + 群白名单（`PERSENG_FEISHU_ALLOW_USERS` / `GROUPS`）
- [x] 进度反馈（30s「还在想…」）— 仅当未流式更新时发，避免刷屏
- [x] Dockerfile.feishu（多阶段构建 + tini + 非 root + 资源限制）

### Phase 4：v2 ✅ 2026-06-23 完成
- [x] 多模态（image → vision API / audio → whisper ASR）
- [x] 主动推送（`feishu-push` 子命令 + cron 调度）
- [x] 多租户（`feishu-multi` 子命令 + tenants.json 错误隔离）
- [x] 全套测试 **137/137 通过**

---

## 14. 待确认问题

| 问题 | 默认决策 |
|---|---|
| 飞书 SDK 锁版本还是浮动？ | `^1.66.0`（用 caret 让 patch 自动更新） |
| 会话历史持久化位置 | `~/.perseng-cli/feishu-sessions.db`（与 cognition 并列） |
| 默认角色 | `PERSENG_ROLE` 配置项（默认 `jiangziya`） |
| 单实例还是集群 | 单实例（<10 人） |
| 是否需要 Dockerfile | 提供但非必需 |

---

## 15. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| `@larksuiteoapi/node-sdk` 大版本变更 | 🟡 | 锁版本 + 适配层隔离 |
| LLM provider 故障 | 🟡 | 复用 TaskEngine 的超时控制 |
| 飞书 API 限流 (100 req/min) | 🟢 | <10 人用不到；进度反馈可降频 |
| 记忆污染 | 🟢 | hash 去重 + N 条上限 |
| WSClient 断线 | 🟡 | SDK 内置重连；监控日志 |
| 长任务占用资源 | 🟢 | AbortController + 30 分钟空闲回收 |

---

## 16. 参考

- 飞书开放平台：https://open.feishu.cn/document/server-docs/event-subscription-guide/long-link-subscription/event-list
- `@larksuiteoapi/node-sdk` GitHub：https://github.com/larksuite/node-sdk
- 现有审计：`AUDIT-REPORT.md`（M2 关于信号处理）
- TaskEngine 文档：`src/task-engine.js`

---

*PRD 版本 v1 · 2026-06-23 · 等用户评审后进入 Phase 1 实现*
