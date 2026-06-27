/**
 * M4.6: 角色自动选择（role auto）
 *
 * 根据一段 prompt / 关键词在所有角色定义中挑最匹配的一个。
 * 用途：
 *   - `perseng role auto <prompt>` CLI 子命令
 *   - serve-http / feishu 等入口在没指定 role 时自动派单
 *
 * 设计目标：
 *   - 零依赖（不 import MemoryStore / Network）
 *   - 纯函数，便于单测
 *   - 阈值 / 加权可调
 *
 * 算法：
 *   1. 把角色定义压成"指纹文本"（name + description + knowledge + routes_to）
 *   2. 把 prompt 同样切 charBigrams
 *   3. 对每个角色算加权 jaccard
 *   4. 加权：name ×3、description ×1、knowledge ×1、routes_to ×0.5
 *   5. 应用过滤（exclude / require / prefer）后取 top1
 *   6. 低于 minScore 阈值时返回 null（调用方 fallback 到 active role）
 */

const FINGERPRINT_WEIGHTS = {
  name: 3,
  description: 1,
  knowledge: 1,
  routes_to: 0.5,
  tags: 0.8,
};

/**
 * 切 char bigrams（与 M4.2 MemoryStore.jaccardSimilarity 同算法，独立实现以避免耦合）
 */
export function charBigrams(s) {
  const cleaned = String(s || '').replace(/\s+/g, '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < cleaned.length - 1; i++) {
    set.add(cleaned.slice(i, i + 2));
  }
  return set;
}

/**
 * 计算两个字符串的 jaccard 相似度（基于 charBigrams）
 * @returns {number} [0,1]
 */
export function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = charBigrams(a);
  const setB = charBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const bg of setA) if (setB.has(bg)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 把角色定义压成 fingerprint 文本（可读 + 用于调试）
 * @param {object} role 完整角色定义
 * @returns {{text: string, components: object}}
 */
export function buildFingerprint(role) {
  if (!role || typeof role !== 'object') {
    return { text: '', components: {} };
  }

  const parts = [];
  const components = {};

  if (role.name) {
    const v = String(role.name);
    parts.push(v);
    components.name = v;
  }
  if (role.description) {
    const v = String(role.description);
    parts.push(v);
    components.description = v;
  }
  if (Array.isArray(role.knowledge)) {
    const v = role.knowledge.filter(Boolean).map(String).join(' ');
    if (v) {
      parts.push(v);
      components.knowledge = v;
    }
  }
  if (Array.isArray(role.routes_to)) {
    const v = role.routes_to.filter(Boolean).map(String).join(' ');
    if (v) {
      parts.push(v);
      components.routes_to = v;
    }
  }
  if (Array.isArray(role.tags)) {
    const v = role.tags.filter(Boolean).map(String).join(' ');
    if (v) {
      parts.push(v);
      components.tags = v;
    }
  }

  return { text: parts.join(' '), components };
}

/**
 * 计算 query 与角色指纹的加权 jaccard 分
 *
 * 对 fingerprint 各 component 分别算 jaccard，按 FINGERPRINT_WEIGHTS 加权求和，
 * 最后归一化到 [0,1]。
 *
 * @param {string} query
 * @param {object} role
 * @returns {number} [0,1]
 */
export function scoreRole(query, role) {
  if (!query || !role) return 0;
  const q = String(query);
  const fp = buildFingerprint(role);
  if (!fp.text) return 0;

  let weightedSum = 0;
  let weightTotal = 0;

  for (const [field, text] of Object.entries(fp.components)) {
    const w = FINGERPRINT_WEIGHTS[field] ?? 1;
    const s = jaccardSimilarity(q, text);
    weightedSum += s * w;
    weightTotal += w;
  }

  return weightTotal === 0 ? 0 : weightedSum / weightTotal;
}

/**
 * 在候选角色列表里挑 top1
 *
 * @param {string} query 用户输入
 * @param {Array<{id, role?, name?, description?}>} candidates - 至少含 id；role 可选（则用 name/description 兜底）
 * @param {object} [options]
 * @param {string[]} [options.exclude] 排除的角色 id
 * @param {string[]} [options.require] 必须包含的 id 子串
 * @param {string[]} [options.prefer] 加权 +50% 的 id 列表
 * @param {number} [options.minScore=0.05] 低于此分返回 null
 * @param {string} [options.fallbackId] 找不到时返回
 * @returns {{id: string, score: number, all: Array<{id, score}>} | null}
 */
export function selectBestRole(query, candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const excludeSet = new Set(options.exclude || []);
  const preferSet = new Set(options.prefer || []);

  const filtered = candidates.filter((c) => {
    if (excludeSet.has(c.id)) return false;
    if (options.require && options.require.length > 0) {
      const matches = options.require.some((r) => c.id.includes(r));
      if (!matches) return false;
    }
    return true;
  });

  if (filtered.length === 0) return null;

  // 单角色直接返回（jaccard 在短文本上很虚）
  if (filtered.length === 1) {
    const only = filtered[0];
    return { id: only.id, score: 1.0, all: [{ id: only.id, score: 1.0 }] };
  }

  const scored = filtered.map((c) => {
    let s = scoreRole(query, c.role || c);
    if (preferSet.has(c.id)) s = Math.min(1, s * 1.5);
    return { id: c.id, score: s };
  });

  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top.score < (options.minScore ?? 0.05)) {
    if (options.fallbackId) {
      const fallback = scored.find((s) => s.id === options.fallbackId);
      return fallback || { id: options.fallbackId, score: 0, all: scored };
    }
    return null;
  }

  return top;
}

/**
 * 高层封装：传入角色 id 列表，自动加载完整 role 定义再评分
 *
 * 用于 `role auto <prompt>` CLI 子命令与热路径（serve-http 等）。
 *
 * @param {string} query
 * @param {string[]} roleIds
 * @param {object} [loadRole] - 角色加载函数（默认用 listRolesAsync + loadRoleAsync）
 * @param {object} [options] 同 selectBestRole
 * @returns {Promise<{id, score, all} | null>}
 */
export async function autoPickRole(query, roleIds, loadRoleFn, options = {}) {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return null;
  const candidates = [];
  for (const id of roleIds) {
    try {
      const role = loadRoleFn ? await loadRoleFn(id) : null;
      candidates.push({ id, role });
    } catch {
      candidates.push({ id, role: null });
    }
  }
  // 过滤掉加载失败的
  const ok = candidates.filter((c) => c.role);
  if (ok.length === 0) return null;
  return selectBestRole(query, ok, options);
}