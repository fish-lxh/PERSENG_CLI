# PersEng CLI 云端部署指南

本文档面向把 `perseng-cli` 部署到 Linux 云服务器并长期运行飞书机器人的场景。

适用目标：
- 单台云服务器
- Ubuntu / Debian
- 通过 `systemd` 常驻运行
- 同一飞书租户、同一批用户使用一个机器人

推荐配套文档：
- Docker Compose 方案：`docs/deploy-docker-compose.md`
- 阿里云 / 腾讯云上线手册：`docs/deploy-aliyun-tencent.md`
- 飞书管理员接入 SOP：`docs/feishu-admin-sop.md`

## 1. 部署方式

推荐使用以下结构：

- 应用目录：`/opt/perseng-cli`
- 数据目录：`/var/lib/perseng-cli`
- 环境文件：`/etc/perseng-cli/.env`
- 系统服务：`perseng-feishu.service`

为什么推荐这种方式：
- 便于用 `systemd` 管理开机自启、重启和日志
- 便于隔离代码、数据和密钥
- 当前项目是 Node.js CLI，直接跑原生进程比额外套一层更简单

## 2. 服务器要求

- CPU：2 vCPU 起
- 内存：4 GB 起
- 磁盘：20 GB 起
- 系统：Ubuntu 22.04 / 24.04，或 Debian 12
- Node.js：20+
- 网络：服务器需要能主动访问外网

注意：
- 飞书这里走的是 WebSocket 长连接，不需要公网回调地址
- 但服务器必须能主动访问飞书开放平台和你的模型服务

## 3. 一键部署

先把仓库放到服务器上，然后在项目根目录执行：

```bash
sudo bash scripts/deploy-linux.sh
```

脚本会完成这些事：
- 安装运行依赖：`node`、`npm`、`git`、编译工具链
- 创建系统用户：`perseng`
- 同步项目到 `/opt/perseng-cli`
- 安装生产依赖：`npm ci --omit=dev`
- 生成环境文件：`/etc/perseng-cli/.env`
- 安装 `systemd` 服务：`perseng-feishu.service`

如果你想自定义目录：

```bash
sudo APP_DIR=/opt/perseng-cli \
  DATA_DIR=/var/lib/perseng-cli \
  ENV_DIR=/etc/perseng-cli \
  bash scripts/deploy-linux.sh
```

## 4. 填写环境变量

部署脚本执行完后，先编辑：

```bash
sudo editor /etc/perseng-cli/.env
```

最少需要填写这几类配置。

### 4.1 模型凭据

二选一：

```env
ANTHROPIC_API_KEY=sk-ant-xxxx
```

或：

```env
OPENAI_API_KEY=sk-xxxx
PERSENG_API_BASE=https://api.moonshot.cn/v1
```

### 4.2 默认角色

```env
PERSENG_ROLE=jiangziya
```

这是机器人启动时的默认角色。你现在的项目已支持在飞书里动态切换角色，所以它只是默认值。

### 4.3 飞书机器人凭据

```env
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxxxxx
```

### 4.4 角色切换白名单

如果你希望“所有人都能问机器人，但只有少数人能切换角色”，建议这样配：

```env
PERSENG_FEISHU_ALLOW_USERS=
PERSENG_FEISHU_ROLE_ADMINS=ou_xxx,ou_yyy
```

说明：
- `PERSENG_FEISHU_ALLOW_USERS` 为空：不限制谁能使用机器人
- `PERSENG_FEISHU_ROLE_ADMINS` 非空：只有这些用户能执行 `/role set <id>`

如果你还想限制群范围：

```env
PERSENG_FEISHU_ALLOW_GROUPS=oc_xxx,oc_yyy
```

## 5. 启动与验证

环境文件填好后，执行：

```bash
sudo systemctl restart perseng-feishu
sudo systemctl status perseng-feishu
```

查看实时日志：

```bash
sudo journalctl -u perseng-feishu -f
```

如果启动成功，通常会看到飞书连接建立、消息监听开始之类的日志。

## 6. 运维命令

常用命令：

```bash
sudo systemctl start perseng-feishu
sudo systemctl stop perseng-feishu
sudo systemctl restart perseng-feishu
sudo systemctl status perseng-feishu
sudo journalctl -u perseng-feishu -n 200 --no-pager
sudo journalctl -u perseng-feishu -f
```

### 6.1 从 copilot 迁移到 perseng

如果你的服务器之前跑的是旧命名 `copilot`，建议按这个清单迁移：

1. 同步最新代码并安装依赖

```bash
cd /opt/perseng-cli
git pull
npm install
```

2. 检查 systemd unit 是否还在引用旧入口

应该把：

```ini
ExecStart=/usr/bin/env node bin/copilot.js feishu
```

改成：

```ini
ExecStart=/usr/bin/env node bin/perseng.js feishu
```

3. 检查 shell / crontab / 运维脚本

把这些旧命令：

