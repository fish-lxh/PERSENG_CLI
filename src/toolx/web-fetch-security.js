/**
 * Web Fetch Security — SSRF 防护层
 *
 * 出站 HTTP/HTTPS 请求在执行前必须通过本模块的 4 道闸：
 *   1. URL 形态校验（协议白名单、禁止 userinfo）
 *   2. 域名策略（白名单/黑名单，支持 *.example.com 通配）
 *   3. DNS 解析 + IP 私网判定（强制 IPv4 verbatim）
 *   4. 环境总开关（PERSENG_ALLOW_NETWORK）
 *
 * 设计取舍：
 *   - 保守拒绝 IPv6 字面量目标（避免 ::1 / ::ffff: 绕过）
 *   - 不跟随重定向（redirect: 'manual'）由调用方在 fetch 层完成
 *   - DNS rebinding 不在 v1 防御范围；如需更高安全，应将解析出的 IP
 *     回填到 URL 并通过 Host header 携带原域名（后续可迭代）
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { getConfig } from '../config.js';

// ──── IP 私网判定 ────

const PRIVATE_IPV4_RANGES = [
  [toInt('0.0.0.0'),       toInt('0.255.255.255')],     // 0/8 "this network"
  [toInt('10.0.0.0'),      toInt('10.255.255.255')],    // 10/8 RFC1918
  [toInt('100.64.0.0'),    toInt('100.127.255.255')],   // 100.64/12 CGNAT
  [toInt('127.0.0.0'),     toInt('127.255.255.255')],   // 127/8 loopback
  [toInt('169.254.0.0'),   toInt('169.254.255.255')],   // 169.254/16 link-local
  [toInt('172.16.0.0'),    toInt('172.31.255.255')],    // 172.16/12 RFC1918
  [toInt('192.0.0.0'),     toInt('192.0.0.255')],       // 192.0.0/24 IETF
  [toInt('192.168.0.0'),   toInt('192.168.255.255')],   // 192.168/16 RFC1918
  [toInt('198.18.0.0'),    toInt('198.19.255.255')],    // 198.18/15 benchmark
  [toInt('224.0.0.0'),     toInt('239.255.255.255')],   // 224/4 multicast
  [toInt('240.0.0.0'),     toInt('255.255.255.255')],   // 240/4 reserved
];

const LOOPBACK_V6 = new Set(['::1', '::']);
const IPV4_MAPPED_V6_PREFIX = '::ffff:';
const LINK_LOCAL_V6_PREFIX = 'fe80:';
const UNIQUE_LOCAL_V6_PREFIX = 'fc';

function toInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const n = toInt(ip);
  return PRIVATE_IPV4_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (LOOPBACK_V6.has(lower)) return true;
  if (lower.startsWith(LINK_LOCAL_V6_PREFIX)) return true;
  if (lower.startsWith(UNIQUE_LOCAL_V6_PREFIX)) return true;
  if (lower.startsWith(IPV4_MAPPED_V6_PREFIX)) {
    const tail = lower.slice(IPV4_MAPPED_V6_PREFIX.length);
    if (isIP(tail) === 4) return isPrivateIPv4(tail);
  }
  return false;
}

/**
 * 判断 IP 是否位于私网/回环/链路本地/CGNAT/多播/保留段
 * @param {string} ip
 * @returns {boolean} true = 不安全
 */
export function isPrivateIP(ip) {
  const family = isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true; // 未识别形态默认拒绝
}

// ──── URL 校验 ────

/**
 * 校验 raw URL 字符串
 * @param {string} rawUrl
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function validateUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { ok: false, reason: 'URL 必须是非空字符串' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'URL 解析失败' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `协议 "${parsed.protocol}" 被拒绝，仅允许 http/https` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URL 不允许携带 userinfo（防止凭据注入）' };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: 'URL 缺少 hostname' };
  }

  return { ok: true, url: parsed };
}

// ──── 域名策略 ────

/**
 * 域名匹配：精确匹配或 *.example.com 通配
 */
export function domainMatches(hostname, pattern) {
  const h = String(hostname).toLowerCase();
  const p = String(pattern).toLowerCase();
  if (h === p) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    // 仅匹配子域，不允许裸 apex（防止 *.com 命中所有 .com）
    return h.endsWith('.' + suffix);
  }
  return false;
}

/**
 * 检查 hostname 是否命中黑/白名单
 * @param {string} hostname
 * @param {{ allowedDomains?: string[], blockedDomains?: string[] }} policy
 * @returns {{ allowed: boolean, blocked: boolean, reason?: string }}
 */
export function checkDomainPolicy(hostname, policy = {}) {
  const blockedDomains = policy.blockedDomains || [];
  const allowedDomains = policy.allowedDomains || [];

  if (blockedDomains.some((p) => domainMatches(hostname, p))) {
    return { allowed: false, blocked: true, reason: `域名 "${hostname}" 命中黑名单` };
  }

  // 配置了白名单（且非空）才生效；空数组表示不限制
  if (Array.isArray(allowedDomains) && allowedDomains.length > 0) {
    const hit = allowedDomains.some((p) => domainMatches(hostname, p));
    if (!hit) {
      return { allowed: false, blocked: false, reason: `域名 "${hostname}" 不在白名单内` };
    }
  }

  return { allowed: true, blocked: false };
}

// ──── DNS 解析 + IP 校验 ────

/**
 * 解析 hostname 为 IPv4 并校验非私网
 * - 强制 verbatim: true + family: 4，避免 OS 解析顺序 / Happy Eyeballs 绕过
 * - 字面量 IPv6 目标一律拒绝（保守策略，避免 ::ffff:127.0.0.1 穿透）
 *
 * @param {string} hostname
 * @returns {Promise<{ ok: true, ip: string } | { ok: false, reason: string }>}
 */
export async function resolveAndCheckIPv4(hostname) {
  if (!hostname) {
    return { ok: false, reason: '缺少 hostname' };
  }

  // 字面量 IP
  const family = isIP(hostname);
  if (family === 6) {
    return { ok: false, reason: `IPv6 字面量目标暂不支持（安全保守策略）` };
  }
  if (family === 4) {
    if (isPrivateIPv4(hostname)) {
      return { ok: false, reason: `目标 IP "${hostname}" 位于私网/回环/保留段` };
    }
    return { ok: true, ip: hostname };
  }

  // 域名 → 解析
  let addrs;
  try {
    addrs = await lookup(hostname, { verbatim: true, family: 4 });
  } catch (err) {
    return { ok: false, reason: `DNS 解析失败: ${err.code || err.message}` };
  }

  if (isPrivateIPv4(addrs.address)) {
    return { ok: false, reason: `域名 "${hostname}" 解析到私网 IP "${addrs.address}"` };
  }

  return { ok: true, ip: addrs.address };
}

// ──── 环境总开关 ────

/**
 * 检查是否启用网络访问（PERSENG_ALLOW_NETWORK=1）
 * 默认禁用，避免 LLM 在用户不知情的情况下任意发起外网请求
 */
export function isNetworkAllowed() {
  return getConfig().allowNetwork;
}
