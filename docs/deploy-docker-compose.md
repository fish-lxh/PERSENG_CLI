# PersEng CLI Docker Compose 部署指南

本文档适合这些场景：
- 你已经熟悉 Docker / Docker Compose
- 你希望快速拉起一个独立的飞书机器人容器
- 你不想先配置 `systemd`

当前仓库已提供：
- Compose 文件：`docker-compose.feishu.yml`
- Docker 镜像构建文件：`Dockerfile.feishu`

## 1. 前提条件

服务器需满足：
- Docker 已安装
- Docker Compose Plugin 已安装
- 服务器可访问外网
- 你已准备好模型 API Key
- 你已准备好飞书应用凭据，或准备运行 `feishu-register`

检查命令：

```bash
docker --version
docker compose version
```

## 2. 准备环境变量

在项目根目录创建 `.env`：

```env
NODE_ENV=production

# 模型凭据（二选一）
ANTHROPIC_API_KEY=sk-ant-xxxx
# OPENAI_API_KEY=sk-xxxx
# PERSENG_API_BASE=https://api.moonshot.cn/v1

# 默认角色
PERSENG_ROLE=jiangziya

# 飞书凭据
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxxxxx

# 可选：使用白名单
PERSENG_FEISHU_ALLOW_USERS=
PERSENG_FEISHU_ALLOW_GROUPS=
PERSENG_FEISHU_ROLE_ADMINS=
```

说明：
- `PERSENG_ROLE` 只是默认角色
- 部署完成后，飞书里仍可用 `/role set <id>` 切换
- `PERSENG_FEISHU_ROLE_ADMINS` 建议只填管理员用户 ID

## 3. 构建并启动

执行：

```bash
docker compose -f docker-compose.feishu.yml up -d --build
```

查看状态：

```bash
docker compose -f docker-compose.feishu.yml ps
```

查看日志：

```bash
docker compose -f docker-compose.feishu.yml logs -f
```

停止：

```bash
docker compose -f docker-compose.feishu.yml down
```

如果你要同时删除数据卷：

```bash
docker compose -f docker-compose.feishu.yml down -v
```

## 4. 数据持久化

Compose 文件里已经声明了卷：

- `perseng-feishu-data`

容器内数据写入：

- `/data`

其中会保存：
- 配置
- 角色状态
- 记忆数据
- 黑板数据

如果你要备份：

```bash
docker volume inspect perseng-feishu-data
```

## 5. 更新版本

更新代码后执行：

```bash
git pull
docker compose -f docker-compose.feishu.yml up -d --build
```

## 6. 用容器方式拿飞书凭据

如果你还没有 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，可以直接在宿主机项目目录执行：

```bash
node bin/perseng.js feishu-register
```

如果你希望在容器里执行一次性注册：

```bash
docker compose -f docker-compose.feishu.yml run --rm feishu node bin/perseng.js feishu-register
```

拿到凭据后：

1. 写回 `.env`
2. 重新启动容器

```bash
docker compose -f docker-compose.feishu.yml up -d
```

## 7. 上线后验证

建议按顺序验证：

1. 日志中无凭据缺失错误
2. 私聊机器人能回复
3. 群聊 `@机器人` 能回复
4. `/role list` 能列出角色
5. 白名单用户可以 `/role set <id>`
6. 非白名单用户不能切换角色

## 8. 常见问题

### 8.1 容器启动后立即退出

优先检查日志：

```bash
docker compose -f docker-compose.feishu.yml logs --tail=200
```

常见原因：
- `.env` 缺少模型 API Key
- `.env` 缺少飞书凭据
- 宿主机无法访问外网

### 8.2 改了 `.env` 没生效

重新创建容器：

```bash
docker compose -f docker-compose.feishu.yml up -d --force-recreate
```

### 8.3 想改默认角色

直接改 `.env`：

```env
PERSENG_ROLE=nuwa
```

然后重启：

```bash
docker compose -f docker-compose.feishu.yml up -d
```

## 9. 相关文件

- Compose 文件：`docker-compose.feishu.yml`
- 镜像构建文件：`Dockerfile.feishu`
- 云服务器部署：`docs/deploy-cloud-server.md`
- 飞书管理员 SOP：`docs/feishu-admin-sop.md`
