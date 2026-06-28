# PersEng CLI WebUI 启动指南

本文档说明如何启动 PersEng CLI 的 WebUI（基于 React + TypeScript），支持开发模式和生产模式。

## 1. 前提条件

### 1.1 环境要求

- Node.js：>= 20.0.0
- npm：随 Node.js 安装
- 后端服务：必须先配置 API Key（Anthropic 或 OpenAI 兼容）

### 1.2 目录结构

```
perseng-cli/
├── bin/perseng.js          ← CLI 入口
├── webui/                  ← WebUI 前端
│   ├── src/                ← 前端源码
│   ├── dist/               ← 构建产物（需构建）
│   └── package.json
├── .env                    ← 环境变量（必填）
└── src/commands/serve-http.js  ← HTTP 服务
```

## 2. 配置环境变量

在项目根目录创建 `.env`（参考 `.env.example`）：

```env
# 至少配置一项 API Key（二选一）
ANTHROPIC_API_KEY=sk-ant-xxxx
# OPENAI_API_KEY=sk-xxxx
# PERSENG_API_BASE=https://api.moonshot.cn/v1

# HTTP 服务配置（默认即可）
PERSENG_HTTP_HOST=127.0.0.1
PERSENG_HTTP_PORT=7717
# PERSENG_HTTP_TOKEN=your-token-here  # 可选：启用 token 鉴权
```

说明：
- `PERSENG_HTTP_HOST`：绑定地址，`127.0.0.1` 仅本地访问，`0.0.0.0` 允许外网访问
- `PERSENG_HTTP_PORT`：后端服务端口，默认 `7717`
- `PERSENG_HTTP_TOKEN`：可选，配置后需在请求头携带 `Authorization: Bearer <token>`

## 3. 安装依赖

### 3.1 后端依赖

```bash
cd perseng-cli
npm install
```

### 3.2 前端依赖

```bash
cd perseng-cli/webui
npm install
```

## 4. 开发模式（推荐）

开发模式使用 Vite 开发服务器，支持热更新，通过 proxy 将 API 请求转发到后端。

### 4.1 启动后端服务

打开**第一个终端**：

```bash
cd perseng-cli
npx perseng serve-http --host 127.0.0.1 --port 7717
```

成功启动后会看到：

```
perseng-cli HTTP server listening on http://127.0.0.1:7717
REST:     GET  /status /metrics /roles /roles/:id /memory /memory/stats /memory/:id
          POST /memory/:id/forget
          GET  /sessions
WS:       /ws/chat  (Sec-WebSocket-Protocol: perseng-token,<token>)
Static:   webui/dist/  (SPA fallback to index.html)
```

### 4.2 启动前端开发服务器

打开**第二个终端**：

```bash
cd perseng-cli/webui
npm run dev
```

成功启动后会看到：

```
VITE v5.x.x  ready in xxxx ms

➜  Local:   http://localhost:5173/
➜  Network: use --host to expose
```

### 4.3 访问 WebUI

在浏览器打开：`http://localhost:5173`

前端会通过 Vite proxy 将 API 请求转发到 `http://127.0.0.1:7717`。

### 4.4 开发模式架构

```
浏览器 → Vite Dev Server (5173)
          ├── /assets/*        → 本地静态资源（热更新）
          ├── /api/*           → proxy → 后端 (7717)
          └── /ws/chat         → WebSocket → 后端 (7717)
```

## 5. 生产模式

生产模式先构建前端，然后由后端服务直接 serve 静态文件。

### 5.1 构建前端

```bash
cd perseng-cli/webui
npm run build
```

构建产物输出到 `webui/dist/`。

### 5.2 启动后端服务

```bash
cd perseng-cli
npx perseng serve-http --host 127.0.0.1 --port 7717
```

### 5.3 访问 WebUI

在浏览器打开：`http://127.0.0.1:7717`

后端会通过 `src/web/static.js` 直接 serve `webui/dist/` 下的 SPA。

### 5.4 生产模式架构

```
浏览器 → 后端 HTTP Server (7717)
          ├── /*               → serve webui/dist/（SPA fallback）
          ├── /api/*           → REST API
          └── /ws/chat         → WebSocket 聊天
```

### 5.5 生产模式 systemd 部署（推荐）

项目已提供 `systemd/perseng-web.service`，可配置为开机自启。

```bash
# 1. 构建前端
cd /opt/perseng-cli/webui
npm run build

# 2. 安装 systemd 服务
sudo cp systemd/perseng-web.service /etc/systemd/system/

# 3. 配置环境变量（/etc/perseng-cli/.env）
sudo editor /etc/perseng-cli/.env

# 4. 启动服务
sudo systemctl daemon-reload
sudo systemctl enable --now perseng-web
sudo systemctl status perseng-web
```

