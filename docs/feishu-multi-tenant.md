# PersEng 飞书多租户改造评估

> **状态**：评估报告（2026-06-26）。本文档是改造工作量分析，**不是**已经完成的实施记录。
>
> **范围**：`src/commands/feishu-multi.js` 当前的"基础多租户"已能跑；本文档评估的是"生产级别多租户"还差什么、按什么顺序做。

---

## TL;DR

**多租户的核心架构决策早已完成。** `feishu-bot-runner.js` 里的 `startFeishuBot()` 本身就是"一个 bot = 一个 tenant"的工厂，零改动就能跑多 bot。剩余工作是"外围能力"（数据隔离 / 监控拆分 / 热重载），不是重写核心。

| 场景 | 改造量 | 难度 | 风险 |
|---|---|---|---|
| **A**. 内部多团队共享部署 | **0 行** | 0 | 0 |
| **B**. 监控按租户拆分 | ~20-40 行 | 低 | 低 |
| **C**. 数据物理隔离 | ~30-60 行 | 中 | 中 |
| **D**. API Key 限流隔离 | ~40-80 行 | 较高 | 中（hot path） |
| **E**. 配置热重载 | ~60-120 行 | 较高 | 中（并发） |

**推荐顺序**：A → B → C → D / E（看规模）。

---

## 1. 现状盘点：已具备的能力

下表中的所有项**今天就能用**，无需任何代码改动。

| 能力 | 证据 |
|---|---|
| 多 bot 启动循环 | `src/commands/feishu-multi.js:88-110` 循环调 `startFeishuBot` |
| 配置驱动（JSON 模板） | `examples/feishu-tenants.json` 已就绪 |
| 凭据隔离 | 每租户独立 `appId` / `appSecret` |
| 错误隔离 | `feishu-multi.js:106-109` try/catch 包住每个 tenant 启动 |
| 优雅退出 | `feishu-multi.js:127-141` SIGINT/SIGTERM 广播 |
| 日志带租户前缀 | `feishu-bot-runner.js:137` logger 包装为 `[${name}]` |
| 差异化白名单 | 每租户独立 `allowUsers` / `allowGroups` |
| 差异化角色 | 每租户独立 `role` 字段 |
| 差异化模型 | 每租户独立 `model` 字段 |
| 差异化超时 | 每租户独立 `taskTimeoutMs` |

**运行命令**：

```bash
perseng feishu-multi --config examples/feishu-tenants.json
```

---

## 2. 五个场景的改造评估

### 场景 A：内部多团队共享部署（最低要求）

**目标**：公司内 2-3 个团队用一套部署跑各自的飞书 bot。

**改造量**：**0 行**。直接用 `feishu-multi.js`。

**适用**：
- 内部使用、无对外 SLA
- 团队数 ≤ 5
- 不需要按租户看监控

---

### 场景 B：监控按租户拆分

**目标**：Prometheus 看板能区分 `task_total{tenant=team-a}` vs `tenant=team-b}`。

**问题**：`metrics-registry.js:19` 的 `counters` 是进程级 `Map`，所有 tenant 共享同一组 counter。

**改造**（~20-40 行）：

| 文件 | 改动 |
|---|---|
| `src/metrics-registry.js` | `incrementCounter` 调用点加 `tenant` label（已支持任意 label） |
| `src/commands/feishu.js` | 把 `cfg.name` 通过闭包传给 `TaskEngine` / `LlmClient` |
| `src/feishu-bot-runner.js` | `cfg.name` 注入到 logger / metrics context |
| `src/task-engine.js` | `incrementCounter('perseng_task_total', { role, status, tenant: ctx.tenant })` |
| `src/llm-retry.js` | 同样在 4 处 incrementCounter 调用点加 tenant |
| `src/commands/feishu-multi.js` | 把 `name` 透传到 `startFeishuBot` 的新字段 `metricsLabels: { tenant: name }` |

**回归测试**：补 1-2 个测试 `snapshotCounters` 含 `tenant` label。

**难度**：低。`labelsToKey` 已稳定排序，新增 label 不影响 key 计算。

---

### 场景 C：数据物理隔离（合规 / 隐私）

**目标**：不同租户的记忆 / 角色生命周期数据存到独立目录，避免共用 SQLite 文件锁。

**问题**：`src/data-paths.js:43-45` 是模块级单例缓存（`_cognitionDir` / `_rolexDir` / `_blackboardDir`），所有 tenant 共享同一路径。

**改造**（~30-60 行）：

