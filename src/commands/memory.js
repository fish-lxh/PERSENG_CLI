/**
 * memory 子命令 — 列出 / 查看 / 删除 / 统计记忆
 *
 * 用法:
 *   perseng memory list                  列出当前角色的所有 engram
 *   perseng memory list --role X         指定角色
 *   perseng memory list --type PATTERN   按类型过滤
 *   perseng memory list --limit 10
 *   perseng memory show <engramId>       查看单条详情
 *   perseng memory forget <engramId>     删除一条记忆
 *   perseng memory forget --all          清空当前角色所有记忆
 *   perseng memory stats                 统计概览
 *   perseng memory stats --json          JSON 输出
 */

import { getConfig } from '../config.js';
import {
  listEngrams,
  getEngram,
  forget,
  getMemoryStats,
} from '../cognition/MemoryStore.js';

function output(data, options) {
  if (options.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n');
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

function resolveRole(options) {
  const roleId = options.role || getConfig().role;
  if (!roleId) {
    throw new Error('No role specified. Use --role <id> or set PERSENG_ROLE.');
  }
  return roleId;
}

async function listSubcommand(options) {
  const roleId = resolveRole(options);
  const engrams = await listEngrams(roleId, {
    limit: options.limit,
    offset: options.offset,
    type: options.type,
  });

  if (options.json) {
    return output({ roleId, count: engrams.length, engrams }, options);
  }

  if (engrams.length === 0) {
    return output(`(empty: 角色 "${roleId}" 没有记忆)`, options);
  }

  const lines = [`# 角色 "${roleId}" — ${engrams.length} 条记忆`, ''];
  for (const e of engrams) {
    const ts = new Date(e.timestamp).toISOString().slice(0, 19).replace('T', ' ');
    const strengthBar = '█'.repeat(Math.round(e.strength * 10)) + '░'.repeat(10 - Math.round(e.strength * 10));
    lines.push(`## [${e.type}] ${e.id}`);
    lines.push(`  时间: ${ts}  强度: ${strengthBar} (${e.strength.toFixed(2)})`);
    lines.push(`  内容: ${e.content}${e.content.length >= 200 ? '...' : ''}`);
    lines.push('');
  }
  return output(lines.join('\n'), options);
}

async function showSubcommand(engramId, options) {
  const roleId = resolveRole(options);
  const engram = await getEngram(roleId, engramId);
  if (!engram) {
    return output(`❌ 记忆 "${engramId}" 在角色 "${roleId}" 中未找到`, options);
  }
  return output(engram, options);
}

async function forgetSubcommand(engramId, options) {
  const roleId = resolveRole(options);

  if (options.all) {
    const all = await listEngrams(roleId, { limit: 500 });
    let deleted = 0;
    for (const e of all) {
      const r = await forget(roleId, e.id);
      if (r.deleted) deleted++;
    }
    return output({ roleId, deleted, total: all.length }, options);
  }

  if (!engramId) {
    return output('❌ 必须指定 engramId 或 --all', options);
  }

  const result = await forget(roleId, engramId);
  if (result.deleted) {
    return output(`✅ 已删除记忆 ${engramId}`, options);
  }
  return output(`❌ 删除失败: ${result.reason || '未找到'}`, options);
}

async function statsSubcommand(options) {
  const roleId = resolveRole(options);
  const stats = await getMemoryStats(roleId);
  if (!stats) {
    return output(`❌ 获取统计失败`, options);
  }

  if (options.json) {
    return output(stats, options);
  }

  const lines = [
    `# 角色 "${roleId}" — 记忆统计`,
    '',
    `总记忆数: ${stats.total}`,
    `数据库大小: ${(stats.dbSizeBytes / 1024).toFixed(1)} KB`,
    '',
    '## 按类型',
    ...Object.entries(stats.byType).map(([t, c]) => `  - ${t}: ${c}`),
    '',
    '## 按强度',
    `  - 强 (≥0.8): ${stats.byStrength.strong ?? 0}`,
    `  - 中 (0.5-0.8): ${stats.byStrength.medium ?? 0}`,
    `  - 弱 (<0.5): ${stats.byStrength.weak ?? 0}`,
  ];
  return output(lines.join('\n'), options);
}

export async function memoryCommand(options, subcommand, positional) {
  switch (subcommand || options._subcommand) {
    case 'list':
    case 'ls':
      return listSubcommand(options);
    case 'show':
      return showSubcommand(positional?.[0] || options.id, options);
    case 'forget':
    case 'rm':
      return forgetSubcommand(positional?.[0] || options.id, options);
    case 'stats':
      return statsSubcommand(options);
    default:
      return output(
        '用法: perseng memory <list|show|forget|stats> [options]\n' +
        '子命令:\n' +
        '  list          列出记忆\n' +
        '  show <id>     查看详情\n' +
        '  forget <id>   删除一条记忆\n' +
        '  forget --all  清空所有记忆\n' +
        '  stats         统计概览',
        options
      );
  }
}