```bash
node bin/copilot.js feishu
node bin/copilot.js feishu-register
node bin/copilot.js doctor --mode systemd
copilot feishu
copilot doctor --mode systemd
```

替换为：

```bash
node bin/perseng.js feishu
node bin/perseng.js feishu-register
node bin/perseng.js doctor --mode systemd
perseng feishu
perseng doctor --mode systemd
```

4. 如果你接了 Multica / Docker / Compose，也检查这些旧变量：

```env
MULTICA_COPILOT_PATH=/usr/bin/copilot
```

迁移为：

```env
MULTICA_PERSENG_PATH=/usr/bin/perseng
```

5. 用一键自检发现残留

```bash
cd /opt/perseng-cli
node bin/perseng.js doctor --mode systemd
```

6. 重载并重启服务

```bash
sudo systemctl daemon-reload
sudo systemctl restart perseng-feishu
sudo systemctl status perseng-feishu --no-pager
```

7. 观察日志确认没有旧路径报错

```bash
sudo journalctl -u perseng-feishu -n 100 --no-pager
```

升级项目：

```bash
cd /path/to/your/repo
git pull
sudo bash scripts/deploy-linux.sh
sudo systemctl restart perseng-feishu
```

## 7. 部署后如何接入飞书

部署完成后，飞书接入分成两步：
- 先拿到 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
- 再把机器人安装到你们的飞书租户并拉进私聊或群聊

### 7.1 方式 A：使用项目自带扫码命令创建/授权飞书应用

这是最推荐的方式。

在服务器或你本地电脑上执行：

```bash
node bin/perseng.js feishu-register --save-config
```

它会输出一个确认链接。你可以：
- 直接打开该链接
- 或把链接转成二维码让管理员扫码确认

确认完成后会返回：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
```

然后把这两个值写进服务器的：

```bash
/etc/perseng-cli/.env
```

再重启服务：

```bash
sudo systemctl restart perseng-feishu
```

### 7.2 方式 B：在飞书开放平台手动创建应用

如果你不走 `feishu-register`，也可以手动创建：

1. 登录飞书开放平台
2. 创建企业自建应用
3. 开启机器人能力
4. 配置事件订阅为长连接模式
5. 发布并安装到当前租户
6. 复制 `App ID` 和 `App Secret`
7. 回填到 `/etc/perseng-cli/.env`

说明：
- 这个项目使用的是长连接，不依赖公网 HTTP 回调
- 核心是让应用具备机器人能力，并安装到你的租户中

## 8. 接入完成后，用户怎么用

在飞书里把机器人加入私聊或群聊后：

- 私聊机器人：直接发消息即可
- 群聊里：通常需要 `@机器人` 才会触发

你这个项目现在还支持聊天内切换角色：

```text
/role list
/role show
/role set nuwa
```

建议上线后先验证：
- `/role list` 是否能列出 6 个角色
- `/role set <roleId>` 是否只有白名单用户可用
- 私聊和群聊里是否都能正常响应

## 9. 典型上线流程

推荐按这个顺序执行：

1. 把代码部署到服务器
2. 配置模型凭据
3. 用 `feishu-register` 拿到飞书应用凭据
4. 写入 `/etc/perseng-cli/.env`
5. `systemctl restart perseng-feishu`
6. 运行一键自检（推荐）
   ```bash
   cd /opt/perseng-cli
   node bin/perseng.js doctor --mode systemd
   ```
7. 在飞书里私聊机器人做冒烟测试
8. 拉机器人进目标群
9. 配置 `PERSENG_FEISHU_ROLE_ADMINS`
10. 让管理员测试 `/role set`

## 10. 常见问题

### 10.1 服务启动失败

先看日志：

```bash
sudo journalctl -u perseng-feishu -n 200 --no-pager
```

优先检查：
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 是否为空
- `ANTHROPIC_API_KEY` 或 `OPENAI_API_KEY` 是否为空
- 服务器 Node 版本是否小于 20

### 10.2 机器人收不到消息

检查这几项：
- 飞书应用是否已发布并安装到当前租户
- 机器人是否已被加入目标群
- 群聊里是否正确 `@` 了机器人
- `PERSENG_FEISHU_ALLOW_GROUPS` 是否把当前群挡掉了

### 10.3 可以聊天但不能切换角色

优先检查：
- 当前用户是否在 `PERSENG_FEISHU_ROLE_ADMINS`
- 角色 ID 是否真实存在
- 用 `/role list` 看看实际角色名

### 10.4 服务器需要开放端口吗

通常不需要额外开放给飞书的入站端口，因为这里使用的是主动发起的长连接。

但你需要确保服务器能访问：
- 飞书开放平台
- 你的模型服务 API

## 11. 相关文件

- 部署脚本：`scripts/deploy-linux.sh`
- systemd 服务：`systemd/perseng-feishu.service`
- 飞书集成说明：`docs/feishu-integration.md`
- CLI 入口：`bin/perseng.js`
