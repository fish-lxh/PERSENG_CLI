/**
 * Web Fetch Security — SSRF 防护单元测试
 *
 * 覆盖：
 *   - isPrivateIP           私网/回环/链路本地/CGNAT/多播/保留段判定
 *   - validateUrl           协议白名单 + userinfo 拒绝
 *   - domainMatches         精确匹配 + 通配匹配
 *   - checkDomainPolicy     黑名单优先、白名单生效、空数组不限
 *   - resolveAndCheckIPv4   字面量 IP / 域名解析 / IPv6 拒绝
 *   - isNetworkAllowed      环境总开关
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPrivateIP,
  validateUrl,
  domainMatches,
  checkDomainPolicy,
  resolveAndCheckIPv4,
  isNetworkAllowed,
} from '../src/toolx/web-fetch-security.js';

// ════════════════════════════════════════════════════════════════
// isPrivateIP
// ════════════════════════════════════════════════════════════════

test('isPrivateIP: 公网 IPv4 应放行', () => {
  assert.equal(isPrivateIP('8.8.8.8'), false);
  assert.equal(isPrivateIP('1.1.1.1'), false);
  assert.equal(isPrivateIP('93.184.216.34'), false); // example.com
});

test('isPrivateIP: RFC1918 私网应拒绝', () => {
  assert.equal(isPrivateIP('10.0.0.1'), true);
  assert.equal(isPrivateIP('10.255.255.255'), true);
  assert.equal(isPrivateIP('172.16.0.1'), true);
  assert.equal(isPrivateIP('172.31.255.255'), true);
  assert.equal(isPrivateIP('192.168.1.1'), true);
});

test('isPrivateIP: loopback 应拒绝', () => {
  assert.equal(isPrivateIP('127.0.0.1'), true);
  assert.equal(isPrivateIP('127.255.255.254'), true);
});

test('isPrivateIP: link-local / CGNAT / 多播 / 0/8 应拒绝', () => {
  assert.equal(isPrivateIP('169.254.169.254'), true); // AWS metadata!
  assert.equal(isPrivateIP('100.64.0.1'), true);     // CGNAT
  assert.equal(isPrivateIP('224.0.0.1'), true);      // multicast
  assert.equal(isPrivateIP('0.0.0.0'), true);
});

test('isPrivateIP: IPv6 回环 / 链路本地 / UL 应拒绝', () => {
  assert.equal(isPrivateIP('::1'), true);
  assert.equal(isPrivateIP('::'), true);
  assert.equal(isPrivateIP('fe80::1'), true);
  assert.equal(isPrivateIP('fc00::1'), true);
});

test('isPrivateIP: IPv4-mapped IPv6 (::ffff:127.0.0.1) 应拒绝', () => {
  assert.equal(isPrivateIP('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIP('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateIP('::ffff:8.8.8.8'), false);
});

test('isPrivateIP: 未识别形态默认拒绝', () => {
  assert.equal(isPrivateIP('not-an-ip'), true);
  assert.equal(isPrivateIP(''), true);
});

// ════════════════════════════════════════════════════════════════
// validateUrl
// ════════════════════════════════════════════════════════════════

test('validateUrl: http / https 应通过', () => {
  assert.equal(validateUrl('http://example.com/').ok, true);
  assert.equal(validateUrl('https://example.com/path?q=1').ok, true);
});

test('validateUrl: 非 http(s) 协议应拒绝', () => {
  for (const url of [
    'file:///etc/passwd',
    'gopher://evil.com/',
    'dict://evil.com/',
    'ftp://example.com/',
    'data:text/plain;base64,SGk=',
    'javascript:alert(1)',
  ]) {
    const r = validateUrl(url);
    assert.equal(r.ok, false, `应拒绝 ${url}`);
    assert.match(r.reason, /协议/);
  }
});

test('validateUrl: 携带 userinfo 应拒绝', () => {
  const r1 = validateUrl('http://user:pass@example.com/');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /userinfo/);

  const r2 = validateUrl('http://x@example.com/');
  assert.equal(r2.ok, false);
});

test('validateUrl: 缺少 hostname 应拒绝', () => {
  // 'http://' 在 Node URL 解析器中直接抛错，被 catch 兜底
  const r = validateUrl('http://');
  assert.equal(r.ok, false);

  // 'http:///path' 在 Node 中被解释为 hostname='path'（怪异但合法），
  // 因此不算"缺少 hostname"。这里仅验证空字符串被拒。
  const r2 = validateUrl('');
  assert.equal(r2.ok, false);
});

test('validateUrl: 无效字符串应拒绝', () => {
  assert.equal(validateUrl('').ok, false);
  assert.equal(validateUrl(null).ok, false);
  assert.equal(validateUrl('not a url').ok, false);
});

// ════════════════════════════════════════════════════════════════
// domainMatches
// ════════════════════════════════════════════════════════════════

test('domainMatches: 精确匹配（大小写无关）', () => {
  assert.equal(domainMatches('Example.com', 'example.com'), true);
  assert.equal(domainMatches('example.com', 'other.com'), false);
});

test('domainMatches: *.example.com 通配（仅匹配子域）', () => {
  assert.equal(domainMatches('api.example.com', '*.example.com'), true);
  assert.equal(domainMatches('a.b.example.com', '*.example.com'), true);
  assert.equal(domainMatches('example.com', '*.example.com'), false); // apex 不命中
});

test('domainMatches: *.com 的实际语义（任何以 .com 结尾的非裸 hostname）', () => {
  // 说明：本实现采用"endsWith 语义"，与 shell glob 一致。
  //   *.example.com  → 仅匹配 .example.com 子域（example.com 本身因 prefix 为空被排除）
  //   *.com          → 匹配任何以 .com 结尾的 hostname，包括 example.com、foo.bar.com
  //                   这意味着 *.com 是个危险的白名单（几乎等同于放行所有 .com），
  //                   应在文档中提示用户慎用。
  assert.equal(domainMatches('example.com', '*.com'), true);
  assert.equal(domainMatches('foo.example.com', '*.com'), true);
  assert.equal(domainMatches('com', '*.com'), false); // 裸 apex 不命中（prefix 为空）
});

// ════════════════════════════════════════════════════════════════
// checkDomainPolicy
// ════════════════════════════════════════════════════════════════

test('checkDomainPolicy: 空策略应放行', () => {
  const r = checkDomainPolicy('example.com', {});
  assert.equal(r.allowed, true);
  assert.equal(r.blocked, false);
});

test('checkDomainPolicy: 空数组应视为不限', () => {
  const r = checkDomainPolicy('example.com', { allowedDomains: [] });
  assert.equal(r.allowed, true);
});

test('checkDomainPolicy: 黑名单优先于白名单', () => {
  const r = checkDomainPolicy('evil.com', {
    allowedDomains: ['*.com'],
    blockedDomains: ['evil.com'],
  });
  assert.equal(r.allowed, false);
  assert.equal(r.blocked, true);
});

test('checkDomainPolicy: 白名单生效', () => {
  const r1 = checkDomainPolicy('api.trusted.com', { allowedDomains: ['*.trusted.com'] });
  assert.equal(r1.allowed, true);

  const r2 = checkDomainPolicy('api.untrusted.com', { allowedDomains: ['*.trusted.com'] });
  assert.equal(r2.allowed, false);
  assert.equal(r2.blocked, false);
});

// ════════════════════════════════════════════════════════════════
// resolveAndCheckIPv4
// ════════════════════════════════════════════════════════════════

test('resolveAndCheckIPv4: 公网 IP 字面量应放行', async () => {
  const r = await resolveAndCheckIPv4('8.8.8.8');
  assert.equal(r.ok, true);
  assert.equal(r.ip, '8.8.8.8');
});

test('resolveAndCheckIPv4: 私网 IP 字面量应拒绝', async () => {
  const r = await resolveAndCheckIPv4('127.0.0.1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /私网|回环/);
});

test('resolveAndCheckIPv4: IPv6 字面量应拒绝（保守策略）', async () => {
  const r = await resolveAndCheckIPv4('::1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /IPv6/);
});

test('resolveAndCheckIPv4: localhost 应被 DNS 解析后拒绝', async () => {
  // localhost 在大多数系统上解析到 127.0.0.1（IPv4 verbatim）
  const r = await resolveAndCheckIPv4('localhost');
  assert.equal(r.ok, false);
});

test('resolveAndCheckIPv4: 不存在的域名应返回 DNS 错误', async () => {
  const r = await resolveAndCheckIPv4('this-host-should-not-exist-promptx-test.invalid');
  assert.equal(r.ok, false);
  assert.match(r.reason, /DNS 解析失败/);
});

// ════════════════════════════════════════════════════════════════
// isNetworkAllowed
// ════════════════════════════════════════════════════════════════

test('isNetworkAllowed: 默认禁用', () => {
  const prev = process.env.PERSENG_ALLOW_NETWORK;
  delete process.env.PERSENG_ALLOW_NETWORK;
  assert.equal(isNetworkAllowed(), false);

  process.env.PERSENG_ALLOW_NETWORK = '1';
  assert.equal(isNetworkAllowed(), true);

  process.env.PERSENG_ALLOW_NETWORK = '0';
  assert.equal(isNetworkAllowed(), false);

  if (prev === undefined) delete process.env.PERSENG_ALLOW_NETWORK;
  else process.env.PERSENG_ALLOW_NETWORK = prev;
});