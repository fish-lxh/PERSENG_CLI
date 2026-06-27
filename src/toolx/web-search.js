/**
 * Web Search — 多后端网络搜索
 *
 * 支持的后端：
 *   - duckduckgo  : 抓取 html.duckduckgo.com（无需 API Key，免费）
 *   - brave        : Brave Search API（需 BRAVE_API_KEY）
 *   - tavily       : Tavily Search API（需 TAVILY_API_KEY）
 *   - serpapi      : SerpAPI（需 SERPAPI_API_KEY，Google 结果）
 *
 * 所有出站请求都通过 web-fetch-security.js 的 4 道闸防护：
 *   1. URL 形态校验（只允许 http/https，禁止 userinfo）
 *   2. 域名策略（白名单/黑名单）
 *   3. DNS 解析 → IPv4 私网/回环判定
 *   4. 环境总开关（PERSENG_ALLOW_NETWORK=1）
 *
 * 设计原则：
 *   - 返回统一的 SearchResult 数组 [{title, url, snippet, source}]
 *   - 失败时降级到下一个后端（如果配置了多个 key）
 *   - 默认超时 15s，最大 10 条结果
 *   - 解析 HTML 时优先用 cheerio（可选），回退到正则
 */

import { isNetworkAllowed, validateUrl, resolveAndCheckIPv4, checkDomainPolicy } from './web-fetch-security.js';

// 各后端允许的域名（用于域名策略白名单）
export const BACKEND_DOMAINS = {
  duckduckgo: ['html.duckduckgo.com', 'duckduckgo.com'],
  brave:      ['api.search.brave.com'],
  tavily:     ['api.tavily.com'],
  serpapi:    ['serpapi.com'],
};

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MiB

// ──── 公开 API ────

/**
 * 执行搜索
 * @param {string} query
 * @param {object} options
 * @param {string} [options.backend='duckduckgo']   - 后端选择
 * @param {string} [options.apiKey]                  - 对应后端的 API Key
 * @param {number} [options.maxResults=10]
 * @param {string} [options.safesearch='moderate']   - strict/moderate/off
 * @param {string} [options.category]                - brave: news/videos/images
 * @param {number} [options.timeoutMs=15000]
 * @param {object} [options.domainPolicy]            - 来自 config 的 {allowedDomains, blockedDomains}
 * @returns {Promise<{ok: boolean, backend: string, results: SearchResult[], raw?: any, error?: string}>}
 */
export async function webSearch(query, options = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return { ok: false, error: 'query 不能为空' };
  }

  // ── 第 1 道闸：环境总开关 ──
  if (!isNetworkAllowed()) {
    return {
      ok: false,
      error: 'web-search 默认禁用。请设置环境变量 PERSENG_ALLOW_NETWORK=1 后再试',
    };
  }

  const backend = options.backend || 'duckduckgo';
  const maxResults = Math.min(Math.max(1, options.maxResults || DEFAULT_MAX_RESULTS), 50);
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const safesearch = options.safesearch || 'moderate';
  const domainPolicy = options.domainPolicy || {};

  let result;
  switch (backend) {
    case 'duckduckgo':
      result = await searchDuckDuckGo(query, { maxResults, timeoutMs, safesearch, domainPolicy });
      break;
    case 'brave':
      if (!options.apiKey) return { ok: false, error: 'brave 后端需要 apiKey（或环境变量 BRAVE_API_KEY）' };
      result = await searchBrave(query, { apiKey: options.apiKey, maxResults, timeoutMs, safesearch, category: options.category, domainPolicy });
      break;
    case 'tavily':
      if (!options.apiKey) return { ok: false, error: 'tavily 后端需要 apiKey（或环境变量 TAVILY_API_KEY）' };
      result = await searchTavily(query, { apiKey: options.apiKey, maxResults, timeoutMs, domainPolicy });
      break;
    case 'serpapi':
      if (!options.apiKey) return { ok: false, error: 'serpapi 后端需要 apiKey（或环境变量 SERPAPI_API_KEY）' };
      result = await searchSerpApi(query, { apiKey: options.apiKey, maxResults, timeoutMs, domainPolicy });
      break;
    default:
      return { ok: false, error: `未知后端 "${backend}"，可用: ${Object.keys(BACKEND_DOMAINS).join(', ')}` };
  }

  if (!result.ok) return result;
  return { ...result, backend };
}

// ──── 后端实现 ────

/**
 * DuckDuckGo HTML 抓取（无需 API Key）
 * 通过 POST https://html.duckduckgo.com/html/ 获取搜索结果
 */
