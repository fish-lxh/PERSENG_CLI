# PersEng CLI 启动指南

本文档按**使用场景**分类，帮助你选择正确的启动命令。

---

## 场景总览

| 场景 | 启动命令 | 适用人群 | 端口 |
|------|----------|----------|------|
| **本地开发调试** | `npx perseng run <task>` | 开发者 | 无 |
| **WebUI 浏览器访问** | `npx perseng serve-http` | 个人用户 | 7717 |
| **飞书单租户** | `npx perseng feishu` | 单团队 | 无 |
| **飞书多租户** | `npx perseng feishu-multi --config tenants.json` | 多团队 | 无 |
| **Multica IDE 集成** | `npx perseng serve` | Multica 用户 | 无 |

---

## 1. 前提条件（所有场景通用）

### 1.1 环境要求

- Node.js：>= 20.0.0
- npm：随 Node.js 安装

### 1.2 配置 API Key

在项目根目录创建 `.env`（参考 `.env.example`）：

```env
# 至少配置一项 API Key（必填）
ANTHROPIC_API_KEY=sk-ant-xxxx
# 或 OpenAI 兼容（DeepSeek / Moonshot / OpenRouter）
# OPENAI_API_KEY=sk-xxxx
# PERSENG_API_BASE=https://api.deepseek.com/v1
```

### 1.3 安装依赖

```bash
cd perseng-cli
npm install
```

---

## 2. 场景一：本地开发调试

**适用**：开发者在终端快速测试任务，无需 WebUI 或飞书。

### 2.1 单次任务运行

```bash
npx perseng run "分析当前项目的目录结构"
```

指定角色：

```bash
npx perseng run "帮我设计一个角色" --role nuwa
```

指定模型：

```bash
npx perseng run "优化这段代码" --model claude-opus-4-20250514
```

### 2.2 特点

- 单次任务，执行完即退出
- 无需启动持久服务
- 输出直接打印到终端

---

## 3. 场景二：WebUI 浏览器访问

**适用**：个人用户通过浏览器聊天面板使用 Agent。

> 详细说明见 [webui-guide.md](./webui-guide.md)

### 3.1 开发模式（推荐）

**步骤 1**：启动后端（第一个终端）

```bash
npx perseng serve-http
```

输出：

```
perseng-cli HTTP server listening on http://127.0.0.1:7717
```

**步骤 2**：启动前端开发服务器（第二个终端）

```bash
cd webui
npm install  # 首次需要安装前端依赖
npm run dev
```

输出：

```
VITE v5.x.x  ready in xxx ms
➜  Local:   http://localhost:5173/
```

**步骤 3**：访问

浏览器打开 `http://localhost:5173`

### 3.2 生产模式

**步骤 1**：构建前端

```bash
cd webui
npm run build
```

**步骤 2**：启动后端

```bash
npx perseng serve-http
```

**步骤 3**：访问

浏览器打开 `http://127.0.0.1:7717`

### 3.3 环境变量

```env
# HTTP 服务配置
PERSENG_HTTP_HOST=127.0.0.1    # 本地访问；0.0.0.0 允许外网
PERSENG_HTTP_PORT=7717         # 默认端口
PERSENG_HTTP_MAX_SESSIONS=20   # 最大并发会话
# PERSENG_HTTP_TOKEN=xxx       # 可选：启用 API 验证
```

### 3.4 systemd 生产部署

```bash
# 构建前端
cd /opt/perseng-cli/webui && npm run build

# 安装服务
sudo cp systemd/perseng-web.service /etc/systemd/system/
sudo systemctl enable --now perseng-web

# 查看状态
sudo systemctl status perseng-web
sudo journalctl -u perseng-web -f
```

---

## 4. 场景三：飞书单租户

**适用**：单团队通过飞书私聊/群聊使用 Agent。

### 4.1 配置飞书凭据

