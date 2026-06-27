/**
 * GBrain HTTP 客户端
 *
 * 通过 HTTP 调用 GBrain 服务，提供三个核心能力：
 *   - search  : 在指定脑区检索相关页面
 *   - think   : 针对问题给出带引用的回答（含 citations 与 gap）
 *   - capture : 将内容写入指定脑区（ingest）
 *
 * 配置来源（全部从环境变量读取）：
 *   - GBRAIN_URL          : 基础 URL，未设置则所有函数直接返回错误，不发网络请求
 *   - GBRAIN_HTTP_TOKEN   : Bearer token（可选）
 *   - GBRAIN_BRAIN_AREA   : 默认脑区，默认 'perseng'
 *   - GBRAIN_TIMEOUT_MS   : 请求超时（ms），默认 15000
 *
 * 设计原则：
 *   - 使用 Node.js 内置 fetch（Node 18+），无外部依赖
 *   - 超时用 AbortController 实现
 *   - 不抛异常，所有错误统一返回 { ok: false, error: <reason> }
 *   - 成功返回 { ok: true, ...业务字段 }
 */

import { getConfig } from '../config.js';

const DEFAULT_BRAIN_AREA = 'perseng';
const DEFAULT_TIMEOUT_MS = 15000;

// ──── 公开 API ────

/**
 * 判断 GBrain 是否已配置（GBRAIN_URL 非空）
 * 供 ToolXProtocol 决定是否启用对应工具
 * @returns {boolean}
 */
export function isGBrainConfigured() {
  return !!(getConfig().gbrainUrl || '').trim();
}

/**
 * 在指定脑区检索相关页面
 * @param {object} args
 * @param {string} args.query        - 检索关键词
 * @param {string} [args.brainArea] - 脑区，未传则用 GBRAIN_BRAIN_AREA 或 'perseng'
 * @returns {Promise<{ok: boolean, pages?: any[], error?: string}>}
 */
export async function gbrainSearch({ query, brainArea } = {}) {
  if (!isGBrainConfigured()) {
    return { ok: false, error: 'GBRAIN_URL not configured' };
  }

  const body = {
    query,
    brain_area: resolveBrainArea(brainArea),
  };

  const resp = await sendRequest('/mcp/v1/search', body);
  if (!resp.ok) return resp;

  return { ok: true, pages: resp.data.pages || [] };
}

/**
 * 针对问题给出带引用的回答
 * @param {object} args
 * @param {string} args.question     - 问题内容
 * @param {string} [args.brainArea] - 脑区，未传则用 GBRAIN_BRAIN_AREA 或 'perseng'
 * @returns {Promise<{ok: boolean, answer?: string, citations?: any[], gap?: string, error?: string}>}
 */
export async function gbrainThink({ question, brainArea } = {}) {
  if (!isGBrainConfigured()) {
    return { ok: false, error: 'GBRAIN_URL not configured' };
  }

  const body = {
    question,
    brain_area: resolveBrainArea(brainArea),
  };

  const resp = await sendRequest('/mcp/v1/think', body);
  if (!resp.ok) return resp;

  return {
    ok: true,
    answer: resp.data.answer || '',
    citations: resp.data.citations || [],
    gap: resp.data.gap || '',
  };
}

/**
 * 将内容写入指定脑区（ingest）
 * @param {object} args
 * @param {string} args.content     - 待写入内容
 * @param {string} args.slug        - 内容标识
 * @param {string} [args.brainArea]- 脑区，未传则用 GBRAIN_BRAIN_AREA 或 'perseng'
 * @returns {Promise<{ok: boolean, slug?: string, error?: string}>}
 */
export async function gbrainCapture({ content, slug, brainArea } = {}) {
  if (!isGBrainConfigured()) {
    return { ok: false, error: 'GBRAIN_URL not configured' };
  }

  const body = {
    content,
    slug,
    brain_area: resolveBrainArea(brainArea),
  };

  const resp = await sendRequest('/mcp/v1/ingest', body);
  if (!resp.ok) return resp;

  return { ok: true, slug: resp.data.slug || slug };
}

// ──── 内部实现 ────

/**
 * 解析脑区：显式参数优先，否则取环境变量，再否则取默认值
 * @param {string|undefined} brainArea
 * @returns {string}
 */
function resolveBrainArea(brainArea) {
  if (brainArea && typeof brainArea === 'string' && brainArea.trim()) {
    return brainArea;
  }
  return getConfig().gbrainBrainArea || DEFAULT_BRAIN_AREA;
}

/**
 * 发送 POST 请求到 GBrain 服务
 *
 * @param {string} path - 相对路径，如 '/mcp/v1/search'
 * @param {object} body - JSON 请求体
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 *          ok=true 时 data 为解析后的 JSON 响应；ok=false 时 error 为原因
 */
async function sendRequest(path, body) {
  const config = getConfig();
  const baseUrl = config.gbrainUrl;
  const token = config.gbrainHttpToken || '';
  const timeoutMs = config.gbrainTimeoutMs || DEFAULT_TIMEOUT_MS;

  // 拼接完整 URL（避免 baseUrl 末尾斜杠重复）
  const url = baseUrl.replace(/\/+$/, '') + path;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'perseng-cli/1.0 (+gbrain-client)',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: `GBrain HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const data = await resp.json().catch(() => ({}));
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { ok: false, error: `GBrain 请求超时（${timeoutMs}ms）` };
    }
    return { ok: false, error: err.message };
  }
}