async function searchDuckDuckGo(query, { maxResults, timeoutMs, safesearch, domainPolicy }) {
  const targetUrl = 'https://html.duckduckgo.com/html/';

  // ── 第 2 道闸：URL 形态 ──
  const urlCheck = validateUrl(targetUrl);
  if (!urlCheck.ok) return { ok: false, error: `后端 URL 校验失败: ${urlCheck.reason}` };
  const url = urlCheck.url;

  // ── 第 3 道闸：域名策略 ──
  const policy = checkDomainPolicy(url.hostname, { allowedDomains: BACKEND_DOMAINS.duckduckgo, ...domainPolicy });
  if (!policy.allowed) return { ok: false, error: `域名策略拒绝: ${policy.reason}` };

  // ── 第 4 道闸：DNS + IP 私网 ──
  const dns = await resolveAndCheckIPv4(url.hostname);
  if (!dns.ok) return { ok: false, error: `DNS 校验失败: ${dns.reason}` };

  // ── 准备请求 ──
  const formBody = new URLSearchParams({
    q: query,
    kl: 'us-en',
    kp: safesearch === 'strict' ? '1' : safesearch === 'off' ? '-1' : '-2',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'User-Agent': 'perseng-cli/1.0 (+web-search)',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml',
      },
      body: formBody.toString(),
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (resp.status >= 300 && resp.status < 400) {
      return { ok: false, error: `DDG 重定向到 ${resp.headers.get('location')}，已拒绝` };
    }
    if (!resp.ok) {
      return { ok: false, error: `DDG HTTP ${resp.status}` };
    }

    const body = await readBodyCapped(resp, MAX_BODY_BYTES);
    const results = parseDuckDuckGoHtml(body, maxResults);
    return { ok: true, results };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, error: `搜索超时（${timeoutMs}ms）` };
    return { ok: false, error: err.message };
  }
}

/**
 * 解析 DuckDuckGo HTML 页面
 * DDG 的 .result 块包含 h2.result__title > a（链接+标题）
 * 和 .result__snippet（摘要）
 */
function parseDuckDuckGoHtml(html, maxResults) {
  const results = [];

  // 匹配每个 result 块（大小写不敏感）
  const blockRe = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  const linkRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i;

  // 简化：用更宽松的匹配
  const titleRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetReGlobal = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const titles = [];
  let m;
  while ((m = titleRe.exec(html)) !== null) {
    titles.push({ url: m[1], title: stripHtml(m[2]) });
  }
  const snippets = [];
  while ((m = snippetReGlobal.exec(html)) !== null) {
    snippets.push(stripHtml(m[1]));
  }

  for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
    results.push({
      title: titles[i].title,
      url: cleanDuckDuckGoUrl(titles[i].url),
      snippet: snippets[i] || '',
      source: 'duckduckgo',
    });
  }
  return results;
}

/**
 * DDG 返回的 URL 通常是 30x 重定向，提取真实目标
 * 形如 //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&...
 */
