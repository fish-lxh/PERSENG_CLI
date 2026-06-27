/**
 * M4.5: 业务指标 counter registry
 *
 * 进程内累计，重启归零。用于 Prometheus 抓取。
 *
 * 暴露 counter:
 *   perseng_tool_invocations_total{tool, status}
 *   perseng_llm_tokens_total{model, role, kind=input|output|cache_creation|cache_read}
 *   perseng_agent_messages_total{from, to, kind=send|broadcast|inbox|mark_read}
 *   perseng_memory_ops_total{op=remember|recall|forget, status}
 *   perseng_task_total{role, status=success|failure|timeout}
 *
 * 用法：
 *   import { incrementCounter, snapshotCounters } from './metrics-registry.js';
 *   incrementCounter('perseng_tool_invocations_total', { tool: 'read_file', status: 'success' });
 *   const snap = snapshotCounters();  // → { perseng_tool_invocations_total: [...] }
 */

const counters = new Map();

/**
 * 累加一个 counter（带 label）
 *
 * @param {string} name - counter 名
 * @param {object} labels - label kv（值必须是 string/number/bool）
 * @param {number} [value=1] - 增量
 */
export function incrementCounter(name, labels = {}, value = 1) {
  const labelKey = labelsToKey(labels);
  const key = `${name}|${labelKey}`;
  const cur = counters.get(key) || { name, labels, value: 0 };
  cur.value += value;
  counters.set(key, cur);
}

/**
 * 获取所有 counter 快照（按 name + labels 聚合）
 *
 * @returns {object} { counter_name: [{ labels: {...}, value: N }, ...] }
 */
export function snapshotCounters() {
  const out = {};
  for (const entry of counters.values()) {
    if (!out[entry.name]) out[entry.name] = [];
    out[entry.name].push({ labels: entry.labels, value: entry.value });
  }
  return out;
}

/**
 * 重置所有 counter（仅测试用）
 */
export function resetCounters() {
  counters.clear();
}

function labelsToKey(labels) {
  if (!labels || Object.keys(labels).length === 0) return '';
  // 稳定排序确保 label 顺序不影响 key
  return Object.keys(labels).sort().map((k) => `${k}=${String(labels[k])}`).join(',');
}
