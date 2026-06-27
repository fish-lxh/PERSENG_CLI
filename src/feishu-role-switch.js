import { listRolesSync, loadRole } from './role-loader.js';

function normalize(text) {
  return String(text || '').trim();
}

export function parseRoleCommand(text) {
  const raw = normalize(text);
  if (!raw.startsWith('/role')) return null;

  const parts = raw.split(/\s+/).filter(Boolean);
  const action = (parts[1] || 'show').toLowerCase();
  const arg = parts[2] || '';

  if (action === 'ls') return { action: 'list' };
  if (action === 'list') return { action: 'list' };
  if (action === 'show') return { action: 'show' };
  if (action === 'set') return { action: 'set', roleId: arg };

  return { action: 'help' };
}

export function handleRoleCommand({ text, currentRoleId, senderId, roleAdmins }) {
  const cmd = parseRoleCommand(text);
  if (!cmd) return { handled: false };

  const roles = listRolesSync();
  const ids = roles.map((r) => r.id);

  if (cmd.action === 'list') {
    const lines = ['可用角色：', ...roles.map((r) => `- ${r.id} — ${r.name || r.id}`)];
    return { handled: true, reply: lines.join('\n') };
  }

  if (cmd.action === 'show') {
    const current = currentRoleId || '';
    const lines = [
      `当前角色：${current || '(未设置)'}`,
      '用法：',
      '  /role list',
      '  /role set <roleId>',
    ];
    return { handled: true, reply: lines.join('\n') };
  }

  if (cmd.action === 'set') {
    const next = normalize(cmd.roleId);
    if (!next) {
      return { handled: true, reply: '用法：/role set <roleId>' };
    }

    if (roleAdmins && roleAdmins.size > 0 && !roleAdmins.has(senderId)) {
      return { handled: true, reply: '无权限：仅白名单用户可切换角色。' };
    }

    if (!ids.includes(next)) {
      return { handled: true, reply: `角色不存在：${next}\n可用：${ids.join(', ')}` };
    }

    try {
      loadRole(next);
    } catch (err) {
      return { handled: true, reply: `角色加载失败：${err.userMessage || err.message}` };
    }

    return { handled: true, reply: `✅ 已切换角色：${next}`, nextRoleId: next };
  }

  return {
    handled: true,
    reply: [
      '用法：',
      '  /role list',
      '  /role show',
      '  /role set <roleId>',
    ].join('\n'),
  };
}

