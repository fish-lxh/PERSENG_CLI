/**
 * 角色加载器 (stub — Step 2 实现)
 * 加载 JSON 角色定义文件，激活角色人格
 *
 * Phase 5.2 迁移：提供 loadRoleAsync（fs/promises 实现，热路径用），
 *   保留 loadRole（sync）作为冷路径兼容入口（启动 / CLI 子命令等单次调用）。
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { access, readFile, stat, readdir } from 'fs/promises';
import { join, resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { PersengError, ErrorCode } from './errors.js';
import { getConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 有界缓存（默认 32 个角色），防止长跑进程无界增长
const ROLES_CACHE_LIMIT = getConfig().rolesCacheLimit;
const rolesCache = new Map(); // roleId -> { role, mtimeMs }

/**
 * 返回角色定义文件目录
 */
export function getRolesDir() {
  return resolve(__dirname, '..', 'roles');
}

/**
 * 返回项目根目录
 */
export function getProjectRoot() {
  return resolve(__dirname, '..');
}

/**
 * 解析角色默认工作空间。
 * - role.workspace 为空时回退到 fallbackCwd
 * - 相对路径按项目根目录解析
 * - 绝对路径保持原样
 *
 * @param {object} role
 * @param {string} [fallbackCwd]
 * @returns {string}
 */
export function resolveRoleWorkspace(role, fallbackCwd = process.cwd()) {
  const fallback = resolve(fallbackCwd || process.cwd());
  const workspace = role?.workspace;
  if (!workspace || typeof workspace !== 'string' || !workspace.trim()) {
    return fallback;
  }
  return resolve(getProjectRoot(), workspace.trim());
}

/**
 * 加载角色定义（带 mtime 校验，自动感知磁盘变更）
 *
 * 同步版本，适合冷路径（启动 / CLI 子命令等单次调用）。
 * 热路径（task-engine.run）请使用 loadRoleAsync 避免阻塞事件循环。
 *
 * @param {string} roleId 角色 ID
 * @returns {object} 角色定义对象
 */
export function loadRole(roleId) {
  const rolesDir = getRolesDir();
  const filePath = join(rolesDir, `${roleId}.json`);

  if (!existsSync(filePath)) {
    throw new PersengError({
      code: ErrorCode.ROLE_NOT_FOUND,
      message: `Role "${roleId}" not found at ${filePath}`,
      userMessage: `角色 "${roleId}" 未找到 (查找路径: ${filePath})`,
      context: { roleId, filePath },
    });
  }

  // 用 mtime 检测文件变化，避免角色文件更新后仍返回旧对象
  const stat = statSync(filePath);
  const cached = rolesCache.get(roleId);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.role;
  }

  const role = JSON.parse(readFileSync(filePath, 'utf-8'));

  // LRU 简易实现：超出容量时删最早插入的（Map 保持插入顺序）
  if (rolesCache.size >= ROLES_CACHE_LIMIT) {
    const oldestKey = rolesCache.keys().next().value;
    if (oldestKey !== undefined) rolesCache.delete(oldestKey);
  }
  rolesCache.set(roleId, { role, mtimeMs: stat.mtimeMs });
  return role;
}

/**
 * 异步加载角色定义（带 mtime 校验 + LRU 缓存）
 *
 * 与 loadRole 共用同一缓存（rolesCache），所以同步调用与异步调用之间
 * 不会出现数据不一致。缓存命中时仍走同步路径立即返回（不发起磁盘 IO）。
 *
 * 热路径（task-engine.run、serve.handleTask）推荐用此版本。
 *
 * @param {string} roleId
 * @returns {Promise<object>}
 */
export async function loadRoleAsync(roleId) {
  const rolesDir = getRolesDir();
  const filePath = join(rolesDir, `${roleId}.json`);

  try {
    await access(filePath);
  } catch {
    throw new PersengError({
      code: ErrorCode.ROLE_NOT_FOUND,
      message: `Role "${roleId}" not found at ${filePath}`,
      userMessage: `角色 "${roleId}" 未找到 (查找路径: ${filePath})`,
      context: { roleId, filePath },
    });
  }

  // 缓存命中：仅 stat 一次拿 mtime 验证（fs/promises.stat 异步）
  const statRes = await stat(filePath);
  const cached = rolesCache.get(roleId);
  if (cached && cached.mtimeMs === statRes.mtimeMs) {
    return cached.role;
  }

  const raw = await readFile(filePath, 'utf-8');
  const role = JSON.parse(raw);

  if (rolesCache.size >= ROLES_CACHE_LIMIT) {
    const oldestKey = rolesCache.keys().next().value;
    if (oldestKey !== undefined) rolesCache.delete(oldestKey);
  }
  rolesCache.set(roleId, { role, mtimeMs: statRes.mtimeMs });
  return role;
}