| 文件 | 改动 |
|---|---|
| `src/data-paths.js` | 单例 → factory：`getCognitionDir(tenantId)` + `Map<tenantId, dir>` 缓存 |
| `src/data-paths.js` | `getRolexDir(tenantId)` / `getBlackboardDir(tenantId)` 同理 |
| `src/data-paths.js` | `DEFAULT_COGNITION_DIR` 加 `<tenantId>/` 子目录 |
| `src/cognition/MemoryStore.js` | db 路径走 `getCognitionDir(tenantId) + roleId` |
| `src/feishu-bot-runner.js` | 启动时把 `cfg.name` 注入到所有调用点（需新增一个 `setTenantContext(name)`） |
| `src/data-paths.js` | `resetDataPaths()` → `resetDataPaths(tenantId)`（清空指定租户缓存） |
| 测试 | 补 2-3 个测试：单进程多 tenant 数据不串 |

**目录布局**：

```
~/.perseng-cli/
├── cognition/
│   ├── team-a/
│   │   └── jiangziya/
│   │       ├── engrams.db
│   │       └── network.json
│   └── team-b/
│       └── hr/
│           ├── engrams.db
│           └── network.json
├── rolex/
│   ├── team-a/active.json
│   └── team-b/active.json
└── blackboard/
    ├── team-a.db
    └── team-b.db
```

**难度**：中。涉及 5-6 个文件，路径计算单元要加新测试。

**回归测试**：
- 单元：`getCognitionDir('team-a')` 与 `getCognitionDir('team-b')` 路径独立
- 集成：两 tenant 同时 `remember` 互不污染

---

### 场景 D：API Key 限流隔离

**目标**：某租户触发 429 限流时，**不**连带其他租户降级。

**问题**：所有 tenant 共享一组 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`（从 env 读一次），429 是合并的。

**改造**（~40-80 行）：

| 文件 | 改动 |
|---|---|
| `examples/feishu-tenants.json` | 加 `apiKey` / `apiBase` 字段（覆盖进程级 env） |
| `src/llm-client.js` | provider 选择从"读 env 一次"改成"按 tenant 构造独立 client" |
| `src/llm-providers/BaseProvider.js` | 加 `tenantId` 透传到限流统计 |
| `src/llm-retry.js` | 401/429 重试逻辑按 tenant 区分退避 |
| `src/commands/feishu-multi.js` | 把 `tenant.apiKey` 注入到 provider 构造 |
| 测试 | 5-8 个回归测试：模拟某 tenant 限流时另一 tenant 正常 |

**难度**：较高。LLM client 是 hot path，错了会全平台报错。

**注意**：
- 大多数 SaaS API Key 是按账号级限流，不是按 Key
- 如果不同 tenant 用**同一个** API Key，这场景无解
- 真要隔离，需要给每个租户**单独采购** API Key（或走网关代理）

**适用前提**：租户 ≥ 5 且并发任务量较大。

---

### 场景 E：配置热重载

**目标**：增删租户、修改白名单**不**重启进程。

**问题**：当前 `feishu-multi.js` 启动时读一次 JSON，运行中改 `feishu-tenants.json` 不生效。

**改造**（~60-120 行）：

| 文件 | 改动 |
|---|---|
| `src/commands/feishu-multi.js` | 监听 `SIGUSR1`（或 `fs.watch`）→ 重新读 JSON |
| `src/commands/feishu-multi.js` | `handles: Array` → `handles: Map<name, Handle>` |
| `src/commands/feishu-multi.js` | diff 新旧配置 → 增调 `startFeishuBot` / 删调 `handle.stop()` / 改 setter |
| `src/feishu-bot-runner.js` | 新增 `setAllowUsers(allowUsers)` / `setAllowGroups(allowGroups)` 运行时替换 |
| 测试 | 4-5 个回归测试：热重载的并发安全（in-flight 任务保护） |

**难度**：较高。需要小心"删除中的租户还有 in-flight 任务"的并发安全。

**注意**：
- `feishu-tenants.json` 重写需原子（先写 `.tmp` 再 rename）
- 删除租户前要 `await handle.stop()` + 等待 inflight 归零
- 改 `allowUsers` 要支持原子切换（不能让消息在切换瞬间"无白名单可用"）

**适用前提**：tenant 数 ≥ 10、变更频繁、不能容忍重启窗口。

---

## 3. 推荐路径

```
第 0 周   ───  场景 A：直接用 feishu-multi.js（0 改动）
                 ↓
第 1 周   ───  场景 B：监控按租户拆分（~30 行）
                 ↓
第 2-3 周 ───  场景 C：数据物理隔离（~50 行 + 测试）
                 ↓
