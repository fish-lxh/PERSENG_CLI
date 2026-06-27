/**
 * 配置管理
 * 加载环境变量与默认配置
 */

import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDefaultDataDir() {
  const canUseDir = (dir) => {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(
        dir,
        `.probe.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
      );
      writeFileSync(probe, '1', 'utf-8');
      unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  };

  const envDir = process.env.PERSENG_CLI_DATA_DIR;
  if (envDir) {
    if (canUseDir(envDir)) return envDir;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'perseng-cli'));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'perseng-cli'));
  }
  candidates.push(join(homedir(), '.perseng-cli'));
  candidates.push(join(process.cwd(), '.perseng-cli'));
  candidates.push(join(tmpdir(), 'perseng-cli'));

  for (const dir of candidates) {
    if (canUseDir(dir)) return dir;
  }

  return candidates[candidates.length - 1];
}

// ---- 默认配置 ----
// 注意：buildDefaults 是函数（不是常量），每次调用都重新读 process.env。
// 原因：测试 / 动态配置场景可能在 import 之后才设 env。常量形式的 DEFAULTS
// 会在 import 时锁定 env 值，导致后续修改无效。
function buildDefaults() {
  const parseCsv = (value) =>
    String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const parseBool = (value) => String(value || '') === '1';

  return {
    // 数据目录（PERSENG_CLI_DATA_DIR 可覆盖，默认 ~/.perseng-cli）
    // 与 PERSENG_CLI_COGNITION_DIR / PERSENG_CLI_ROLEX_DIR / PERSENG_CLI_BLACKBOARD_DIR
    // 形成对称的覆盖约定
    dataDir: getDefaultDataDir(),

    // 默认角色
    role: process.env.PERSENG_ROLE || 'jiangziya',

    // 默认模型
    model: process.env.PERSENG_MODEL || 'claude-sonnet-4-20250514',

    // 生命周期阶段 -> 模型策略（为空时回退到 role.model 或默认 model）
    modelStrategy: {
      idle: process.env.PERSENG_MODEL_IDLE || '',
      goal: process.env.PERSENG_MODEL_GOAL || '',
      planning: process.env.PERSENG_MODEL_PLANNING || '',
      execution: process.env.PERSENG_MODEL_EXECUTION || '',
      reflection: process.env.PERSENG_MODEL_REFLECTION || '',
    },

    // Anthropic API Key (优先环境变量)
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

    // OpenAI 兼容 API Key (备选，支持 OpenAI / DeepSeek / OpenRouter 等)
    openaiApiKey: process.env.OPENAI_API_KEY || '',

    // 自定义 API Base URL (仅用于 OpenAI 模式)
    apiBase: process.env.PERSENG_API_BASE || '',

    // Multica 环境变量
    multicaToken: process.env.MULTICA_TOKEN || '',
    multicaServerUrl: process.env.MULTICA_SERVER_URL || '',
    multicaWorkspaceId: process.env.MULTICA_WORKSPACE_ID || '',

    // 飞书机器人配置（env 优先）
    feishuAppId: process.env.FEISHU_APP_ID || '',
    feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
    feishuBotOpenId: process.env.FEISHU_BOT_OPEN_ID || '',
    feishuAllowUsers: parseCsv(process.env.PERSENG_FEISHU_ALLOW_USERS),
    feishuAllowGroups: parseCsv(process.env.PERSENG_FEISHU_ALLOW_GROUPS),
    feishuRoleAdmins: parseCsv(process.env.PERSENG_FEISHU_ROLE_ADMINS),
    asrModel: process.env.PERSENG_ASR_MODEL || 'whisper-1',

    // GBrain HTTP 客户端配置（env 优先）
    gbrainUrl: process.env.GBRAIN_URL || '',
    gbrainHttpToken: process.env.GBRAIN_HTTP_TOKEN || '',
    gbrainBrainArea: process.env.GBRAIN_BRAIN_AREA || 'perseng',
    gbrainTimeoutMs: parseInt(process.env.GBRAIN_TIMEOUT_MS || '15000', 10),

    // HTTP 管理服务配置
    httpHost: process.env.PERSENG_HTTP_HOST || '127.0.0.1',
    httpPort: parseInt(process.env.PERSENG_HTTP_PORT || '7717', 10),
    httpToken: process.env.PERSENG_HTTP_TOKEN || '',
    httpMaxSessions: parseInt(process.env.PERSENG_HTTP_MAX_SESSIONS || '20', 10),

    // 数据目录与子目录覆盖
    cognitionDir: process.env.PERSENG_CLI_COGNITION_DIR || '',
    rolexDir: process.env.PERSENG_CLI_ROLEX_DIR || '',
    blackboardDir: process.env.PERSENG_CLI_BLACKBOARD_DIR || '',
    timelineDir: process.env.PERSENG_CLI_TIMELINE_DIR || '',

    // 运行时开关与策略
    allowNetwork: parseBool(process.env.PERSENG_ALLOW_NETWORK),
    allowPathOutsideCwd: parseBool(process.env.PERSENG_ALLOW_PATH_OUTSIDE_CWD),
    blockRunCommand: parseBool(process.env.PERSENG_BLOCK_RUN_COMMAND),
    runCommandAllowlist: parseCsv(process.env.PERSENG_RUN_COMMAND_ALLOWLIST),
    followSymlinks: parseBool(process.env.PERSENG_FOLLOW_SYMLINKS),

    // 日志配置
    debug: parseBool(process.env.PERSENG_DEBUG),
    logLevel: process.env.PERSENG_LOG_LEVEL || (parseBool(process.env.PERSENG_DEBUG) ? 'debug' : 'info'),
    logPretty: parseBool(process.env.PERSENG_LOG_PRETTY),

    // LLM retry 配置
    llmRetryEnabled: process.env.PERSENG_LLM_RETRY !== '0',
    llmMaxRetries: Number(process.env.PERSENG_LLM_MAX_RETRIES ?? 3),
    llmBaseDelayMs: Number(process.env.PERSENG_LLM_BASE_DELAY_MS ?? 500),

    // 其他业务限制
    maxMemoriesPerRole: Number(process.env.PERSENG_MAX_MEMORIES_PER_ROLE || 500),
    rolesCacheLimit: Number(process.env.PERSENG_ROLES_CACHE_LIMIT || 32),

    // 角色定义目录
    rolesDir: '', // 运行时计算

    // 最大工具调用轮次
    maxToolRounds: 25,

    // LLM 超时 (ms)
    llmTimeout: 300000,
  };
}

// ---- 运行时配置 ----
let cachedConfig = null;

/**
 * 合并 local 配置到 config 上，只覆盖"非空"字段。
 * 这是 Object.assign 的安全替代 — Object.assign 会用空字符串/null 覆盖
 * 已有的非空值（典型污染场景：旧 config.json 残留 `apiBase: ""` 把 .env
 * 里 `https://api.moonshot.cn/v1` 覆盖掉，导致 LLM 调用走默认 OpenAI 端点
 * 而 401）。
 *
 * 规则：
 *   - 字符串值：非空字符串才覆盖
 *   - null / undefined：跳过
 *   - 空数组 / 空对象：跳过
 *   - 非空对象：递归合并
 *   - 非空数组：覆盖
 *   - 其他原始值（number/boolean）：覆盖
 */
function mergeConfigPreservingEnv(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const [k, v] of Object.entries(source)) {
    if (v === '' || v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      mergeConfigPreservingEnv(target[k], v);
      continue;
    }
    target[k] = v;
  }
}

export function getConfig() {
  if (cachedConfig) return cachedConfig;

  const config = buildDefaults();

  // 计算角色目录
  config.rolesDir = resolve(__dirname, '..', 'roles');

  // 确保数据目录存在
  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  // 加载本地配置文件 (~/.perseng-cli/config.json)
  // 注意：只覆盖"非空"字段 — 让 .env / process.env 的真实值永远兜底，
  // 防止 config.json 里的 `apiBase: ""` 这类空值把 env 里正确的 base URL 覆盖掉。
  const configFile = join(config.dataDir, 'config.json');
  if (existsSync(configFile)) {
    try {
      const local = JSON.parse(readFileSync(configFile, 'utf-8'));
      mergeConfigPreservingEnv(config, local);
    } catch {
      // 忽略损坏的配置文件
    }
  } else {
    // 旧路径读时回退（D2 决策）：~/.promptx-cli/config.json 仍可被读取
    // 仅读不迁，写入时仍落到新路径；doctor 命令会提示用户手动 `mv`
    const legacyConfigFile = join(homedir(), '.promptx-cli', 'config.json');
    if (existsSync(legacyConfigFile)) {
      try {
        const local = JSON.parse(readFileSync(legacyConfigFile, 'utf-8'));
        mergeConfigPreservingEnv(config, local);
        process.stderr.write(
          `[perseng] 检测到旧配置文件 ${legacyConfigFile}，已以读时回退方式加载。` +
          `建议手动迁移：mv ~/.promptx-cli ~/.perseng-cli\n`
        );
      } catch {
        // 忽略损坏的旧配置文件
      }
    }
  }

  cachedConfig = config;
  return config;
}

/**
 * 保存配置到本地文件（原子写入）
 *
 * 修复：原 writeFileSync 非原子，崩溃中途可能损坏 config.json。
 * 改为 temp + renameSync，与 src/cognition/Network.js 和
 * src/rolex/ActiveRoleStore.js 已有的原子写入保持一致。
 */
export function saveConfig(updates) {
  const config = getConfig();
  Object.assign(config, updates);

  const configFile = join(config.dataDir, 'config.json');
  mkdirSync(config.dataDir, { recursive: true });

  // 原子写入：先写到同目录下临时文件，再 rename 覆盖
  // - 同目录保证 rename 是原子操作（POSIX / Win32 同卷都成立）
  // - 临时文件名带 PID + 时间戳，避免并发 save 时冲突
  const tmpFile = join(
    config.dataDir,
    `.config.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );

  try {
    writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf-8');
    renameSync(tmpFile, configFile);
  } catch (err) {
    // 失败时清理临时文件，避免留下垃圾
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch { /* ignore */ }
    throw err;
  }

  return config;
}

/**
 * 重置配置缓存（主要用于测试）
 * 同时清空角色缓存，避免测试间角色定义变更后读到陈旧数据。
 */
export function resetConfig() {
  cachedConfig = null;
  // 通过动态 import 避免循环依赖（config 可能在 role-loader 之前被加载）
  import('./role-loader.js').then((m) => {
    try { m.clearRoleCache(); } catch { /* ignore */ }
  }).catch(() => { /* ignore */ });
}