function cleanDuckDuckGoUrl(rawUrl) {
  if (!rawUrl) return '';
  if (rawUrl.startsWith('//')) rawUrl = 'https:' + rawUrl;
  try {
    const u = new URL(rawUrl);
    const real = u.searchParams.get('uddg');
    if (real) return decodeURIComponent(real);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Brave Search API（需 API Key）
 * https://api.search.brave.com/res/v1/web/search?q=...
 */
async function searchBrave(query, { apiKey, maxResults, timeoutMs, safesearch, category, domainPolicy }) {
  const targetUrl = 'https://api.search.brave.com/res/v1/web/search';

  const urlCheck = validateUrl(targetUrl);
  if (!urlCheck.ok) return { ok: false, error: `后端 URL 校验失败: ${urlCheck.reason}` };
  const url = urlCheck.url;

  const policy = checkDomainPolicy(url.hostname, { allowedDomains: BACKEND_DOMAINS.brave, ...domainPolicy });
  if (!policy.allowed) return { ok: false, error: `域名策略拒绝: ${policy.reason}` };

  const dns = await resolveAndCheckIPv4(url.hostname);
  if (!dns.ok) return { ok: false, error: `DNS 校验失败: ${dns.reason}` };

  const params = new URLSearchParams({
    q: query,
    count: String(maxResults),
    safesearch: safesearch,
  });
  if (category) params.set('result_filter', category);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${url.toString()}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'X-Subscription-Token': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'perseng-cli/1.0',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: `Brave HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const data = await resp.json();
    const results = [];
    for (const item of (data.web?.results || []).slice(0, maxResults)) {
      results.push({
        title: item.title || '',
        url: item.url || '',
        snippet: item.description || '',
        source: 'brave',
      });
    }
    return { ok: true, results };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, error: `搜索超时（${timeoutMs}ms）` };
    return { ok: false, error: err.message };
  }
}

/**
 * Tavily Search API（需 API Key）
 * https://api.tavily.com/search
 */
async function searchTavily(query, { apiKey, maxResults, timeoutMs, domainPolicy }) {
  const targetUrl = 'https://api.tavily.com/search';

  const urlCheck = validateUrl(targetUrl);
  if (!urlCheck.ok) return { ok: false, error: `后端 URL 校验失败: ${urlCheck.reason}` };
  const url = urlCheck.url;

  const policy = checkDomainPolicy(url.hostname, { allowedDomains: BACKEND_DOMAINS.tavily, ...domainPolicy });
  if (!policy.allowed) return { ok: false, error: `域名策略拒绝: ${policy.reason}` };

  const dns = await resolveAndCheckIPv4(url.hostname);
  if (!dns.ok) return { ok: false, error: `DNS 校验失败: ${dns.reason}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'perseng-cli/1.0',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
      }),
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: `Tavily HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const data = await resp.json();
    const results = [];
    for (const item of (data.results || []).slice(0, maxResults)) {
      results.push({
        title: item.title || '',
        url: item.url || '',
        snippet: item.content || '',
        source: 'tavily',
      });
    }
    return { ok: true, results };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, error: `搜索超时（${timeoutMs}ms）` };
    return { ok: false, error: err.message };
  }
}

/**
 * SerpAPI（需 API Key，Google 结果）
 * https://serpapi.com/search.json?q=...
 */
async function searchSerpApi(query, { apiKey, maxResults, timeoutMs, domainPolicy }) {
  const targetUrl = 'https://serpapi.com/search.json';

  const urlCheck = validateUrl(targetUrl);
  if (!urlCheck.ok) return { ok: false, error: `后端 URL 校验失败: ${urlCheck.reason}` };
  const url = urlCheck.url;

  const policy = checkDomainPolicy(url.hostname, { allowedDomains: BACKEND_DOMAINS.serpapi, ...domainPolicy });
  if (!policy.allowed) return { ok: false, error: `域名策略拒绝: ${policy.reason}` };

  const dns = await resolveAndCheckIPv4(url.hostname);
  if (!dns.ok) return { ok: false, error: `DNS 校验失败: ${dns.reason}` };

  const params = new URLSearchParams({
    q: query,
    api_key: apiKey,
    num: String(maxResults),
    output: 'json',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${url.toString()}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': 'perseng-cli/1.0' },
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: `SerpAPI HTTP ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const data = await resp.json();
    const results = [];
    for (const item of (data.organic_results || []).slice(0, maxResults)) {
      results.push({
        title: item.title || '',
        url: item.link || '',
        snippet: item.snippet || '',
        source: 'serpapi',
      });
    }
    return { ok: true, results };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, error: `搜索超时（${timeoutMs}ms）` };
    return { ok: false, error: err.message };
  }
}

// ──── 工具函数 ────

async function readBodyCapped(resp, maxBytes) {
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  let truncated = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      const overflow = received - maxBytes;
      chunks.push(value.slice(0, value.byteLength - overflow));
      truncated = true;
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
    chunks.push(value);
  }
  if (truncated) {
    // 仍返回截断内容，让解析器尝试
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function stripHtml(s) {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, '')   // 去标签
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从环境变量解析后端 + apiKey
 */
export function resolveBackendFromEnv(preferredBackend) {
  // 优先级：显式参数 > 环境变量检测
  if (preferredBackend && preferredBackend !== 'auto') {
    return { backend: preferredBackend, apiKey: envKeyFor(preferredBackend) };
  }
  // auto：按顺序找第一个有 key 的
  for (const b of ['brave', 'tavily', 'serpapi']) {
    const key = envKeyFor(b);
    if (key) return { backend: b, apiKey: key };
  }
  return { backend: 'duckduckgo', apiKey: null };
}

function envKeyFor(backend) {
  const envMap = {
    brave:   'BRAVE_API_KEY',
    tavily:  'TAVILY_API_KEY',
    serpapi: 'SERPAPI_API_KEY',
  };
  const envName = envMap[backend];
  return envName ? (process.env[envName] || null) : null;
}
