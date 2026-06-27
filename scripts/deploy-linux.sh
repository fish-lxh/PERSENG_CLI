#!/usr/bin/env bash
set -euo pipefail

# PersEng CLI 云端部署脚本
# 目标环境：Ubuntu / Debian + systemd
#
# 用法：
#   sudo bash scripts/deploy-linux.sh
#   sudo APP_DIR=/opt/perseng-cli DATA_DIR=/var/lib/perseng-cli bash scripts/deploy-linux.sh

APP_NAME="${APP_NAME:-perseng-cli}"
SERVICE_NAME="${SERVICE_NAME:-perseng-feishu}"
WEB_SERVICE_NAME="${WEB_SERVICE_NAME:-perseng-web}"
APP_USER="${APP_USER:-perseng}"
APP_GROUP="${APP_GROUP:-perseng}"
APP_DIR="${APP_DIR:-/opt/perseng-cli}"
DATA_DIR="${DATA_DIR:-/var/lib/perseng-cli}"
ENV_DIR="${ENV_DIR:-/etc/perseng-cli}"
ENV_FILE="${ENV_FILE:-$ENV_DIR/.env}"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_PATH:-/etc/systemd/system/${SERVICE_NAME}.service}"
WEB_SYSTEMD_UNIT_PATH="${WEB_SYSTEMD_UNIT_PATH:-/etc/systemd/system/${WEB_SERVICE_NAME}.service}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "请使用 root 或 sudo 运行此脚本。"
    exit 1
  fi
}

detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    echo "apt"
    return
  fi
  echo "unsupported"
}

install_os_packages() {
  local pkg_manager
  pkg_manager="$(detect_pkg_manager)"
  if [[ "${pkg_manager}" != "apt" ]]; then
    echo "仅内置支持 Ubuntu / Debian（apt）。"
    echo "请手动安装 Node.js 20+、git、build-essential、python3 后再执行。"
    exit 1
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    python3 \
    make \
    g++ \
    rsync \
    build-essential

  if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
}

ensure_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "未检测到 node，请先安装 Node.js 20+。"
    exit 1
  fi

  local node_major
  node_major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "${node_major}" -lt 20 ]]; then
    echo "当前 Node.js 版本过低：$(node -v)"
    echo "请升级到 Node.js 20 或更高版本。"
    exit 1
  fi
}

ensure_user_and_dirs() {
  if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
    groupadd --system "${APP_GROUP}"
  fi

  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    useradd --system \
      --gid "${APP_GROUP}" \
      --home "${DATA_DIR}" \
      --shell /usr/sbin/nologin \
      "${APP_USER}"
  fi

  install -d -m 0755 -o "${APP_USER}" -g "${APP_GROUP}" "${APP_DIR}"
  install -d -m 0755 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}"
  install -d -m 0755 -o root -g root "${ENV_DIR}"
  install -d -m 0755 -o "${APP_USER}" -g "${APP_GROUP}" "${DATA_DIR}/data"
}

sync_repo() {
  rsync -a \
    --delete \
    --exclude ".git" \
    --exclude "node_modules" \
    --exclude ".env" \
    --exclude "webui/node_modules" \
    "${REPO_DIR}/" "${APP_DIR}/"
  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
}

install_node_deps() {
  if [[ -f "${APP_DIR}/package-lock.json" ]]; then
    sudo -u "${APP_USER}" npm --prefix "${APP_DIR}" ci --omit=dev
  else
    sudo -u "${APP_USER}" npm --prefix "${APP_DIR}" install --omit=dev
  fi
}

install_webui_build() {
  # 如果源码包含 webui/ 则构建前端
  if [[ ! -d "${APP_DIR}/webui" ]]; then
    echo "未发现 webui/，跳过前端构建"
    return
  fi
  if [[ ! -f "${APP_DIR}/webui/package.json" ]]; then
    echo "webui/package.json 不存在，跳过前端构建"
    return
  fi

  # 如果已经有构建产物（rsync 同步过来的）且 dist/ 非空，跳过构建
  if [[ -d "${APP_DIR}/webui/dist" ]] && [[ -n "$(ls -A "${APP_DIR}/webui/dist" 2>/dev/null || true)" ]]; then
    echo "已检测到 webui/dist/，跳过构建（保留 rsync 同步的产物）"
    return
  fi

  echo "构建 WebUI ..."
  sudo -u "${APP_USER}" npm --prefix "${APP_DIR}/webui" ci
  sudo -u "${APP_USER}" npm --prefix "${APP_DIR}/webui" run build
}