```env
# .env
ANTHROPIC_API_KEY=sk-ant-xxxx
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
PERSENG_ROLE=jiangziya
```

获取飞书凭据：

```bash
npx perseng feishu-register  # 输出授权链接，管理员扫码
```

### 4.2 启动命令

```bash
npx perseng feishu
```

输出：

```
Feishu WSClient connected
Bot ready: jiangziya
```

指定角色：

```bash
npx perseng feishu --role luban
```

### 4.3 特点

- **无需端口**：WebSocket 主动连接飞书，不监听端口
- **无需公网 IP**：飞书长连接模式，无需回调地址
- **单进程**：飞书适配器 + 会话管理 + TaskEngine 全部内嵌

### 4.4 systemd 生产部署

```bash
# 安装服务
sudo cp systemd/perseng-feishu.service /etc/systemd/system/
sudo systemctl enable --now perseng-feishu

# 查看状态
sudo systemctl status perseng-feishu
sudo journalctl -u perseng-feishu -f
```

---

## 5. 场景四：飞书多租户

**适用**：多团队共享部署，每个团队独立飞书机器人。

> 详细说明见 [feishu-multi-tenant.md](./feishu-multi-tenant.md)

### 5.1 配置文件

创建 `feishu-tenants.json`（参考 `examples/feishu-tenants.json`）：

```json
[
  {
    "name": "team-a",
    "appId": "cli_aaa",
    "appSecret": "aaa-secret",
    "role": "jiangziya",
    "model": "claude-sonnet-4-20250514",
    "allowUsers": ["ou_user1", "ou_user2"],
    "allowGroups": ["oc_group_a"]
  },
  {
    "name": "team-b",
    "appId": "cli_bbb",
    "appSecret": "bbb-secret",
    "role": "luban",
    "model": "deepseek-chat",
    "allowUsers": ["ou_user3"],
    "allowGroups": ["oc_group_b"]
  }
]
```

### 5.2 启动命令

```bash
npx perseng feishu-multi --config feishu-tenants.json
```

输出：

```
[multi] starting tenant "team-a"...
Feishu WSClient connected
Bot ready: jiangziya
[multi] starting tenant "team-b"...
Feishu WSClient connected
Bot ready: luban
[multi] started 2/2 tenants: team-a, team-b
```

### 5.3 配置字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 租户名称（日志标识） |
| `appId` | ✅ | 飞书应用 ID |
| `appSecret` | ✅ | 飞书应用密钥 |
| `role` | ✅ | 默认角色 |
| `model` | ❌ | 模型名称（覆盖默认） |
| `allowUsers` | ❌ | 用户白名单（空=全部） |
| `allowGroups` | ❌ | 群白名单（空=全部） |
| `taskTimeoutMs` | ❌ | 任务超时（ms） |

### 5.4 systemd 生产部署

```bash
# 安装服务
sudo cp systemd/perseng-feishu-multi.service /etc/systemd/system/
sudo systemctl enable --now perseng-feishu-multi
```

---

## 6. 场景五：Multica IDE 集成

**适用**：在 Multica IDE 中作为 Agent 后端。

### 6.1 启动命令

```bash
npx perseng serve
```

### 6.2 特点

- **协议**：NDJSON over stdin/stdout
- **无端口**：通过标准输入输出通信
- **被 Multica 调度**：作为子进程被 Multica daemon 启动

### 6.3 消息格式

输入（stdin）：

```json
{ "type": "task", "id": "task-1", "prompt": "你的任务" }
```

输出（stdout）：

```json
{ "type": "status", "status": "ready" }
{ "type": "text", "content": "流式文本..." }
{ "type": "status", "status": "completed" }
```

---

## 7. 场景对比总结