systemd 服务文件内容：

```ini
[Unit]
Description=PersEng WebUI (HTTP + WebSocket + Static)
After=network-online.target

[Service]
Type=simple
User=perseng
Group=perseng
WorkingDirectory=/opt/perseng-cli
EnvironmentFile=/etc/perseng-cli/.env
Environment=PERSENG_HTTP_PORT=7717
Environment=PERSENG_HTTP_HOST=127.0.0.1
ExecStart=/usr/bin/env node bin/perseng.js serve-http
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

查看日志：

```bash
sudo journalctl -u perseng-web -f
```

## 6. 验证启动成功

### 6.1 测试后端 API

```bash
curl http://127.0.0.1:7717/status
```

预期响应：

```json
{
  "name": "perseng-cli",
  "version": "1.0.0",
  "pid": 12345,
  "uptimeSeconds": 10,
  "activeRole": "jiangziya",
  "dataDir": "~/.perseng-cli",
  "timestamp": "2026-06-27T08:00:00.000Z"
}
```

### 6.2 测试角色列表

```bash
curl http://127.0.0.1:7717/roles
```

### 6.3 测试 WebSocket（开发模式）

在浏览器控制台执行：

```javascript
const ws = new WebSocket('ws://localhost:5173/ws/chat');
ws.onmessage = (e) => console.log('Received:', e.data);
ws.onopen = () => ws.send(JSON.stringify({ type: 'message', content: 'Hello' }));
```

## 7. 端口说明

| 服务 | 默认端口 | 配置方式 |
|------|----------|----------|
| 后端 HTTP API | `7717` | `PERSENG_HTTP_PORT` 或 `--port` |
| 后端 WebSocket | `7717` (同 HTTP) | 同上 |
| 前端开发服务器 | `5173` | Vite 默认，不可改 |

## 8. 前端配置说明

前端 proxy 配置在 [webui/vite.config.js](../webui/vite.config.js)：

```javascript
var BACKEND = process.env.PERSENG_BACKEND_URL || 'http://127.0.0.1:7717';
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
```

如需连接远程后端（开发模式）：

```bash
PERSENG_BACKEND_URL=http://your-server-ip:7717 npm run dev
```

## 9. 常见问题

### 9.1 访问时显示 "WebUI 未构建"

**原因**：`webui/dist/` 不存在，后端无法 serve 静态文件。

**解决**：

```bash
cd perseng-cli/webui
npm run build
```

### 9.2 前端 API 请求失败（开发模式）

**原因**：后端服务未启动或端口不匹配。

**解决**：
1. 确认后端已启动：`npx perseng serve-http`
2. 确认后端端口为 `7717`
3. 检查 Vite proxy 配置：`PERSENG_BACKEND_URL`

### 9.3 WebSocket 连接失败

**原因**：开发模式下 WebSocket 请求未被正确代理。

**解决**：
- 开发模式：WebSocket 直接连接 `ws://localhost:5173/ws/chat`
- 生产模式：WebSocket 连接 `ws://127.0.0.1:7717/ws/chat`

### 9.4 前端页面空白

**原因**：后端 serve 的静态文件有问题。

**解决**：
1. 检查 `webui/dist/index.html` 是否存在
2. 检查浏览器控制台是否有 JS 错误
3. 重新构建前端：`npm run build`

### 9.5 Windows PowerShell 启动问题

**原因**：PowerShell 执行策略限制或路径问题。

**解决**：

```powershell
# 临时允许脚本执行
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# 使用完整路径启动
node .\bin\perseng.js serve-http

# 或使用 npx
npx perseng serve-http
```

### 9.6 端口被占用

**原因**：端口已被其他进程占用。

**解决**：

```bash
# Windows PowerShell
Get-NetTCPConnection -LocalPort 7717 | Select-Object OwningProcess
Stop-Process -Id <PID> -Force

# Linux/macOS
lsof -ti:7717 | xargs kill -9
```

或换一个端口：

```bash
npx perseng serve-http --port 7718
```

## 10. 相关文件

| 文件 | 说明 |
|------|------|
| `src/commands/serve-http.js` | HTTP + WebSocket 服务入口 |
| `src/web/static.js` | SPA 静态文件服务 |
| `src/web/WsHub.js` | WebSocket 聊天处理 |
| `webui/vite.config.js` | Vite 开发服务器配置 |
| `webui/package.json` | 前端依赖与脚本 |
| `.env.example` | 环境变量模板 |