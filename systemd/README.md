# PersEng Feishu 守护进程

推荐直接使用项目根目录的云端部署文档：

- `docs/deploy-cloud-server.md`

推荐部署方式：

```bash
sudo bash scripts/deploy-linux.sh
```

该脚本会自动完成：
- 创建 `perseng` 系统用户
- 同步代码到 `/opt/perseng-cli`
- 安装生产依赖
- 初始化 `/etc/perseng-cli/.env`
- 安装并启用 `perseng-feishu.service`

部署后常用命令：

```bash
sudo systemctl restart perseng-feishu
sudo systemctl status perseng-feishu
sudo journalctl -u perseng-feishu -f
```
