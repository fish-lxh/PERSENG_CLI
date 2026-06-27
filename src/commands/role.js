/**
 * role 子命令 — 列出 / 查看 / 激活 / 重载角色
 *
 * 用法:
 *   perseng role list                 列出所有可用角色
 *   perseng role show [id]            查看角色详情（默认当前激活）
 *   perseng role activate <id>        激活角色（写入 ActiveRoleStore）
 *   perseng role reload               清空缓存，下次重新读盘
 */

import { getConfig, saveConfig } from '../config.js';
import { listRolesAsync, loadRole, loadRoleAsync, clearRoleCache, getRolesDir } from '../role-loader.js';
import { readActiveRoleId, writeActiveRoleId } from '../rolex/ActiveRoleStore.js';
import { autoPickRole, scoreRole } from '../cognition/RoleMatcher.js';

function output(data, options) {
  if (options.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n');
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

async function listSubcommand(options) {
  const roles = await listRolesAsync();
  const activeId = readActiveRoleId();

  if (options.json) {
    return output({
      rolesDir: getRolesDir(),
      active: activeId,
      count: roles.length,
      roles,
    }, options);
  }

  if (roles.length === 0) {
    return output(`(空: ${getRolesDir()} 下未找到任何角色定义)`, options);
  }

  const lines = [
    `# 可用角色 — ${roles.length} 个 (源目录: ${getRolesDir()})`,
    '',
  ];
  for (const r of roles) {
    const isActive = r.id === activeId ? ' ← 当前激活' : '';
    const desc = r.description ? `\n  ${r.description}` : '';
    lines.push(`• **${r.id}** — ${r.name}${isActive}${desc}`);
    lines.push('');
  }
  return output(lines.join('\n'), options);
}

function showSubcommand(roleId, options) {
  const targetId = roleId || readActiveRoleId() || getConfig().role;
  if (!targetId) {
    return output('❌ 未指定角色 ID（也没有激活的角色）', options);
  }

  let role;
  try {
    role = loadRole(targetId);
  } catch (err) {
    return output(`❌ ${err.userMessage || err.message}`, options);
  }

  if (options.json) {
    return output(role, options);
  }

  const lines = [
    `# 角色 "${targetId}"`,
    '',
    `名称: ${role.name || targetId}`,
    `描述: ${role.description || '(无)'}`,
    '',
  ];

  if (role.persona) {
    lines.push('## 人格');
    if (role.persona.type) lines.push(`类型: ${role.persona.type}`);
    if (role.persona.traits?.length) lines.push(`特质: ${role.persona.traits.join('、')}`);
    if (role.persona.dialogue_style) {
      const ds = role.persona.dialogue_style;
      if (ds.tone) lines.push(`语气: ${ds.tone}`);
      if (ds.structure) lines.push(`表达结构: ${ds.structure}`);
    }
    lines.push('');
  }

  if (role.principles?.length) {
    lines.push(`## 原则 (${role.principles.length})`);
    for (const p of role.principles) {
      lines.push(`- ${p.name || p.id || '(unnamed)'}`);
    }
    lines.push('');
  }

  if (role.knowledge?.length) {
    lines.push(`## 知识域 (${role.knowledge.length})`);
    for (const k of role.knowledge) lines.push(`- ${k}`);
    lines.push('');
  }

  if (role.routes_to?.length) {
    lines.push(`## 子代理: ${role.routes_to.join(', ')}`);
    lines.push('');
  }

  return output(lines.join('\n'), options);
}

function activateSubcommand(roleId, options) {
  if (!roleId) {
    return output('❌ 必须指定角色 ID', options);
  }

  // 先验证角色存在
  try {
    loadRole(roleId);
  } catch (err) {
    return output(`❌ ${err.userMessage || err.message}`, options);
  }

  writeActiveRoleId(roleId);
  // 同步更新 config
  saveConfig({ role: roleId });

  return output(`✅ 已激活角色 "${roleId}"`, options);
}

function reloadSubcommand(options) {
  clearRoleCache();
  return output('✅ 角色缓存已清空。下次 loadRole 将从磁盘重新读取。', options);
}

/**
 * M4.6: role auto <prompt>
 * 根据 prompt 与所有角色定义的 jaccard 相似度自动选最佳角色。
 *
 * 选项:
 *   --exclude <id1,id2>    排除这些角色
 *   --prefer  <id1,id2>    加权 +50%
 *   --min-score <0.05>     最低分阈值
 *   --no-activate          只打分、不写激活态
 *   --all                  列出所有角色的分数（top 10）
 */
async function autoSubcommand(prompt, options) {
  if (!prompt || !String(prompt).trim()) {
    return output('❌ role auto 必须提供一段 prompt 文本', options);
  }

  const list = await listRolesAsync();
  if (list.length === 0) {
    return output(`❌ 未找到任何角色 (${getRolesDir()})`, options);
  }

  // 并发加载完整角色定义
  const ids = list.map((r) => r.id);
  const fullRoles = await Promise.all(
    ids.map((id) => loadRoleAsync(id).then((role) => ({ id, role })).catch(() => ({ id, role: null })))
  );
  const ok = fullRoles.filter((r) => r.role);

  // 解析过滤选项（commander 已经把 --exclude foo,bar 转成字符串数组；也兼容单字符串）
  const parseList = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
    return String(v).split(',').map((s) => s.trim()).filter(Boolean);
  };

  const matchOpts = {
    exclude: parseList(options.exclude),
    prefer: parseList(options.prefer),
    minScore: options.minScore != null ? Number(options.minScore) : 0.05,
    fallbackId: readActiveRoleId(),
  };

  // 全员打分（用于 --all 与回溯）
  const all = ok.map((c) => ({
    id: c.id,
    score: scoreRole(prompt, c.role),
    role: c.role,
  })).sort((a, b) => b.score - a.score);

  const picked = autoPickRole(prompt, ok, null, matchOpts);

  if (options.all) {
    const lines = [`# 角色匹配 (prompt: "${prompt}")`, ''];
    const top10 = all.slice(0, 10);
    for (const e of top10) {
      lines.push(`  ${e.score.toFixed(4)}  ${e.id} — ${e.role.name || ''}`);
    }
    if (picked) lines.push('', `→ 最佳: ${picked.id} (score=${picked.score.toFixed(4)})`);
    else lines.push('', '→ 无匹配（均低于 minScore）');
    return output(lines.join('\n'), options);
  }

  if (!picked) {
    const msg = `❌ 没有角色匹配（minScore=${matchOpts.minScore}）。试用 --all 看全员分数。`;
    return output(msg, options);
  }

  if (options.json) {
    return output({
      prompt,
      picked: { id: picked.id, score: picked.score },
      all: all.map(({ id, score }) => ({ id, score })),
      options: matchOpts,
    }, options);
  }

  const lines = [
    `# 自动选角色`,
    '',
    `Prompt: ${prompt}`,
    `最佳: **${picked.id}** (score=${picked.score.toFixed(4)})`,
  ];
  if (matchOpts.fallbackId && matchOpts.fallbackId !== picked.id) {
    const fbScore = all.find((a) => a.id === matchOpts.fallbackId)?.score ?? 0;
    if (picked.score < 0.1 && fbScore === 0) {
      lines.push(`注: 匹配度较低，fallback 到当前激活角色 "${matchOpts.fallbackId}"`);
    }
  }
  lines.push('');
  lines.push('Top 5:');
  for (const e of all.slice(0, 5)) {
    lines.push(`  ${e.score.toFixed(4)}  ${e.id}`);
  }

  // 默认行为：自动激活（除非 --no-activate）
  if (!options.noActivate) {
    writeActiveRoleId(picked.id);
    saveConfig({ role: picked.id });
    lines.push('', `✅ 已激活 "${picked.id}"（use --no-activate 只打分不激活）`);
  }

  return output(lines.join('\n'), options);
}

export async function roleCommand(options, subcommand, positional) {
  const sub = subcommand || options._subcommand;
  switch (sub) {
    case 'list':
    case 'ls':
      return listSubcommand(options);
    case 'show':
      return showSubcommand(positional?.[0] || options.id, options);
    case 'activate':
      return activateSubcommand(positional?.[0] || options.id, options);
    case 'reload':
      return reloadSubcommand(options);
    case 'auto':
      return autoSubcommand(positional?.[0] || options.prompt, options);
    default:
      return output(
        '用法: perseng role <list|show|activate|reload|auto> [options]\n' +
        '子命令:\n' +
        '  list              列出所有角色\n' +
        '  show [id]         查看详情\n' +
        '  activate <id>     激活角色\n' +
        '  reload            清空角色缓存\n' +
        '  auto <prompt>     M4.6: 自动选角色（jaccard 加权）',
        options
      );
  }
}