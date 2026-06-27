let BetterSqlite3 = null;
try {
  ({ default: BetterSqlite3 } = await import('better-sqlite3'));
} catch {
  BetterSqlite3 = null;
}

let SqlJs = null;
if (!BetterSqlite3) {
  const { default: initSqlJs } = await import('sql.js');
  SqlJs = await initSqlJs();
}

import os from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { Network } from './Network.js';
import { fineRankEngrams, getRecallModeParams } from './RecallStrategy.js';
import { getCognitionDir } from '../data-paths.js';
import { childLogger } from '../logger.js';
import { getConfig } from '../config.js';

const log = childLogger('memory');

const HOME_DIR = os.homedir();
const PERSENG_COGNITION_DIR = join(HOME_DIR, '.perseng', 'cognition');

function createSqlJsAdapter(dbPath, options = {}) {
  const readonly = options.readonly === true;
  let txDepth = 0;

  const loadFile = () => {
    if (!existsSync(dbPath)) return null;
    const buf = readFileSync(dbPath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  };

  const raw = loadFile();
  const db = raw ? new SqlJs.Database(raw) : new SqlJs.Database();

  const persist = () => {
    if (readonly) return;
    const bytes = db.export();
    writeFileSync(dbPath, Buffer.from(bytes));
  };

  const adapter = {
    exec(sql) {
      db.exec(sql);
      if (!readonly && txDepth === 0) persist();
    },
    prepare(sql) {
      return {
        get(...params) {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            const ok = stmt.step();
            return ok ? stmt.getAsObject() : undefined;
          } finally {
            try { stmt.free(); } catch {}
          }
        },
        all(...params) {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            const rows = [];
            while (stmt.step()) rows.push(stmt.getAsObject());
            return rows;
          } finally {
            try { stmt.free(); } catch {}
          }
        },
        run(...params) {
          const stmt = db.prepare(sql);
          try {
            stmt.bind(params);
            stmt.step();
            const changes = db.getRowsModified();
            if (!readonly && txDepth === 0) persist();
            const last = db.exec('SELECT last_insert_rowid() AS id');
            const lastInsertRowid = last?.[0]?.values?.[0]?.[0] ?? 0;
            return { changes, lastInsertRowid };
          } finally {
            try { stmt.free(); } catch {}
          }
        },
      };
    },
    transaction(fn) {
      return (...args) => {
        if (readonly) return fn(...args);
        txDepth++;
        db.exec('BEGIN');
        try {
          const r = fn(...args);
          db.exec('COMMIT');
          txDepth--;
          if (txDepth === 0) persist();
          return r;
        } catch (e) {
          try { db.exec('ROLLBACK'); } catch {}
          txDepth--;
          throw e;
        }
      };
    },
    close() {
      try {
        if (!readonly) persist();
      } catch {}
      try { db.close(); } catch {}
    },
  };

  return adapter;
}

function getRoleDir(roleId) {
  return join(getCognitionDir(), roleId);
}

function getPersengRoleDir(roleId) {
  return join(PERSENG_COGNITION_DIR, roleId);
}

