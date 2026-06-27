/**
 * M4.7: LLM retry / fallback
 *
 * 给 streamMessages / sendToolResults 等 LLM 调用包一层自动重试 + 指数退避。
 *
 * 重试规则（默认 classifyError）：
 *   retryable:
 *     - HTTP 429 (Too Many Requests)
 *     - HTTP 500 / 502 / 503 / 504 (server-side)
 *     - ECONNRESET / ETIMEDOUT / ECONNREFUSED / EPIPE
 *     - Anthropic SDK 的 overloaded_error / api_error
 *     - 流中断（"Connection closed" / "stream ended"）
 *   fatal (不重试):
 *     - HTTP 400 / 401 / 403 / 404 / 422 (客户端错误，重试也没用)
 *     - 用户主动 abort (signal.aborted === true)
 *     - 其他未知错误（保守：fail-fast）
 *
 * 退避：exponential backoff + jitter
 *   delay(attempt) = min(maxDelay, baseDelay * 2^attempt) + random(0, baseDelay)
 *
 * 用法：
 *   import { withRetry } from './llm-retry.js';
 *   const result = await withRetry(
 *     () => provider.streamMessages(params),
 *     { maxRetries: 3, baseDelayMs: 500, signal, onRetry: (info) => log(info) }
 *   );
 *
 * metrics：
 *   - 重试每次累加 perseng_llm_retries_total{model, kind=stream|tool_results}
 *   - 最终成功 / 失败累加 perseng_llm_attempts_total{model, status=success|failed_retryable|failed_fatal}
 */

import { incrementCounter } from './metrics-registry.js';

const DEFAULT_OPTS = {
  maxRetries: 3,        // 总尝试次数 = 1 + 3 = 4
  baseDelayMs: 500,
  maxDelayMs: 16000,
  jitter: true,
  signal: null,
  onRetry: null,        // (info) => void
  model: 'unknown',
  kind: 'stream',       // stream | tool_results
};

/**
 * 分类错误：'retryable' | 'fatal'
 */
export function classifyError(err) {
  if (!err) return 'fatal';

  // 用户主动 abort → 不重试
  if (err.name === 'AbortError' && err.signal?.aborted) return 'fatal';

  // 超时类 AbortError（signal 未主动取消）→ 可重试
  if (err.name === 'AbortError') return 'retryable';

  const status = err.status ?? err.statusCode ?? err?.response?.status;
  if (status === 429) return 'retryable';
  if (status === 500 || status === 502 || status === 503 || status === 504) return 'retryable';
  if (status === 408) return 'retryable'; // Request Timeout

  // 客户端错误，不重试
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return 'fatal';
  }

  // 网络层错误
  const code = err.code;
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'EPIPE') {
    return 'retryable';
  }

  // Anthropic SDK 错误类型
  const errType = err.error?.type || err.type;
  if (errType === 'overloaded_error' || errType === 'api_error') return 'retryable';
  if (errType === 'authentication_error' || errType === 'invalid_request_error' || errType === 'permission_error') {
    return 'fatal';
  }

  // 流中断（OpenAI / Anthropic 都可能出现）
  const msg = String(err.message || '');
  if (/connection (closed|reset|ended)/i.test(msg)) return 'retryable';
  if (/stream ended/i.test(msg)) return 'retryable';
  if (/socket hang up/i.test(msg)) return 'retryable';

  // 未知错误：保守 fatal（fail-fast，避免在 poison request 上浪费 token）
  return 'fatal';
}

/**
 * 计算第 n 次重试的延迟（带 jitter）
 * @param {number} attempt 0-based（0 = 第一次失败后等待）
 * @param {object} opts { baseDelayMs, maxDelayMs, jitter }
 */
export function computeBackoff(attempt, opts = {}) {
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 16000;
  const exp = Math.min(max, base * Math.pow(2, attempt));
  if (opts.jitter === false) return exp;
  // Full jitter: random(0, exp)
  return Math.floor(Math.random() * exp);
}

/**
 * 等待 ms 毫秒（可被 signal 打断）
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted during retry backoff'));
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error('Aborted during retry backoff'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * 用 retry 包装一个 async 函数
 *
 * @template T
 * @param {() => Promise<T>} fn 要重试的函数（每次失败后重新调用）
 * @param {object} [opts] { maxRetries, baseDelayMs, maxDelayMs, jitter, signal, onRetry, model, kind }
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  let lastErr;
  let attempt = 0; // 0 = 第一次（不算 retry）

  while (true) {
    if (o.signal?.aborted) {
      throw Object.assign(new Error('Aborted before attempt'), { name: 'AbortError', signal: o.signal });
    }
    try {
      const result = await fn();
      if (attempt > 0) {
        // 至少经历了一次重试
        incrementCounter('perseng_llm_attempts_total', { model: o.model, status: 'success_after_retry' });
      } else {
        incrementCounter('perseng_llm_attempts_total', { model: o.model, status: 'success' });
      }
      return result;
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);

      if (kind === 'fatal') {
        incrementCounter('perseng_llm_attempts_total', { model: o.model, status: 'failed_fatal' });
        throw err;
      }

      // retryable：还能再试？
      if (attempt >= o.maxRetries) {
        incrementCounter('perseng_llm_attempts_total', { model: o.model, status: 'failed_retryable_exhausted' });
        const wrapped = new Error(
          `LLM call failed after ${attempt + 1} attempts: ${err.message || err}`
        );
        wrapped.cause = err;
        wrapped.attempts = attempt + 1;
        throw wrapped;
      }

      const delay = computeBackoff(attempt, o);
      incrementCounter('perseng_llm_retries_total', { model: o.model, kind: o.kind });
      if (o.onRetry) {
        try {
          o.onRetry({
            attempt: attempt + 1,
            maxRetries: o.maxRetries,
            delayMs: delay,
            error: err,
            errorKind: kind,
          });
        } catch { /* swallow callback errors */ }
      }
      try {
        await sleep(delay, o.signal);
      } catch (abortErr) {
        // 在 backoff 中被 abort
        incrementCounter('perseng_llm_attempts_total', { model: o.model, status: 'failed_fatal' });
        throw abortErr;
      }
      attempt++;
    }
  }
}