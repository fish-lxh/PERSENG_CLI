/**
 * Custom Tools — 鲁班的工具脚本管理
 *
 * 让鲁班（tool-creator）能直接创建、加载、执行自定义工具脚本，无需子代理。
 *
 * 工作流：
 *   1. 鲁班调用 tool://tool-creator.create_script 传 uri + name + code
 *   2. create_script 写脚本到 <toolxDir>/custom/<name>.js
 *   3. 写元数据到 ~/.perseng-cli/custom-tools.json（持久化注册表）
 *   4. 立即 dynamic import + 注册到 _customTools（本次进程内立即可用）
 *   5. 下次 ToolXProtocol 启动时，_loadCustomTools() 自动恢复
 *
 * 脚本约定：
 *   - 默认导出必须是 async (action, params) => result
 *   - 或 default export { execute, manual, config, dependencies }
 *   - 错误以 throw 抛出，调用方会捕获并包装为 { ok: false, error }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { fileURLToPath as fileURLToPathFn } from 'url';
import { isMainThread, threadId } from 'worker_threads';
import { getConfig } from '../config.js';

const __filename = fileURLToPathFn(import.meta.url);
const __dirname = dirname(__filename);

function getDefaultBaseDir() {
  const canUseDir = (dir) => {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(
        dir,
        `.probe.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
      );
      writeFileSync(probe, '1', 'utf-8');
      unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  };

  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'perseng-cli'));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'perseng-cli'));
  }
  candidates.push(join(homedir(), '.perseng-cli'));
  candidates.push(join(process.cwd(), '.perseng-cli'));
  candidates.push(join(tmpdir(), 'perseng-cli'));

  for (const dir of candidates) {
    if (canUseDir(dir)) return dir;
  }

  return candidates[candidates.length - 1];
}

// ──── 路径常量 ────

/** 工具脚本目录（与 ToolXProtocol.js 同级） */
export function getCustomDir() {
  return join(__dirname, 'custom');
}

/** 持久化注册表路径 */
export function getRegistryPath() {
  const envDir = getConfig().dataDir;
  if (envDir) {
    try {
      mkdirSync(envDir, { recursive: true });
      const baseDir = isMainThread ? envDir : join(envDir, `worker-${threadId}`);
      mkdirSync(baseDir, { recursive: true });
      return join(baseDir, 'custom-tools.json');
    } catch {
      return join(getDefaultBaseDir(), 'custom-tools.json');
    }
  }
  const baseDir = getDefaultBaseDir();
  const scopedDir = isMainThread ? baseDir : join(baseDir, `worker-${threadId}`);
  mkdirSync(scopedDir, { recursive: true });
  return join(scopedDir, 'custom-tools.json');
}

// ──── 注册表读写 ────

/**
 * 读取自定义工具注册表
 * @returns {Array<{uri, name, description, scriptFile, actions, createdAt}>}
 */
export function readRegistry() {
  const path = getRegistryPath();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * 写注册表（原子写：先写 .tmp 再 rename）
 */
export function writeRegistry(entries) {
  const path = getRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(entries, null, 2);
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, json, 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      writeFileSync(path, json, 'utf-8');
    } catch {
      throw err;
    } finally {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { }
    }
  }
}

/**
 * 在注册表中添加/更新一项
 */
export function upsertRegistry(entry) {
  const entries = readRegistry();
  const idx = entries.findIndex((e) => e.uri === entry.uri);
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...entry };
  } else {
    entries.push(entry);
  }
  writeRegistry(entries);
  return entries;
}

/**
 * 从注册表移除一项（同时删除脚本文件）
 */
export function removeFromRegistry(uri) {
  const entries = readRegistry();
  const filtered = entries.filter((e) => e.uri !== uri);
  writeRegistry(filtered);
  return filtered;
}

// ──── 脚本加载 ────

/**
 * 加载一个脚本文件并返回模块
 * 用 dynamic import + file:// URL（Windows 兼容）
 */
export async function loadScript(scriptPath) {
  if (!existsSync(scriptPath)) {
    throw new Error(`脚本文件不存在: ${scriptPath}`);
  }
  const fileUrl = pathToFileURL(scriptPath).href;
  // 加时间戳避免 import 缓存
  const cachedUrl = `${fileUrl}?t=${Date.now()}-${randomBytes(4).toString('hex')}`;
  return await import(cachedUrl);
}

/**
 * 从默认导出中提取 execute / manual / config
 * @returns {{ execute: Function, manual?: string, config?: object, actions?: Array }}
 */
export function normalizeScriptModule(mod) {
  const exp = mod.default;
  if (!exp) {
    throw new Error('脚本必须 default export 一个 execute 函数或对象');
  }

  if (typeof exp === 'function') {
    return { execute: exp };
  }

  if (typeof exp === 'object') {
    if (typeof exp.execute !== 'function') {
      throw new Error('default export 对象必须包含 execute 函数');
    }
    return {
      execute: exp.execute,
      manual: exp.manual,
      config: exp.config,
      actions: exp.actions,
    };
  }

  throw new Error('default export 必须是函数或对象');
}