install_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    echo "保留已有环境文件：${ENV_FILE}"
    return
  fi

  cat > "${ENV_FILE}" <<EOF
# 运行环境
NODE_ENV=production
HOME=${DATA_DIR}
PERSENG_CLI_DATA_DIR=${DATA_DIR}
PERSENG_CLI_COGNITION_DIR=${DATA_DIR}/data/cognition
PERSENG_CLI_ROLEX_DIR=${DATA_DIR}/data/rolex
PERSENG_CLI_BLACKBOARD_DIR=${DATA_DIR}/data/blackboard

# 模型与角色
PERSENG_ROLE=jiangziya
# PERSENG_MODEL=claude-sonnet-4-20250514

# 模型凭据（二选一）
ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# PERSENG_API_BASE=

# 飞书凭据
FEISHU_APP_ID=
FEISHU_APP_SECRET=

# 使用白名单（空 = 不限制）
PERSENG_FEISHU_ALLOW_USERS=
PERSENG_FEISHU_ALLOW_GROUPS=

# 仅这些用户可以在飞书中执行 /role set
PERSENG_FEISHU_ROLE_ADMINS=

# 生产环境建议收紧命令能力
# PERSENG_RUN_COMMAND_ALLOWLIST=git,node,npm
EOF

  chmod 600 "${ENV_FILE}"
  chown "${APP_USER}:${APP_GROUP}" "${ENV_FILE}"
}

install_systemd_unit() {
  install -m 0644 "${APP_DIR}/systemd/perseng-feishu.service" "${SYSTEMD_UNIT_PATH}"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
}

install_web_systemd_unit() {
  if [[ ! -f "${APP_DIR}/systemd/perseng-web.service" ]]; then
    echo "未发现 systemd/perseng-web.service，跳过 WebUI service 安装"
    return
  fi
  install -m 0644 "${APP_DIR}/systemd/perseng-web.service" "${WEB_SYSTEMD_UNIT_PATH}"
  systemctl daemon-reload
  systemctl enable "${WEB_SERVICE_NAME}"
}

print_next_steps() {
  cat <<EOF

部署完成。

下一步：
1. 编辑环境文件：sudo editor ${ENV_FILE}
2. 填入至少一套模型凭据：
   - ANTHROPIC_API_KEY
   - 或 OPENAI_API_KEY + PERSENG_API_BASE
3. 填入飞书凭据（可选）：
   - FEISHU_APP_ID
   - FEISHU_APP_SECRET
4. 填入 WebUI 鉴权 token（可选但推荐）：
   - PERSENG_HTTP_TOKEN=$(openssl rand -hex 24)
5. 启动服务：
   sudo systemctl restart ${SERVICE_NAME}
   sudo systemctl restart ${WEB_SERVICE_NAME}
   sudo systemctl status ${SERVICE_NAME} ${WEB_SERVICE_NAME}
6. 查看日志：
   sudo journalctl -u ${SERVICE_NAME} -f
   sudo journalctl -u ${WEB_SERVICE_NAME} -f
7. 访问 WebUI（仅本机）：
   http://127.0.0.1:7717/
   在 Settings 页面填入步骤 4 的 token

如果你还没有飞书应用凭据，可以在服务器或本机运行：
  node bin/perseng.js feishu-register --save-config

更完整说明见：
  docs/deploy-cloud-server.md
EOF
}

require_root
install_os_packages
ensure_node_version
ensure_user_and_dirs
sync_repo
install_node_deps
install_webui_build
install_env_file
install_systemd_unit
install_web_systemd_unit
print_next_steps
