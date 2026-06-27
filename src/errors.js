/**
 * 统一错误类型 (P2.9)
 *
 * 替代散落在各处的 `new Error('... 未找到 ...')`、`Error('command rejected by policy ...')` 等。
 *
 * 使用约定：
 *   - CLI 顶层 catch 通过 `isUserFacing(err)` 判断，决定打印友好提示还是 stack
 *   - error.code 是稳定的机器可读枚举（不要在 message 里改字面量）
 *   - error.userMessage 是给最终用户看的提示，可以本地化
 */

export const ErrorCode = Object.freeze({
  CONFIG_MISSING: 'config_missing',          // 缺 API key / 配置
  ROLE_NOT_FOUND: 'role_not_found',
  TOOL_NOT_FOUND: 'tool_not_found',
  TOOL_EXEC_FAILED: 'tool_exec_failed',
  POLICY_REJECTED: 'policy_rejected',         // run_command / 路径越界
  LLM_AUTH: 'llm_auth_failed',
  LLM_RATE_LIMIT: 'llm_rate_limit',
  LLM_UPSTREAM: 'llm_upstream',
  AGENT_SPAWN_FAILED: 'agent_spawn_failed',
  AGENT_TIMEOUT: 'agent_timeout',
  AGENT_NONZERO_EXIT: 'agent_nonzero_exit',
  NDJSON_PARSE: 'ndjson_parse',
  NDJSON_OVERFLOW: 'ndjson_overflow',
  MEMORY_STORE: 'memory_store',
  ROLE_SOURCE_INVALID: 'role_source_invalid',
  INTERNAL: 'internal',
});

const USER_FACING_CODES = new Set([
  ErrorCode.CONFIG_MISSING,
  ErrorCode.ROLE_NOT_FOUND,
  ErrorCode.TOOL_NOT_FOUND,
  ErrorCode.POLICY_REJECTED,
  ErrorCode.LLM_AUTH,
  ErrorCode.LLM_RATE_LIMIT,
  ErrorCode.NDJSON_OVERFLOW,
]);

export class PersengError extends Error {
  /**
   * @param {object} options
   * @param {string} options.code - 来自 ErrorCode
   * @param {string} options.message - 技术消息（含细节），出现在日志 / stack
   * @param {string} [options.userMessage] - 给用户看的中文/友好提示
   * @param {Error}  [options.cause] - 原始错误
   * @param {object} [options.context] - 额外结构化字段
   */
  constructor({ code, message, userMessage, cause, context }) {
    super(message);
    this.name = 'PersengError';
    this.code = code || ErrorCode.INTERNAL;
    this.userMessage = userMessage || message;
    if (cause) this.cause = cause;
    if (context) this.context = context;
  }

  isUserFacing() {
    return USER_FACING_CODES.has(this.code);
  }

  /**
   * 字符串化时优先展示 userMessage，这样 stack/assert/error 都更友好。
   * 同时保留 code 前缀方便排错。
   */
  toString() {
    return `${this.name} [${this.code}]: ${this.userMessage}`;
  }

  /**
   * 转成 JSON，便于日志 / 上报
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      cause: this.cause ? { name: this.cause.name, message: this.cause.message } : undefined,
      context: this.context,
    };
  }
}

/**
 * 把任意 thrown value 包成 PersengError
 */
export function wrap(err, fallbackCode = ErrorCode.INTERNAL) {
  if (err instanceof PersengError) return err;
  if (err instanceof Error) {
    return new PersengError({
      code: fallbackCode,
      message: err.message,
      cause: err,
    });
  }
  return new PersengError({
    code: fallbackCode,
    message: String(err),
  });
}
