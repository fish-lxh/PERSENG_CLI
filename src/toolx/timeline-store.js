/**
 * Timeline Store — 时间线事件存储
 *
 * 数据模型：
 *   TimelineEvent = {
 *     id: string,           // ULID-like
 *     time: string,         // ISO 8601 时间戳（如 2026-06-24T14:30:00Z）
 *     title: string,        // 简短标题
 *     description?: string, // 详细描述
 *     category: string,     // 分类（如 'release' / 'milestone' / 'incident' / 'meeting' / 'note'）
 *     tags?: string[],      // 标签
 *     source?: string,      // 来源（如 'web-search' / 'manual' / 'agent:jiangziya'）
 *     metadata?: object,    // 任意附加数据
 *     createdAt: string,    // 创建时间
 *     updatedAt: string,    // 更新时间
 *   }
 *
 * 存储：单 JSON 文件（events 数组） + 原子写
 * 路径：~/.perseng-cli/timeline/timeline.json
 *
 * 适合场景：
 *   - 项目里程碑跟踪
 *   - 事件流记录
 *   - Agent 自动记录重要事件
 *   - LLM 时间线问答（"过去一周发生了什么"）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getConfig } from '../config.js';

// ──── 路径 ────

function getDir() {
  const config = getConfig();
  return config.timelineDir || join(config.dataDir, 'timeline');
}

function getFile() {
  return join(getDir(), 'timeline.json');
}

// ──── 基础 I/O ────

function readAll() {
  const path = getFile();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(events) {
  const dir = getDir();
  mkdirSync(dir, { recursive: true });
  const path = getFile();
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(events, null, 2), 'utf-8');
  renameSync(tmp, path);
}

// ──── ID 生成 ────

function generateId() {
  // 时间戳 + 4 字节随机 → 排序友好且足够唯一
  return `evt-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

// ──── 校验 ────

const VALID_CATEGORIES = new Set([
  'release',     // 版本发布
  'milestone',   // 里程碑
  'incident',    // 事故 / 问题
  'meeting',     // 会议
  'decision',    // 决策
  'note',        // 备注
  'task',        // 任务
  'custom',      // 自定义
]);

function validateEventInput(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'event 对象不能为空' };
  }
  if (!input.title || typeof input.title !== 'string' || !input.title.trim()) {
    return { ok: false, error: 'title 不能为空' };
  }
  if (input.category && !VALID_CATEGORIES.has(input.category)) {
    return {
      ok: false,
      error: `未知 category "${input.category}"，可用: ${[...VALID_CATEGORIES].join(', ')}`,
    };
  }
  return { ok: true };
}

// ──── 公开 API ────

/**
 * 添加事件
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.time]      - ISO 8601，缺省 = now()
 * @param {string} [input.description]
 * @param {string} [input.category='note']
 * @param {string[]} [input.tags]
 * @param {string} [input.source]
 * @param {object} [input.metadata]
 * @returns {TimelineEvent}
 */
export function addEvent(input) {
  const check = validateEventInput(input);
  if (!check.ok) throw new Error(check.error);

  const events = readAll();
  const now = new Date().toISOString();
  const event = {
    id: generateId(),
    time: input.time || now,
    title: input.title.trim(),
    description: input.description || null,
    category: input.category || 'note',
    tags: Array.isArray(input.tags) ? input.tags : [],
    source: input.source || null,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : null,
    createdAt: now,
    updatedAt: now,
  };
  events.push(event);
  writeAll(events);
  return event;
}

/**
 * 更新事件
 */
