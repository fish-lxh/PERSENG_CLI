/**
 * 子进程安全环境变量 (P0.3)
 *
 * 默认只透传白名单内的 key，避免把 ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * MULTICA_TOKEN 等敏感凭证继承到子代理（claude / codex / openclaw / hermes）。
 *
 * 通过 PERSENG_SPAWN_PASSTHROUGH_KEYS 可在白名单基础上追加需要透传的 key
 * （逗号分隔）。注意：透传 API key 给子进程是显式行为。
 */

const DEFAULT_SAFE_KEYS = new Set([
  'PATH',
  'Path',                  // Windows
  'PATHEXT',               // Windows
  'HOME',
  'USERPROFILE',           // Windows
  'HOMEDRIVE',             // Windows
  'HOMEPATH',              // Windows
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'TMP',
  'TMPDIR',
  'TEMP',                  // Windows
  'SHELL',
  'EDITOR',
  'PAGER',
  'USER',
  'USERNAME',              // Windows
  'LOGNAME',
  'PWD',
  'OLDPWD',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'NODE_ENV',
  'CI',
  'TZ',
]);

/**
 * 构建传给 spawn 子进程的 env。
 *
 * @param {object} options
 * @param {boolean} [options.includeApiKeys=false] - 是否透传 API key
 *   （默认 false；某些子代理确实需要 ANTHROPIC_API_KEY，调用方需显式 opt-in）
 * @returns {object}
 */
export function buildSafeEnv(options = {}) {
  const includeApiKeys = options.includeApiKeys === true;

  // 先把白名单 key 拷过来
  const env = {};
  for (const key of DEFAULT_SAFE_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  // 用户追加的透传 key
  const extra = process.env.PERSENG_SPAWN_PASSTHROUGH_KEYS;
  if (extra) {
    for (const k of String(extra).split(',').map((s) => s.trim()).filter(Boolean)) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
  }

  // 显式 opt-in 才能传 API key
  if (includeApiKeys) {
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PERSENG_API_BASE', 'PERSENG_MODEL']) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
  }

  return env;
}