function ensureRoleDirectory(roleId) {
  const dir = getRoleDir(roleId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getNetwork(roleId) {
  const roleDir = ensureRoleDirectory(roleId);
  const persengRoleDir = getPersengRoleDir(roleId);
  return new Network({ roleDir, persengRoleDir });
}

function importPersengDbIfNeeded(db, roleId) {
  const srcDbPath = join(getPersengRoleDir(roleId), 'engrams.db');
  if (!existsSync(srcDbPath)) return;

  try {
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM engrams`).get();
    if (countRow?.count > 0) return;
  } catch {
    return;
  }

  // 用局部变量持有 srcDb，确保即使 new Database() 抛出也能让外层感知
  // （finally 兜底关闭）
  let srcDb = null;
  try {
    srcDb = BetterSqlite3
      ? new BetterSqlite3(srcDbPath, { readonly: true, fileMustExist: true })
      : createSqlJsAdapter(srcDbPath, { readonly: true });
    const engrams = srcDb.prepare(`SELECT * FROM engrams`).all();
    let cues = [];
    try {
      cues = srcDb.prepare(`SELECT * FROM cue_index`).all();
    } catch {
      cues = [];
    }

    const insertEngram = db.prepare(
      `INSERT OR REPLACE INTO engrams (id, content, schema, type, timestamp, strength, metadata)
       VALUES (@id, @content, @schema, @type, @timestamp, @strength, @metadata)`
    );
    const insertCue = db.prepare(`INSERT OR IGNORE INTO cue_index (word, engram_id) VALUES (@word, @engram_id)`);

    const tx = db.transaction(() => {
      for (const e of engrams) insertEngram.run(e);
      for (const c of cues) insertCue.run(c);
    });
    tx();
  } finally {
    if (srcDb) {
      try { srcDb.close(); } catch { /* ignore */ }
    }
  }
}

function getDb(roleId) {
  const openDb = () => {
    const dir = ensureRoleDirectory(roleId);
    let db = null;
    try {
      const dbPath = join(dir, 'engrams.db');
      db = BetterSqlite3 ? new BetterSqlite3(dbPath) : createSqlJsAdapter(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS engrams (
          id TEXT PRIMARY KEY,
          content TEXT,
          schema TEXT,
          type TEXT,
          timestamp INTEGER,
          strength REAL,
          metadata TEXT
        );
        CREATE TABLE IF NOT EXISTS cue_index (
          word TEXT,
          engram_id TEXT,
          PRIMARY KEY (word, engram_id)
        );
        CREATE INDEX IF NOT EXISTS idx_engrams_type ON engrams(type);
        CREATE INDEX IF NOT EXISTS idx_engrams_timestamp ON engrams(timestamp);
        CREATE INDEX IF NOT EXISTS idx_cue_word ON cue_index(word);
      `);
      importPersengDbIfNeeded(db, roleId);
      return db;
    } catch (err) {
      // 关键修复：失败路径上若 db 已 open，必须 close 防止句柄泄漏
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
      throw err;
    }
  };

  try {
    return openDb();
  } catch (e) {
    if (e && e.code === 'SQLITE_CANTOPEN') {
      // 旧路径不可写（只读盘 / 权限不足），让外层 fallback
      throw e;
    }
    throw e;
  }
}