/**
 * 获取可用角色列表（同步，保留兼容）
 * @returns {Array<{id: string, name: string, description: string}>}
 */
export function listRolesSync() {
  const rolesDir = getRolesDir();
  if (!existsSync(rolesDir)) return [];

  return readdirSync(rolesDir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => {
      try {
        const role = JSON.parse(readFileSync(join(rolesDir, f), 'utf-8'));
        return {
          id: role.id || f.replace('.json', ''),
          name: role.name || role.id,
          description: role.description || '',
        };
      } catch {
        return { id: f.replace('.json', ''), name: f.replace('.json', ''), description: '' };
      }
    });
}

/**
 * 异步获取可用角色列表
 */
export async function listRolesAsync() {
  const rolesDir = getRolesDir();
  let entries;
  try {
    entries = await readdir(rolesDir);
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map(async (f) => {
        try {
          const raw = await readFile(join(rolesDir, f), 'utf-8');
          const role = JSON.parse(raw);
          return {
            id: role.id || f.replace('.json', ''),
            name: role.name || role.id,
            description: role.description || '',
          };
        } catch {
          return { id: f.replace('.json', ''), name: f.replace('.json', ''), description: '' };
        }
      })
  );
  return results;
}

/**
 * 激活角色 — 从角色定义生成 system prompt 片段
 * @param {object} role 角色定义对象
 * @returns {string} 角色的 system prompt
 */
export function activateRole(role) {
  if (!role) {
    throw new PersengError({
      code: ErrorCode.INTERNAL,
      message: 'activateRole: role is empty/undefined',
      userMessage: '角色定义为空',
    });
  }

  const sections = [];

  // 基本身份
  sections.push(`# 角色: ${role.name || role.id}`);
  if (role.description) sections.push(role.description);
  sections.push('');

  // 人格特征
  if (role.persona) {
    sections.push('## 人格特征');
    if (role.persona.type) sections.push(`人格类型: ${role.persona.type}`);
    if (role.persona.traits?.length) {
      sections.push(`核心特质: ${role.persona.traits.join('、')}`);
    }
    if (role.persona.dialogue_style) {
      const ds = role.persona.dialogue_style;
      if (ds.tone) sections.push(`语气: ${ds.tone}`);
      if (ds.structure) sections.push(`表达结构: ${ds.structure}`);
    }
    sections.push('');
  }

  // 思维模式
  if (role.persona?.thinking_patterns?.length) {
    sections.push('## 思维模式');
    for (const tp of role.persona.thinking_patterns) {
      const heading = `### ${tp.name || tp.id || '思维框架'}`;
      const desc = tp.shortDescription || '';
      const content = tp.content || '';
      sections.push([heading, desc, content].filter(Boolean).join('\n'));
    }
    sections.push('');
  }

  // 原则
  if (role.principles?.length) {
    sections.push('## 行为原则');
    for (const p of role.principles) {
      sections.push(`### ${p.name || p.id || '原则'}`);
      if (p.content) sections.push(p.content);
    }
    sections.push('');
  }

  // 知识域
  if (role.knowledge?.length) {
    sections.push('## 知识域');
    for (const k of role.knowledge) {
      sections.push(`- ${k}`);
    }
    sections.push('');
  }

  // 子代理路由（已废弃：所有任务都通过内置工具自己完成）
  // 旧字段 routes_to 保留以兼容已有角色 JSON，但不渲染提示。
  if (role.routes_to?.length) {
    // 静默忽略，不再注入可指挥子代理文案
  }

  // 附上 Gherkin 原文
  if (role.gherkin_source) {
    sections.push('## 角色原始定义 (Gherkin)');
    sections.push('```gherkin');
    sections.push(role.gherkin_source);
    sections.push('```');
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * 清空角色缓存
 */
export function clearRoleCache() {
  rolesCache.clear();
}