// ──── 创建脚本 ────

/**
 * 创建并落盘一个自定义工具脚本
 * @param {object} opts
 * @param {string} opts.uri          - 形如 tool://my-tool
 * @param {string} opts.name         - 简短名称（同时作为文件名）
 * @param {string} opts.description  - 工具描述
 * @param {string} opts.code         - JS 源文件内容（default export）
 * @param {Array}  [opts.actions]    - 操作定义（默认从 code 注释推断或为空）
 * @param {string} [opts.manual]     - 可选 manual 文档
 * @returns {Promise<{ok, uri, scriptFile, lineCount}>}
 */
export async function createCustomToolScript({ uri, name, description, code, actions, manual }) {
  // ── 校验 ──
  if (!uri || !uri.startsWith('tool://')) {
    return { ok: false, error: 'uri 必须以 tool:// 开头' };
  }
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'name 不能为空' };
  }
  if (!description) {
    return { ok: false, error: 'description 不能为空' };
  }
  if (!code || typeof code !== 'string') {
    return { ok: false, error: 'code 不能为空' };
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, error: 'name 不能包含路径分隔符或 ..' };
  }

  // ── 基础语法校验（仅检查 default export 存在） ──
  if (!/export\s+default/.test(code)) {
    return { ok: false, error: 'code 必须包含 `export default`（函数或对象）' };
  }

  // ── 写脚本文件 ──
  const customDir = getCustomDir();
  mkdirSync(customDir, { recursive: true });

  const scriptFile = join(customDir, `${name}.js`);
  const header = `// Auto-generated by tool://tool-creator at ${new Date().toISOString()}\n// URI: ${uri}\n// Description: ${description}\n\n`;
  const fullCode = header + code;

  const tmp = `${scriptFile}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, fullCode, 'utf-8');
  renameSync(tmp, scriptFile);

  // ── 校验脚本能正确导入 ──
  let mod;
  try {
    mod = await loadScript(scriptFile);
  } catch (err) {
    // 回滚：删除脚本
    try { renameSync(scriptFile, `${scriptFile}.broken.${Date.now()}`); } catch { /* ignore */ }
    return { ok: false, error: `脚本语法/导入错误: ${err.message}` };
  }

  // ── 校验 default export 形状 ──
  let normalized;
  try {
    normalized = normalizeScriptModule(mod);
  } catch (err) {
    try { renameSync(scriptFile, `${scriptFile}.broken.${Date.now()}`); } catch { /* ignore */ }
    return { ok: false, error: err.message };
  }

  // ── 写注册表 ──
  const entry = {
    uri,
    name,
    description,
    scriptFile,
    actions: actions || normalized.actions || [],
    manual: manual || normalized.manual || null,
    createdAt: new Date().toISOString(),
  };
  upsertRegistry(entry);

  return {
    ok: true,
    uri,
    scriptFile,
    lineCount: code.split('\n').length,
    actions: entry.actions,
  };
}

/**
 * 启动时一次性加载所有已注册的自定义工具
 * @returns {Promise<Map<string, {uri, name, description, execute, manual, config, actions, scriptFile}>>}
 */
export async function loadAllCustomTools() {
  const out = new Map();
  const entries = readRegistry();
  for (const entry of entries) {
    try {
      const mod = await loadScript(entry.scriptFile);
      const normalized = normalizeScriptModule(mod);
      out.set(entry.uri, {
        uri: entry.uri,
        name: entry.name,
        description: entry.description,
        execute: normalized.execute,
        manual: normalized.manual || entry.manual || `## ${entry.uri}\n\n${entry.description}`,
        config: normalized.config || {},
        actions: entry.actions || normalized.actions || [],
        scriptFile: entry.scriptFile,
      });
    } catch (err) {
      // 跳过坏脚本，不让一个坏脚本阻止其它加载
      // eslint-disable-next-line no-console
      console.warn(`[custom-tools] 加载 ${entry.uri} 失败: ${err.message}`);
    }
  }
  return out;
}

/**
 * 列出所有自定义工具（不执行）
 */
export function listCustomTools() {
  return readRegistry();
}

/**
 * 删除一个自定义工具（同时移除脚本文件和注册表项）
 */
export function deleteCustomTool(uri) {
  const entries = readRegistry();
  const entry = entries.find((e) => e.uri === uri);
  if (!entry) return { ok: false, error: `工具 ${uri} 未注册` };
  // 不直接删脚本，移到 .deleted 防止误删后无法恢复
  if (existsSync(entry.scriptFile)) {
    try {
      renameSync(entry.scriptFile, `${entry.scriptFile}.deleted.${Date.now()}`);
    } catch {
      /* ignore */
    }
  }
  removeFromRegistry(uri);
  return { ok: true, uri };
}