| 维度 | 本地开发 | WebUI | 飞书单租户 | 飞书多租户 | Multica |
|------|----------|-------|------------|------------|---------|
| **启动命令** | `run` | `serve-http` | `feishu` | `feishu-multi` | `serve` |
| **协议** | CLI | HTTP+WS | WS 长连接 | WS 长连接 | NDJSON stdio |
| **端口** | 无 | 7717 | 无 | 无 | 无 |
| **公网 IP** | 不需要 | 需要（或内网） | 不需要 | 不需要 | 不需要 |
| **用户界面** | 终端 | 浏览器 | 飞书 IM | 飞书 IM | Multica IDE |
| **多用户** | ❌ | ❌ | ❌ | ✅ | ❌ |
| **角色隔离** | ❌ | tab 级 | chat 级 | tenant 级 | ❌ |
| **适合规模** | 个人 | 个人 | 单团队 | 多团队 | 个人 |

---

## 8. 选择建议

### 8.1 按使用方式选择

| 使用方式 | 推荐场景 |
|----------|----------|
| 命令行快速测试 | 场景一：本地开发 |
| 浏览器聊天面板 | 场景二：WebUI |
| 飞书私聊/群聊 | 场景三或四 |
| Multica IDE | 场景五 |

### 8.2 按团队规模选择

| 团队规模 | 推荐场景 |
|----------|----------|
| 1 人 | 场景一或二 |
| 2-5 人 | 场景三（飞书单租户） |
| 6-20 人 | 场景四（飞书多租户） |
| 20+ 人 | 场景四 + 数据隔离改造 |

### 8.3 按部署环境选择

| 环境 | 推荐部署方式 |
|------|-------------|
| 本地开发 | 直接命令启动 |
| 云服务器 | systemd 服务 |
| Docker | docker-compose.yml |

---

## 9. 端口说明

| 服务 | 默认端口 | 说明 |
|------|----------|------|
| WebUI 后端 HTTP | 7717 | `PERSENG_HTTP_PORT` 可覆盖 |
| WebUI 后端 WebSocket | 7717（同 HTTP） | `/ws/chat` 路径 |
| WebUI 前端开发服务器 | 5173 | Vite 默认（仅开发模式） |
| 飞书 | 无 | WebSocket 主动连接飞书 |
| Multica | 无 | stdin/stdout 通信 |

---

## 10. 验证启动成功

### 10.1 WebUI

```bash
curl http://127.0.0.1:7717/status
```

返回：

```json
{ "name": "perseng-cli", "version": "1.0.0", "activeRole": "jiangziya" }
```

### 10.2 飞书

在飞书中：
- 私聊机器人，发送消息，确认回复
- 群聊中 `@机器人`，发送消息，确认回复

### 10.3 本地开发

任务执行后终端直接输出结果。

---

## 11. 常见问题

### 11.1 WebUI 访问显示"未构建"

**原因**：`webui/dist/` 不存在。

**解决**：

```bash
cd webui && npm run build
```

### 11.2 飞书机器人不回复

**排查步骤**：

1. 检查日志：`sudo journalctl -u perseng-feishu -f`
2. 确认 WSClient 连接成功：日志应显示 `Feishu WSClient connected`
3. 确认 API Key 有效：`npx perseng doctor`
4. 确认飞书应用已安装到租户

### 11.3 端口被占用

```bash
# Windows
Get-NetTCPConnection -LocalPort 7717

# Linux
lsof -ti:7717
```

换端口：

```bash
npx perseng serve-http --port 7718
```

---

## 12. 相关文档

| 文档 | 说明 |
|------|------|
| [webui-guide.md](./webui-guide.md) | WebUI 详细指南 |
| [feishu-integration.md](./feishu-integration.md) | 飞书集成架构 |
| [feishu-admin-sop.md](./feishu-admin-sop.md) | 飞书管理员接入 |
| [feishu-multi-tenant.md](./feishu-multi-tenant.md) | 飞书多租户评估 |
| [deploy-cloud-server.md](./deploy-cloud-server.md) | 云服务器部署 |
| [deploy-docker-compose.md](./deploy-docker-compose.md) | Docker 部署 |