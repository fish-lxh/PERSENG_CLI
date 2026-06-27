# PersEng CLI 阿里云 / 腾讯云上线手册

本文档给你一份“从零到上线”的操作顺序，适用于：
- 阿里云 ECS
- 阿里云轻量应用服务器
- 腾讯云 CVM
- 腾讯云轻量应用服务器

目标：
- 在一台 Linux 云主机上跑起 `perseng-cli`
- 长期运行飞书机器人
- 让同一飞书租户内的同事直接使用

## 1. 选型建议

推荐最低配置：
- 2 vCPU
- 4 GB 内存
- 40 GB 系统盘
- Ubuntu 22.04 LTS

为什么这样配：
- Node.js + SQLite + 常驻 WebSocket 本身不重
- 真正的主要消耗在并发请求与日志
- 4 GB 足够覆盖小团队使用

## 2. 开机前准备

你需要提前准备：
- 一台 Linux 云服务器
- 一个可以 SSH 登录的账号
- 模型 API Key
- 飞书管理员账号

建议安全项：
- 仅开放 SSH 端口
- 用 SSH 密钥登录，不用密码登录
- 登录后立即升级系统补丁

## 3. 阿里云 / 腾讯云通用上线步骤

### 3.1 创建服务器

推荐镜像：
- Ubuntu 22.04

创建时建议：
- 开启公网 IP
- 配安全组
- 绑定 SSH 密钥

### 3.2 安全组建议

本项目飞书模式不需要公网回调端口。

所以安全组可以非常收敛：
- 入站：只开 `22/tcp`
- 出站：允许访问外网

说明：
- 飞书机器人这里用的是主动发起的 WebSocket 长连接
- 不需要额外开放 `80` 或 `443` 给飞书回调

### 3.3 首次登录后初始化

登录服务器后执行：

```bash
sudo apt-get update
sudo apt-get upgrade -y
sudo timedatectl set-timezone Asia/Shanghai
```

建议额外安装：

```bash
sudo apt-get install -y git curl vim
```

## 4. 拉取代码

在服务器上执行：

```bash
cd /opt
sudo git clone <你的仓库地址> perseng-cli
sudo chown -R $USER:$USER /opt/perseng-cli
cd /opt/perseng-cli
```

如果你是把本地仓库推到 GitHub/GitLab，再在服务器拉取，这种方式最稳。

## 5. 一键部署

执行：

```bash
cd /opt/perseng-cli
sudo bash scripts/deploy-linux.sh
```

它会自动完成：
- 安装 Node.js 20+
- 创建 `perseng` 系统用户
- 复制代码到 `/opt/perseng-cli`
- 安装依赖
- 安装 `systemd` 服务
- 初始化 `/etc/perseng-cli/.env`

## 6. 配置运行参数

编辑环境文件：

```bash
sudo editor /etc/perseng-cli/.env
```

至少填写：

```env
ANTHROPIC_API_KEY=sk-ant-xxxx
PERSENG_ROLE=jiangziya
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxxxxx
PERSENG_FEISHU_ROLE_ADMINS=ou_xxx,ou_yyy
```

如果你走 OpenAI 兼容模型：

```env
OPENAI_API_KEY=sk-xxxx
PERSENG_API_BASE=https://api.moonshot.cn/v1
```

## 7. 启动服务

```bash
sudo systemctl restart perseng-feishu
sudo systemctl status perseng-feishu
sudo journalctl -u perseng-feishu -f
```

## 8. 飞书接入顺序

推荐顺序：

1. 先部署服务器
2. 再运行 `feishu-register`
3. 拿到 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
4. 回填 `.env`
5. 重启服务
6. 用飞书管理员账号先做首轮验证

拿凭据命令：

```bash
cd /opt/perseng-cli
node bin/perseng.js feishu-register
```

如果你已经手动在飞书后台建好应用，就直接把凭据写进 `.env`。

## 9. 阿里云特别建议

适用于 ECS / 轻量应用服务器：

- 建议系统盘至少 40 GB
- 建议在安全组里只保留 SSH 入站
- 如果你用阿里云云助手，也可以通过云助手执行部署脚本
- 如果你后续要接日志收集，可对接阿里云日志服务，但当前阶段 `journalctl` 已够用

## 10. 腾讯云特别建议

适用于 CVM / 轻量应用服务器：

- 首次登录优先用 SSH 密钥
- 安全组只保留 SSH 入站即可
- 如果你用轻量应用服务器，防火墙和安全组都检查一次，避免出站策略过严
- 如果你有腾讯云监控，可把进程和内存占用接进去

## 11. 推荐上线验收清单

建议你上线当天按这个清单过一遍：

1. `systemctl status perseng-feishu` 为 `active`
2. `journalctl` 中无凭据缺失错误
3. 飞书私聊机器人可以回复
4. 飞书群聊 `@机器人` 可以回复
5. `/role list` 返回 6 个角色
6. 白名单管理员可执行 `/role set <id>`
7. 非白名单用户不能切换角色
8. 重启服务器后服务能自动拉起

## 12. 备份与恢复建议

重点备份目录：
- `/etc/perseng-cli/.env`
- `/var/lib/perseng-cli`

你至少应该有：
- 配置备份
- 数据目录快照
- 仓库代码版本记录

## 13. 排错建议

### 13.1 服务启动失败

```bash
sudo journalctl -u perseng-feishu -n 200 --no-pager
```

### 13.2 机器人不回消息

检查：
- 飞书应用是否已安装到租户
- 当前群是否允许机器人发言
- 群聊里是否 `@` 到机器人
- 服务器是否能访问外网

### 13.3 角色切换无效

检查：
- `PERSENG_FEISHU_ROLE_ADMINS`
- 角色 ID 是否拼写正确
- 用 `/role list` 看实际角色名

## 14. 推荐阅读

- 通用云端部署：`docs/deploy-cloud-server.md`
- Docker Compose 方案：`docs/deploy-docker-compose.md`
- 飞书管理员 SOP：`docs/feishu-admin-sop.md`