export function updateEvent(id, patch) {
  if (!id) throw new Error('id 必填');
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx < 0) throw new Error(`事件 ${id} 不存在`);

  const allowed = ['title', 'time', 'description', 'category', 'tags', 'source', 'metadata'];
  for (const key of Object.keys(patch || {})) {
    if (!allowed.includes(key)) {
      throw new Error(`字段 "${key}" 不允许更新（允许: ${allowed.join(', ')}）`);
    }
  }
  if (patch.category && !VALID_CATEGORIES.has(patch.category)) {
    throw new Error(`未知 category "${patch.category}"`);
  }

  const updated = {
    ...events[idx],
    ...patch,
    id: events[idx].id,        // id 不可改
    createdAt: events[idx].createdAt, // createdAt 不可改
    updatedAt: new Date().toISOString(),
  };
  events[idx] = updated;
  writeAll(events);
  return updated;
}

/**
 * 删除事件
 */
export function deleteEvent(id) {
  const events = readAll();
  const idx = events.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: `事件 ${id} 不存在` };
  const removed = events.splice(idx, 1);
  writeAll(events);
  return { ok: true, removed: removed[0] };
}

/**
 * 列出事件（按 time 倒序）
 * @param {object} [options]
 * @param {string} [options.category]
 * @param {string[]} [options.tags]
 * @param {string} [options.since]   - ISO 8601，只返回 >= 此时间的事件
 * @param {string} [options.until]   - ISO 8601，只返回 <= 此时间的事件
 * @param {string} [options.search]  - 在 title + description 中模糊匹配
 * @param {number} [options.limit=50]
 * @returns {TimelineEvent[]}
 */
export function listEvents(options = {}) {
  const events = readAll();
  let result = events;

  if (options.category) {
    result = result.filter((e) => e.category === options.category);
  }
  if (Array.isArray(options.tags) && options.tags.length > 0) {
    result = result.filter((e) =>
      options.tags.every((t) => Array.isArray(e.tags) && e.tags.includes(t))
    );
  }
  if (options.since) {
    const sinceTs = new Date(options.since).getTime();
    result = result.filter((e) => new Date(e.time).getTime() >= sinceTs);
  }
  if (options.until) {
    const untilTs = new Date(options.until).getTime();
    result = result.filter((e) => new Date(e.time).getTime() <= untilTs);
  }
  if (options.search) {
    const q = options.search.toLowerCase();
    result = result.filter((e) =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.description || '').toLowerCase().includes(q)
    );
  }

  // 按 time 倒序
  result = [...result].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  const limit = Math.min(options.limit || 50, 500);
  return result.slice(0, limit);
}

/**
 * 获取单个事件
 */
export function getEvent(id) {
  return readAll().find((e) => e.id === id) || null;
}

/**
 * 统计：按 category 分组计数
 */
export function stats() {
  const events = readAll();
  const byCategory = {};
  let earliest = null;
  let latest = null;
  for (const e of events) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
    const t = new Date(e.time).getTime();
    if (!earliest || t < earliest) earliest = e.time;
    if (!latest || t > latest) latest = e.time;
  }
  return {
    total: events.length,
    byCategory,
    earliest,
    latest,
  };
}

/**
 * 导出为 Markdown / JSON
 */
export function exportTimeline(format = 'markdown', options = {}) {
  const events = listEvents(options);
  if (format === 'json') {
    return JSON.stringify(events, null, 2);
  }
  if (format === 'markdown') {
    const lines = [`# Timeline (${events.length} events)\n`];
    let currentDay = null;
    for (const e of events) {
      const day = e.time.slice(0, 10);
      if (day !== currentDay) {
        lines.push(`\n## ${day}\n`);
        currentDay = day;
      }
      const tags = e.tags?.length ? ` \`#${e.tags.join(' #')}\`` : '';
      lines.push(`- **${e.time.slice(11, 16)}** [${e.category}] ${e.title}${tags}`);
      if (e.description) {
        lines.push(`  ${e.description}`);
      }
    }
    return lines.join('\n');
  }
  throw new Error(`不支持的导出格式: ${format}`);
}

/**
 * 重置（仅测试用）
 */
export function resetTimelineStore() {
  // 不删文件，只让调用方在测试里覆盖目录
}
