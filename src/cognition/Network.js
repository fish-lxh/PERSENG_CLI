/**
 * 联想网络（cue graph）持久化
 *
 * Phase 5.2 迁移：所有 I/O 改用 fs/promises，不再阻塞事件循环。
 *
 * 数据结构：
 *   {
 *     version: '1.0',
 *     timestamp: <number>,
 *     cues: {
 *       [word: string]: {
 *         word: string,
 *         connections: Array<{ target: string, weight: number }>,
 *         recallFrequency: number,
 *         memories?: string[]   // Phase 5.1: 该 cue 关联的 engram id 列表
 *       }
 *     }
 *   }
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
} from 'fs'; // 仅 ensure()/copyFromLegacy() 启动路径仍 sync（一次性）
import {
  access,
  constants as fsConstants,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rename,
} from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { calculateConnectionWeight } from './RecallStrategy.js';

/**
 * 异步读取 JSON；不存在 / 解析失败返回 null
 */
async function readJsonAsync(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 异步原子写入 JSON：写到临时文件再 rename（与 saveConfig 一致）
 */
async function writeJsonAsync(path, value) {
  const dir = join(path, '..');
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tmp, path);
}

export class Network {
  constructor({ roleDir, persengRoleDir }) {
    this.roleDir = roleDir;
    this.persengRoleDir = persengRoleDir;
    this.networkFile = join(roleDir, 'network.json');
  }

  /**
   * 异步确保 network 文件存在 + 迁移 legacy 数据
   */
  async ensure() {
    try {
      await access(this.roleDir, fsConstants.F_OK);
    } catch {
      await mkdir(this.roleDir, { recursive: true });
    }

    try {
      await access(this.networkFile, fsConstants.F_OK);
      return; // 已存在
    } catch {
      // 不存在，尝试从 legacy 复制
    }

    if (this.persengRoleDir) {
      const srcNetwork = join(this.persengRoleDir, 'network.json');
      try {
        await copyFile(srcNetwork, this.networkFile);
        return;
      } catch {
        // legacy 也没数据，落到下面的"创建新文件"分支
      }
    }

    await writeJsonAsync(this.networkFile, {
      version: '1.0',
      timestamp: Date.now(),
      cues: {},
    });
  }

  /**
   * 异步加载 network。文件不存在会自动创建默认结构。
   */
  async load() {
    await this.ensure();
    const network = await readJsonAsync(this.networkFile);
    if (network && typeof network === 'object') return network;

    const fallback = { version: '1.0', timestamp: Date.now(), cues: {} };
    await writeJsonAsync(this.networkFile, fallback);
    return fallback;
  }

  /**
   * 异步原子保存 network
   */
  async save(network) {
    if (!network || typeof network !== 'object') return;
    network.timestamp = Date.now();
    if (!network.cues || typeof network.cues !== 'object') network.cues = {};
    await writeJsonAsync(this.networkFile, network);
  }

  /**
   * 异步递增 recall 频率
   */
  async incrementRecallFrequency(words) {
    if (!words?.length) return;
    const network = await this.load();
    const cues = network.cues || {};

    for (const word of words) {
      if (!cues[word]) cues[word] = { word, connections: [], recallFrequency: 0 };
      cues[word].recallFrequency = (cues[word].recallFrequency || 0) + 1;
    }

    network.cues = cues;
    await this.save(network);
  }

  /**
   * 异步更新 schema 对应的 cue 连接
   * M4.1: 边权重改为"共现频次 + 时间衰减"，让 1-hop 召回能优先走"高共现"边。
   */
  async updateFromSchema(schema, engramId, options = {}) {
    if (!schema?.length || !engramId) return;

    const timestamp = options.timestamp || Date.now();
    const strength = options.strength ?? 0.8;

    const network = await this.load();
    const cues = network.cues || {};

    for (const word of schema) {
      if (!cues[word]) {
        cues[word] = { word, connections: [], recallFrequency: 0, cooccurrence: {} };
      }
      if (!cues[word].memories) cues[word].memories = [];
      if (!cues[word].memories.includes(engramId)) cues[word].memories.push(engramId);
      if (!cues[word].cooccurrence) cues[word].cooccurrence = {};
    }

    for (let i = 0; i < schema.length - 1; i++) {
      const source = schema[i];
      const target = schema[i + 1];
      const sourceCue = cues[source];
      if (!sourceCue) continue;
      if (!Array.isArray(sourceCue.connections)) sourceCue.connections = [];

      // M4.1: 共现频次累加（同一对 schema 词被一起 remember 多少次）
      const cooccurKey = target;
      sourceCue.cooccurrence[cooccurKey] = (sourceCue.cooccurrence[cooccurKey] || 0) + 1;

      const cooccurrence = sourceCue.cooccurrence[cooccurKey];
      const weight = calculateConnectionWeight({
        timestamp,
        position: i,
        strength,
        cooccurrence,
      });
      const existing = sourceCue.connections.find((c) => c.target === target);
      if (existing) {
        existing.weight = weight;
        existing.cooccurrence = cooccurrence; // ← M4.1: 持久化共现频次
        existing.lastSeen = timestamp;
      } else {
        sourceCue.connections.push({ target, weight, cooccurrence, lastSeen: timestamp });
      }
    }

    network.cues = cues;
    await this.save(network);
  }

  /**
   * M4.1: 显式查询 cue 的 1-hop 邻居（按 cooccurrence × timeDecay 排序）
   * 用于 recall 前的预热 / 调试 / metrics。
   *
   * @param {string} word - 起始 cue
   * @param {object} [options]
   * @param {number} [options.limit=10] - 最多返回几个邻居
   * @param {number} [options.minWeight=0.001] - 边权重下限
   * @returns {Promise<Array<{target: string, weight: number, cooccurrence: number}>>}
   */
  async getOneHopNeighbors(word, options = {}) {
    const limit = options.limit ?? 10;
    const minWeight = options.minWeight ?? 0.001;
    const network = await this.load();
    const cue = network.cues?.[word];
    if (!cue?.connections) return [];
    return cue.connections
      .filter((c) => (c.weight || 0) >= minWeight)
      .sort((a, b) => (b.cooccurrence || 0) - (a.cooccurrence || 0))
      .slice(0, limit)
      .map((c) => ({ target: c.target, weight: c.weight, cooccurrence: c.cooccurrence || 0 }));
  }
}