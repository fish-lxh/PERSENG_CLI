/**
 * metrics 子命令 (M3.4)
 *
 * 输出 Prometheus 文本格式的指标快照：
 *   - perseng_info               软件版本 / Node 版本
 *   - perseng_memory_total       每个角色的记忆总数
 *   - perseng_memory_db_bytes    数据库大小
 *   - perseng_role_cache_size    角色 LRU 缓存大小
 *   - perseng_data_dir_bytes     数据目录大小（递归）
 *   - perseng_disk_free_bytes    数据目录所在磁盘剩余空间
 *   - perseng_uptime_seconds     进程启动时长
 *
 * 输出到 stdout（不是 stderr），便于 Prometheus scraper 直接拉取。
 */

import { getConfig } from '../config.js';
import { existsSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { getCognitionDir, getRolexDir, getBlackboardDir } from '../data-paths.js';
import { getRolesDir } from '../role-loader.js';
import { listEngrams, getMemoryStats } from '../cognition/MemoryStore.js';

const APP_START_TIME = Date.now();

/**
 * 递归统计目录占用字节数
 */
async function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile()) {
      total += st.size;
    } else if (st.isDirectory()) {
      total += await dirSize(p);
    }
  }
  return total;
}

/**
 * 获取每个角色的记忆指标
 */
async function collectMemoryMetrics() {
  const cognitionDir = getCognitionDir();
  const result = [];
  if (!existsSync(cognitionDir)) return result;

  let entries;
  try {
    entries = await readdir(cognitionDir);
  } catch {
    return result;
  }

  for (const name of entries) {
    const roleDir = join(cognitionDir, name);
    let st;
    try { st = statSync(roleDir); } catch { continue; }
    if (!st.isDirectory()) continue;

    const stats = await getMemoryStats(name);
    if (stats) {
      result.push({
        roleId: name,
        total: stats.total,
        dbSizeBytes: stats.dbSizeBytes,
        strong: stats.byStrength?.strong ?? 0,
        medium: stats.byStrength?.medium ?? 0,
        weak: stats.byStrength?.weak ?? 0,
      });
    }
  }
  return result;
}

/**
 * 获取角色缓存指标
 */
async function collectRoleCacheMetrics() {
  try {
    const { rolesCache } = await import('../role-loader.js');
    // 读私有变量（在测试时不可用，做容错）
    const size = rolesCache?.size ?? 0;
    return { size };
  } catch {
    return { size: 0 };
  }
}

/**
 * 收集所有指标（导出供 serve-http 等复用）
 *
 * M4.5: counter 通过依赖注入传入（默认 lazy import）
 * 这样测试可以注入自己的 snapshotCounters，避免 Node ESM cache
 * 导致 metrics.js 引用的 registry 跟测试代码引用的不是同一实例。
 */
export async function collectMetrics(options = {}, deps = {}) {
  const snapshot = deps.snapshotCounters
    || (await import('../metrics-registry.js')).snapshotCounters;
  const includeFilter = options.include
    ? new Set(options.include.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  const filters = (name) => !includeFilter || includeFilter.has(name);

  const result = {
    timestamp: Date.now(),
    metrics: {},
  };

  // 1. perseng_info
  if (filters('perseng_info')) {
    const pkg = (await import('../package-wrapper.js')).default;
    result.metrics.perseng_info = {
      value: 1,
      type: 'gauge',
      help: 'PersEng CLI 版本信息',
      labels: {
        version: pkg.version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    };
  }

  // 2. perseng_uptime_seconds
  if (filters('perseng_uptime_seconds')) {
    result.metrics.perseng_uptime_seconds = {
      value: (Date.now() - APP_START_TIME) / 1000,
      type: 'gauge',
      help: '进程启动时长（秒）',
    };
  }

  // 3. memory 指标
  if (filters('perseng_memory_total')) {
    const mem = await collectMemoryMetrics();
    for (const m of mem) {
      result.metrics[`perseng_memory_total{role="${m.roleId}"}`] = {
        value: m.total,
        type: 'gauge',
        help: '角色的记忆总数',
      };
      result.metrics[`perseng_memory_db_bytes{role="${m.roleId}"}`] = {
        value: m.dbSizeBytes,
        type: 'gauge',
        help: '角色数据库文件大小（字节）',
      };
    }
  }

  // 4. 角色缓存
  if (filters('perseng_role_cache_size')) {
    const cache = await collectRoleCacheMetrics();
    result.metrics.perseng_role_cache_size = {
      value: cache.size,
      type: 'gauge',
      help: '角色 LRU 缓存条目数',
    };
  }

  // 5. 数据目录大小
  if (filters('perseng_data_dir_bytes')) {
    const dirs = {
      cognition: getCognitionDir(),
      rolex: getRolexDir(),
      blackboard: getBlackboardDir(),
    };
    for (const [name, dir] of Object.entries(dirs)) {
      const size = await dirSize(dir);
      result.metrics[`perseng_data_dir_bytes{dir="${name}"}`] = {
        value: size,
        type: 'gauge',
        help: '数据目录占用字节数',
      };
    }
  }

  // 6. 磁盘剩余空间
  if (filters('perseng_disk_free_bytes')) {
    try {
      const { statfsSync } = await import('fs');
      const dataDir = getConfig().dataDir;
      const fs = statfsSync(dataDir);
      result.metrics.perseng_disk_free_bytes = {
        value: fs.bavail * fs.bsize,
        type: 'gauge',
        help: '数据目录所在磁盘剩余空间（字节）',
      };
    } catch {
      // statfsSync 在 Windows 上返回的字段不同，跳过
    }
  }

  // 7. M4.5: 业务 counters（按 name 暴露成独立 metric + label 子键）
  const counters = snapshot();
  for (const [counterName, entries] of Object.entries(counters)) {
    if (!filters(counterName)) continue;
    for (const e of entries) {
      const labelStr = Object.entries(e.labels || {})
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
        .join(',');
      result.metrics[`${counterName}{${labelStr}}`] = {
        value: e.value,
        type: 'counter',
        help: counterName.replace(/_/g, ' '),
      };
    }
  }

  return result;
}

/**
 * 序列化为 Prometheus 文本格式
 */
function toPrometheus(metricsObj) {
  const lines = [];
  const seen = new Set();
  for (const [key, m] of Object.entries(metricsObj.metrics)) {
    // key 可能已含 {...} 标签；提取指标名
    const baseName = key.split('{')[0];
    if (!seen.has(baseName)) {
      seen.add(baseName);
      if (m.help) lines.push(`# HELP ${baseName} ${m.help}`);
      if (m.type) lines.push(`# TYPE ${baseName} ${m.type}`);
    }
    if (m.labels) {
      const labelsStr = Object.entries(m.labels)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
        .join(',');
      lines.push(`${baseName}{${labelsStr}} ${m.value}`);
    } else {
      lines.push(`${key} ${m.value}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * 序列化为 JSON
 */
function toJson(metricsObj) {
  return metricsObj;
}

export async function metricsCommand(options) {
  const data = await collectMetrics(options);

  if (options.format === 'json') {
    process.stdout.write(JSON.stringify(toJson(data), null, 2) + '\n');
  } else {
    // default: prometheus
    process.stdout.write(toPrometheus(data));
  }
}