业务量触发 ──  场景 D / E（按需）
```

**触发场景 D 的信号**：
- 某租户频繁 429，影响其他租户
- 需要给不同租户配不同 API Key（按用量计费）

**触发场景 E 的信号**：
- 租户数 ≥ 10
- 单次重启窗口（10s）开始影响 SLA
- 频繁有"加白名单"运营需求

---

## 4. 实施 Checklist（按场景拆）

### 场景 B 实施清单

- [ ] `metrics-registry.js` 注释中列出 5 个 counter 当前调用点
- [ ] `feishu-bot-runner.js` 把 `cfg.name` 注入 `TaskEngine` context
- [ ] `task-engine.js` `run()` 加 `ctx.tenant`，`incrementCounter` 调用补 `tenant` label
- [ ] `llm-retry.js` 4 处 `incrementCounter` 调用补 `tenant`
- [ ] `feishu-multi.js` `startFeishuBot({ metricsLabels: { tenant: name } })`
- [ ] 测试：`task-engine` 多租户跑同一模型 → `perseng_task_total{tenant=...}` 各自累计
- [ ] 部署：`prometheus.yml` scrape config 检查 label 维度

### 场景 C 实施清单

- [ ] `data-paths.js` 三个 `get*Dir` 改成接受 `tenantId` 参数
- [ ] `data-paths.js` `_cognitionDir` 改 `Map<tenantId, string>`
- [ ] `data-paths.js` `resetDataPaths()` 签名加 `tenantId?`
- [ ] `cognition/MemoryStore.js` 构造时接 `tenantId`
- [ ] `feishu-bot-runner.js` 启动时 `setTenantContext(cfg.name)`
- [ ] 测试：`getCognitionDir('a')` / `getCognitionDir('b')` 路径不同
- [ ] 测试：两 tenant 同一 roleId 的 `engrams.db` 独立
- [ ] 文档：README 数据目录章节加"多租户"小节

### 场景 D 实施清单

- [ ] `feishu-tenants.json` schema 文档加 `apiKey` / `apiBase` 字段
- [ ] `llm-client.js` 加 `createProviderForTenant(tenantCfg)` factory
- [ ] `BaseProvider` 加 `tenantId` 字段
- [ ] `llm-retry.js` 退避按 tenant 分桶（避免全局 sleep）
- [ ] 测试：mock 429 验证仅触发租户降级
- [ ] 部署：API Key 走 `/etc/perseng-cli/tenants/<name>.env` 单独管

### 场景 E 实施清单

- [ ] `feishu-multi.js` 监听 `SIGUSR1`（或 `fs.watch` JSON 文件）
- [ ] JSON 写盘用原子 rename（先 `.tmp` 再 rename）
- [ ] diff 函数：增 / 删 / 改三类操作
- [ ] `feishu-bot-runner.js` 加 `setAllowUsers` / `setAllowGroups` 运行时替换
- [ ] 删租户前 `await stop()` + 等待 in-flight 归零（带超时）
- [ ] 测试：模拟热重载时 in-flight 任务不被打断
- [ ] 文档：运维手册加 "SIGHUP / SIGUSR1 重载" 章节

---

## 5. 参考代码位置速查

| 关注点 | 文件:行 |
|---|---|
| bot 工厂入口 | `src/feishu-bot-runner.js:114` (`startFeishuBot`) |
| 多租户编排 | `src/commands/feishu-multi.js:38` (`feishuMultiCommand`) |
| 配置模板 | `examples/feishu-tenants.json` |
| 数据目录单例 | `src/data-paths.js:43-45`（场景 C 改造点） |
| Metrics 计数器 | `src/metrics-registry.js:19`（场景 B 改造点） |
| Provider 抽象 | `src/llm-providers/BaseProvider.js`（场景 D 改造点） |
| 单租户 CLI | `src/commands/feishu.js`（可作为 feishu-multi.js 的简化参考） |
| 飞书 WS 客户端 | `src/feishu-adapter.js` |
| Session 隔离 | `src/feishu-session-store.js`（已按 chatId 隔离） |

---

## 6. 决策建议：什么时候值得做

| 租户规模 | 推荐做到 |
|---|---|
| 1-2 | 不用动（用 `feishu` 单租户） |
| 3-5 | A（直接用 `feishu-multi`） |
| 6-10 | A + B（监控拆分） |
| 11-20 | A + B + C（数据隔离） |
| 20+ | A + B + C + D/E |

**关键判断点**：
- 内部使用：到 B 就够
- 对外提供服务：必须 C（合规）
- 商业化 SaaS：A + B + C + D + E 全做

---

## 7. 相关文档

- 飞书集成主文档：[feishu-integration.md](./feishu-integration.md)
- 多租户示例配置：`examples/feishu-tenants.json`
- 协议层（Multica NDJSON）：[protocol.md](./protocol.md)
- 部署指南：[deploy-cloud-server.md](./deploy-cloud-server.md) / [deploy-docker-compose.md](./deploy-docker-compose.md)