function normalizeSchema(schema) {
  if (!schema) return [];
  if (Array.isArray(schema)) return schema.map((s) => String(s).trim()).filter(Boolean);
  if (typeof schema === 'string') {
    if (schema.includes('\n')) return schema.split('\n').map((s) => s.trim()).filter(Boolean);
    if (schema.includes(' - ')) return schema.split(' - ').map((s) => s.trim()).filter(Boolean);
    return schema.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function rowToEngram(row) {
  const schema = normalizeSchema(JSON.parse(row.schema || '[]'));
  let metadata = null;
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : null;
  } catch {
    metadata = null;
  }
  return {
    id: row.id,
    content: row.content,
    schema,
    type: row.type || 'ATOMIC',
    timestamp: row.timestamp || 0,
    strength: typeof row.strength === 'number' ? row.strength : 0.5,
    metadata,
  };
}

function tokenize(q) {
  return String(q || '')
    .split(/[\s,，.。;；:：!?！？()\[\]{}<>\\/|'"`~@#$%^&*+=-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/**
 * M4.2: 计算两条文本的 jaccard 相似度（基于 character bigram 集合）
 * 用 bigram 而不是 word token 是因为：
 *   - tokenize() 对中文标点处理有 bug，会把整句当作一个 token
 *   - char bigram 对中英文都鲁棒，不需要分词
 *   - 短文本（< 200 字符）上 bigram jaccard 效果不错
 *
 * 例：'牛肉面' → {牛肉, 肉面}；'牛肉面粉' → {牛肉, 肉面, 面粉}
 *   inter=2, union=3, jaccard=0.67
 */
function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const setA = charBigrams(a);
  const setB = charBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 字符 bigram 集合。aBc → {aB, Bc}。
 * 跳过空白字符。
 */
function charBigrams(s) {
  const cleaned = String(s || '').replace(/\s+/g, '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < cleaned.length - 1; i++) {
    set.add(cleaned.slice(i, i + 2));
  }
  return set;
}

/**
 * 计算内容指纹（用于去重）
 * SHA1(roleId + ':' + content[:100] + ':' + content.slice(-100))
 * 取首尾各 100 字做指纹，避免长内容 hash 慢，也避免短文本误判。
 */
function contentFingerprint(roleId, content) {
  const c = String(content || '');
  const head = c.slice(0, 100);
  const tail = c.length > 100 ? c.slice(-100) : '';
  return createHash('sha1')
    .update(`${roleId}:${head}:${tail}`)
    .digest('hex')
    .slice(0, 16);
}

const MAX_ENGRAMS_PER_ROLE = getConfig().maxMemoriesPerRole;

/**
 * 删除最旧的低 strength 记忆以腾出空间
 */
function pruneOldEngrams(db, roleId, targetCount) {
  try {
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM engrams`).get();
    const cur = countRow?.c ?? 0;
    if (cur <= targetCount) return 0;

    const toDelete = cur - targetCount;
    const result = db.prepare(
      `DELETE FROM engrams WHERE id IN (
         SELECT id FROM engrams ORDER BY timestamp ASC, strength ASC LIMIT ?
       )`
    ).run(toDelete);
    return result.changes || 0;
  } catch {
    return 0;
  }
}

export async function remember(roleId, content, options = {}) {
  if (!roleId || !content) return null;

  const db = getDb(roleId);
  const network = getNetwork(roleId);
  await network.ensure();

  // P2.3: dedup by fingerprint (roleId + content head/tail)
  // 写入到 metadata.fingerprint；插入前查重
  const fingerprint = contentFingerprint(roleId, content);

  // dedup 开关：options.dedup === false 可跳过（用于 batch import 等场景）
  if (options.dedup !== false) {
    try {
      const existing = db.prepare(
        `SELECT id FROM engrams WHERE metadata LIKE ? LIMIT 1`
      ).get(`%"fingerprint":"${fingerprint}"%`);
      if (existing) {
        // 已存在相同内容，跳过（不算错误）
        return existing.id;
      }
    } catch {
      // metadata 列可能损坏 → 跳过 dedup，直接插入
    }
  }

  // M4.2: jaccard 近重复检测（语义重复但措辞不同）
  // 默认开启，可用 options.mergeSimilar === false 关闭
  // 阈值 0.75：模板化但不同语义的 engram（如 "stats test 1" vs "stats test 2"，
  // jaccard=0.75 处于边界）会被合并 → 调用方应避免此类测试/合成数据进入记忆层。
  // 真实业务场景下，措辞微调但语义相同的两条记忆仍会被合并。
  const mergeThreshold = options.mergeThreshold ?? 0.75;
  if (options.mergeSimilar !== false && mergeThreshold > 0) {
    try {
      // 扫描最近 50 条同角色记忆，找 jaccard > threshold 的
      const recent = db.prepare(
        `SELECT id, content, schema, type, strength, metadata FROM engrams
         ORDER BY timestamp DESC LIMIT 50`
      ).all();

      let bestMatch = null;
      let bestScore = 0;
      for (const row of recent) {
        const score = jaccardSimilarity(content, row.content);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = row;
        }
      }

      if (bestMatch && bestScore >= mergeThreshold) {
        // 合并：append 新内容到原 engram，累加 recall_count，刷新 timestamp
        const mergedContent = bestMatch.content.length < 1000
          ? `${bestMatch.content}\n--\n${content}`
          : bestMatch.content; // 防止过长
        const newStrength = Math.min(1, (bestMatch.strength || 0.5) + 0.05);

        // recall_count 存在 metadata 里（避免改 schema）
        let userMeta = {};
        try { userMeta = bestMatch.metadata ? JSON.parse(bestMatch.metadata) : {}; } catch { /* ignore */ }
        const newRecall = (userMeta.recall_count || 0) + 1;
        userMeta.recall_count = newRecall;
        userMeta.lastMergedAt = Date.now();

        db.prepare(
          `UPDATE engrams SET content = ?, strength = ?, timestamp = ?, metadata = ? WHERE id = ?`
        ).run(mergedContent, newStrength, Date.now(), JSON.stringify(userMeta), bestMatch.id);

        return bestMatch.id;
      }
    } catch (err) {
      // 合并检测失败不应阻塞主流程
      log.warn({ err: err.message, roleId }, 'merge-similar check failed, falling through to insert');
    }
  }

  const timestamp = options.timestamp || Date.now();
  const id = options.id || `${timestamp}_${Math.random().toString(36).slice(2, 11)}`;
  const type = options.type || 'ATOMIC';
  const strength = Math.min(1, Math.max(0, options.strength ?? 0.8));
  const schema = normalizeSchema(options.schema || options.keywords || content.split(/\s+/).slice(0, 10));
  // P2.3: 把 fingerprint 嵌入 metadata
  const userMeta = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const metadata = JSON.stringify({ ...userMeta, fingerprint });

  try {
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT OR REPLACE INTO engrams (id, content, schema, type, timestamp, strength, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, content, JSON.stringify(schema), type, timestamp, strength, metadata);

      db.prepare(`DELETE FROM cue_index WHERE engram_id = ?`).run(id);
      const insertCue = db.prepare(`INSERT OR IGNORE INTO cue_index (word, engram_id) VALUES (?, ?)`);
      for (const word of schema) insertCue.run(word, id);
    });
    tx();

    // P2.3: 每角色上限，超过时删最旧低 strength
    pruneOldEngrams(db, roleId, MAX_ENGRAMS_PER_ROLE);

    await network.updateFromSchema(schema, id, { timestamp, strength });
    return id;
  } catch (err) {
    log.error({ err: err.message, roleId }, 'remember failed');
    return null;
  } finally {
    db.close();
  }
}

export async function rememberBatch(roleId, engrams) {
  if (!roleId || !engrams?.length) return [];

  const db = getDb(roleId);
  const network = getNetwork(roleId);
  await network.ensure();

  const ids = [];

  try {
    const tx = db.transaction(() => {
      for (const eng of engrams) {
        const timestamp = eng.timestamp || Date.now();
        const id = eng.id || `${timestamp}_${Math.random().toString(36).slice(2, 11)}`;
        const type = eng.type || 'ATOMIC';
        const strength = Math.min(1, Math.max(0, eng.strength ?? 0.8));
        const schema = normalizeSchema(eng.schema || eng.keywords || eng.content.split(/\s+/).slice(0, 10));
        const metadata = eng.metadata ? JSON.stringify(eng.metadata) : null;

        db.prepare(
          `INSERT OR REPLACE INTO engrams (id, content, schema, type, timestamp, strength, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, eng.content, JSON.stringify(schema), type, timestamp, strength, metadata);

        db.prepare(`DELETE FROM cue_index WHERE engram_id = ?`).run(id);
        const insertCue = db.prepare(`INSERT OR IGNORE INTO cue_index (word, engram_id) VALUES (?, ?)`);
        for (const word of schema) insertCue.run(word, id);

        ids.push(id);
      }
    });
    tx();

    // 批量更新 network（一次 IO，避免 N 次写盘）
    for (let i = 0; i < engrams.length; i++) {
      const eng = engrams[i];
      const schema = normalizeSchema(eng.schema || eng.keywords || eng.content.split(/\s+/).slice(0, 10));
      const timestamp = eng.timestamp || Date.now();
      const strength = Math.min(1, Math.max(0, eng.strength ?? 0.8));
      await network.updateFromSchema(schema, ids[i], { timestamp, strength });
    }

    return ids;
  } catch (err) {
    log.error({ err: err.message, roleId, count: engrams?.length }, 'rememberBatch failed');
    return ids;
  } finally {
    db.close();
  }
}

export async function recall(roleId, query, options = {}) {
  if (!roleId) return [];
  const db = getDb(roleId);
  const networkStore = getNetwork(roleId);

  try {
    const mode = options.mode || 'balanced';
    const modeParams = getRecallModeParams(mode);
    const totalLimit = Math.min(options.limit || modeParams.totalLimit, 200);

    const network = await networkStore.load();
    const cues = network.cues || {};

    const getCue = (word) => cues[word];

    const getCueDegree = (cue) => {
      const c = cue?.connections;
      if (!Array.isArray(c)) return 0;
      return c.length;
    };

    const findBestCenter = (words) => {
      let best = null;
      let maxDegree = 0;
      for (const w of words) {
        const cue = getCue(w);
        if (!cue) continue;
        const degree = getCueDegree(cue);
        if (degree > maxDegree) {
          best = w;
          maxDegree = degree;
        }
      }
      return best;
    };

    const selectHubNodes = (count = 15) => {
      return Object.entries(cues)
        .map(([word, cue]) => ({ word, degree: getCueDegree(cue) }))
        .filter((x) => x.degree > 0)
        .sort((a, b) => b.degree - a.degree)
        .slice(0, count)
        .map((x) => x.word);
    };

    let centerWords;
    if (query === null || query === undefined || query === 'null') {
      centerWords = selectHubNodes(15);
    } else if (Array.isArray(query)) {
      centerWords = query;
    } else {
      const words = tokenize(query).filter((w) => w.length > 0).slice(0, 10);
      const center = findBestCenter(words);
      if (!center) return [];
      centerWords = [center];
    }

    const validCenters = centerWords.filter((w) => !!getCue(w));
    if (validCenters.length === 0) return [];

    const initialEnergy = validCenters.length > 5 ? 1.0 : 1.0 / validCenters.length;
    const energyPool = new Map();
    const activatedNodes = new Set();
    const depths = new Map();

    for (const w of validCenters) {
      energyPool.set(w, initialEnergy);
      activatedNodes.add(w);
      depths.set(w, 1);
    }

    const getOutgoingEdges = (word) => {
      const cue = getCue(word);
      const edges = Array.isArray(cue?.connections) ? cue.connections : [];
      return edges.map((e) => ({
        targetWord: e.target,
        weight: typeof e.weight === 'number' ? e.weight : 0,
        frequency: getCue(e.target)?.recallFrequency || 0,
      }));
    };

    const shouldContinue = (pool, cycle) => {
      if (cycle >= modeParams.maxCycles) return false;
      for (const e of pool.values()) {
        if (e >= modeParams.firingThreshold) return true;
      }
      return false;
    };

    let cycle = 0;
    while (shouldContinue(energyPool, cycle)) {
      if (activatedNodes.size >= modeParams.maxActivations) break;

      const newActivations = new Map();
      for (const [word, energy] of energyPool.entries()) {
        if (energy < modeParams.firingThreshold) continue;

        const edges = getOutgoingEdges(word);
        const degree = edges.length;
        if (degree === 0) continue;

        const sampleSize = Math.min(8, Math.max(3, Math.ceil(Math.log2(degree + 1))));
        const sampled = edges.sort((a, b) => b.weight - a.weight).slice(0, sampleSize);

        const hubComp = 1 + Math.log(1 + degree) * 0.3;
        const availableEnergy = energy * hubComp;
        const energyPerEdge = (availableEnergy * modeParams.synapticDecay) / Math.max(1, sampled.length);

        for (const edge of sampled) {
          if (activatedNodes.has(edge.targetWord)) continue;

          const freqBonus = 1 + Math.log(1 + (edge.frequency || 0)) * modeParams.frequencyBoost;
          const transmittedEnergy = energyPerEdge * freqBonus;
          const inhibition = 1 - (modeParams.inhibitionFactor * activatedNodes.size) / 200;
          const finalEnergy = transmittedEnergy * Math.max(0.5, inhibition);

          if (finalEnergy < modeParams.firingThreshold) continue;

          newActivations.set(edge.targetWord, (newActivations.get(edge.targetWord) || 0) + finalEnergy);
        }
      }

      energyPool.clear();
      for (const [w, e] of newActivations.entries()) {
        const decayed = e * modeParams.cycleDecay;
        if (decayed < 0.01) continue;
        energyPool.set(w, decayed);
      }

      for (const [w, e] of energyPool.entries()) {
        if (e >= modeParams.firingThreshold && !activatedNodes.has(w)) {
          activatedNodes.add(w);
          depths.set(w, cycle + 2);
          if (activatedNodes.size >= modeParams.maxActivations) break;
        }
      }

      cycle++;
      if (newActivations.size === 0) break;
    }

    // 注意：不再在 recall 路径上自动保存 network 的 recallFrequency。
    // 原写法每次 read 都会 read-modify-write network.json，并发下后写者覆盖前者。
    // 频率递增改为由调用方显式调用 incrementRecallFrequency（只在确实使用结果时）。
    for (const w of activatedNodes) {
      if (!cues[w]) cues[w] = { word: w, connections: [], recallFrequency: 0 };
      // 只在内存里递增；不写盘
      cues[w].recallFrequency = (cues[w].recallFrequency || 0) + 1;
    }
    // 不再调用 networkStore.save(network)

    const getByWordStmt = db.prepare(`
      SELECT DISTINCT e.* FROM engrams e
      JOIN cue_index c ON e.id = c.engram_id
      WHERE c.word = ?
    `);

    const engramSet = new Set();
    const coarseEngrams = [];
    for (const w of activatedNodes) {
      const rows = getByWordStmt.all(w);
      for (const row of rows) {
        const e = rowToEngram(row);
        if (engramSet.has(e.id)) continue;
        engramSet.add(e.id);
        coarseEngrams.push({ ...e, activatedBy: w });
      }
    }

    if (coarseEngrams.length === 0) return [];

    const queryWordsLower = tokenize(query).map((w) => w.toLowerCase()).filter(Boolean);
    return fineRankEngrams(coarseEngrams, {
      queryWordsLower,
      depths,
      totalLimit,
    });
  } catch (err) {
    log.error({ err: err.message, roleId }, 'recall failed');
    return [];
  } finally {
    db.close();
  }
}

export async function rememberFromResult(roleId, task, result) {
  if (!roleId || !result) return;

  const taskWords = (task || '').split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
  const resultWords = result.split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
  const schema = [...new Set([...taskWords, ...resultWords])];

  await remember(roleId, `Task: ${task}\nResult: ${result.slice(0, 200)}`, {
    type: 'PATTERN',
    strength: 0.6,
    schema,
  });
}

/**
 * 显式递增被激活 cue 的 recallFrequency。
 * 推荐在 recall() 返回结果确实被消费（例如喂给 LLM）时调用，
 * 而不是在每次读操作时自动写盘。
 */
export async function bumpRecallFrequency(roleId, words) {
  if (!roleId || !words?.length) return;
  try {
    const networkStore = getNetwork(roleId);
    await networkStore.incrementRecallFrequency(words);
  } catch (err) {
    // 频率递增失败不应影响主流程
    log.warn({ err: err.message, roleId, wordCount: words.length }, 'bumpRecallFrequency failed');
  }
}

/**
 * 删除一条记忆（按 id）
 *
 * @param {string} roleId
 * @param {string} engramId
 * @returns {Promise<{deleted: boolean, engramId: string}>}
 */
export async function forget(roleId, engramId) {
  if (!roleId || !engramId) {
    return { deleted: false, engramId, reason: 'roleId and engramId are required' };
  }

  const db = getDb(roleId);
  try {
    const result = db.prepare(`DELETE FROM engrams WHERE id = ?`).run(engramId);
    db.prepare(`DELETE FROM cue_index WHERE engram_id = ?`).run(engramId);
    return {
      deleted: result.changes > 0,
      engramId,
      changes: result.changes,
    };
  } catch (err) {
    log.error({ err: err.message, roleId, engramId }, 'forget failed');
    return { deleted: false, engramId, reason: err.message };
  } finally {
    db.close();
  }
}

/**
 * 获取角色的记忆统计
 */
export async function getMemoryStats(roleId) {
  if (!roleId) return null;

  const db = getDb(roleId);
  try {
    const total = db.prepare(`SELECT COUNT(*) AS c FROM engrams`).get()?.c ?? 0;
    const byType = db.prepare(
      `SELECT type, COUNT(*) AS c FROM engrams GROUP BY type`
    ).all();
    const byStrength = db.prepare(
      `SELECT
         SUM(CASE WHEN strength >= 0.8 THEN 1 ELSE 0 END) AS strong,
         SUM(CASE WHEN strength >= 0.5 AND strength < 0.8 THEN 1 ELSE 0 END) AS medium,
         SUM(CASE WHEN strength < 0.5 THEN 1 ELSE 0 END) AS weak
       FROM engrams`
    ).get();
    // dbstat 是 SQLite 扩展（编译期开关），可能不可用；用文件大小兜底
    let dbSize = 0;
    try {
      dbSize = db.prepare(`SELECT page_count * page_size AS bytes FROM dbstat`).get()?.bytes ?? 0;
    } catch {
      // 兜底：读实际文件大小
      try {
        const { statSync } = await import('fs');
        const { getCognitionDir } = await import('../data-paths.js');
        const dbFile = join(getCognitionDir(), roleId, 'engrams.db');
        if (existsSync(dbFile)) dbSize = statSync(dbFile).size;
      } catch { /* ignore */ }
    }

    return {
      roleId,
      total,
      byType: Object.fromEntries(byType.map((r) => [r.type, r.c])),
      byStrength,
      dbSizeBytes: dbSize,
    };
  } catch (err) {
    log.error({ err: err.message, roleId }, 'getMemoryStats failed');
    return null;
  } finally {
    db.close();
  }
}

/**
 * 列出角色的所有 engram（按 timestamp 倒序）
 *
 * @param {string} roleId
 * @param {object} options
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @param {string} [options.type]  过滤 type (ATOMIC / PATTERN)
 */
export async function listEngrams(roleId, options = {}) {
  if (!roleId) return [];

  const limit = Math.min(options.limit ?? 50, 500);
  const offset = options.offset ?? 0;
  const type = options.type || null;

  const db = getDb(roleId);
  try {
    let rows;
    if (type) {
      rows = db.prepare(
        `SELECT id, content, type, timestamp, strength FROM engrams
         WHERE type = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      ).all(type, limit, offset);
    } else {
      rows = db.prepare(
        `SELECT id, content, type, timestamp, strength FROM engrams
         ORDER BY timestamp DESC LIMIT ? OFFSET ?`
      ).all(limit, offset);
    }
    return rows.map((r) => ({
      id: r.id,
      content: typeof r.content === 'string' ? r.content.slice(0, 200) : '',
      type: r.type,
      timestamp: r.timestamp,
      strength: r.strength,
    }));
  } catch (err) {
    log.error({ err: err.message, roleId }, 'listEngrams failed');
    return [];
  } finally {
    db.close();
  }
}

/**
 * 按 id 获取单条记忆（详情）
 */
export async function getEngram(roleId, engramId) {
  if (!roleId || !engramId) return null;

  const db = getDb(roleId);
  try {
    const row = db.prepare(`SELECT * FROM engrams WHERE id = ?`).get(engramId);
    if (!row) return null;

    const schema = (() => {
      try { return JSON.parse(row.schema || '[]'); } catch { return []; }
    })();
    const metadata = (() => {
      try { return row.metadata ? JSON.parse(row.metadata) : null; } catch { return null; }
    })();

    return {
      id: row.id,
      content: row.content,
      schema,
      type: row.type,
      timestamp: row.timestamp,
      strength: row.strength,
      metadata,
    };
  } catch (err) {
    log.error({ err: err.message, roleId, engramId }, 'getEngram failed');
    return null;
  } finally {
    db.close();
  }
}
