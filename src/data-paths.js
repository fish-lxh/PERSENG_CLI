/**
 * 数据目录统一管理 (P1.6)
 *
 * 之前数据散落在项目根目录的 .promptx-memory/ 下，会随 git 仓库被无意提交。
 * 现在统一放到用户主目录 ~/.perseng-cli/ 下：
 *   ~/.perseng-cli/cognition/<roleId>/   engrams.db, network.json
 *   ~/.perseng-cli/rolex/                 active.json, lifecycle-state.json
 *
 * 启动时如果检测到旧目录（项目根 .promptx-memory/ 或环境变量指定路径）有数据，
 * 一次性迁移到新位置（move 而非 copy，迁移完删除旧的）。
 *
 * 可通过环境变量覆盖：
 *   PERSENG_CLI_COGNITION_DIR  指定 cognition 目录
 *   PERSENG_CLI_ROLEX_DIR      指定 rolex 目录
 */

import { homedir, tmpdir } from 'os';
import { join, resolve, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'fs';
import { childLogger } from './logger.js';
import { getConfig } from './config.js';

const log = childLogger('data-paths');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

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

// 默认全部放主目录下
function getDefaultCognitionDir() {
  return join(getConfig().dataDir || getDefaultBaseDir(), 'cognition');
}

function getDefaultRolexDir() {
  return join(getConfig().dataDir || getDefaultBaseDir(), 'rolex');
}

function getDefaultBlackboardDir() {
  return join(getConfig().dataDir || getDefaultBaseDir(), 'blackboard');
}

export const DEFAULT_COGNITION_DIR = getDefaultCognitionDir();
export const DEFAULT_ROLEX_DIR = getDefaultRolexDir();
export const DEFAULT_BLACKBOARD_DIR = getDefaultBlackboardDir();

// 旧路径（仅用于一次性迁移）
const LEGACY_PROJECT_COGNITION_DIR = join(PROJECT_ROOT, '.promptx-memory', 'cognition');
const LEGACY_PROJECT_ROLEX_DIR = join(PROJECT_ROOT, '.promptx-memory', 'rolex');

let _cognitionDir = null;
let _rolexDir = null;
let _blackboardDir = null;

/**
 * 获取 cognition 数据目录（自动迁移一次）
 *
 * 注意：仅当 PERSENG_CLI_COGNITION_DIR 环境变量被显式设置时，
 * 相对路径才基于项目根目录解析。
 * 这样服务器无论从哪个目录启动，路径都一致。
 */
export function getCognitionDir() {
  if (_cognitionDir) return _cognitionDir;
  let dir = getDefaultCognitionDir();
  // 仅对显式设置的环境变量做项目根解析（避免 DEFAULT_* 的相对路径被错误处理）
  const envOverride = getConfig().cognitionDir;
  if (envOverride) {
    dir = isAbsolute(envOverride) ? envOverride : join(getProjectRoot(), envOverride);
  }
  _cognitionDir = dir;
  ensureMigrated(_cognitionDir, LEGACY_PROJECT_COGNITION_DIR, 'cognition');
  return _cognitionDir;
}

/**
 * 获取 rolex 数据目录（自动迁移一次）
 * 仅对显式设置的环境变量做项目根解析。
 */
export function getRolexDir() {
  if (_rolexDir) return _rolexDir;
  let dir = getDefaultRolexDir();
  const envOverride = getConfig().rolexDir;
  if (envOverride) {
    dir = isAbsolute(envOverride) ? envOverride : join(getProjectRoot(), envOverride);
  }
  _rolexDir = dir;
  ensureMigrated(_rolexDir, LEGACY_PROJECT_ROLEX_DIR, 'rolex');
  return _rolexDir;
}

/**
 * 获取 blackboard 数据目录（Phase 5：跨 agent 通信）
 * 仅对显式设置的环境变量做项目根解析。
 * 默认 ~/.perseng-cli/blackboard/blackboard.db
 */
export function getBlackboardDir() {
  if (_blackboardDir) return _blackboardDir;
  let dir = getDefaultBlackboardDir();
  const envOverride = getConfig().blackboardDir;
  if (envOverride) {
    dir = isAbsolute(envOverride) ? envOverride : join(getProjectRoot(), envOverride);
  }
  _blackboardDir = dir;
  if (!existsSync(_blackboardDir)) mkdirSync(_blackboardDir, { recursive: true });
  return _blackboardDir;
}

let _migratedSet = new Set();

/**
 * 检测 legacy 目录是否有数据，若有则迁移到 newDir。
 * 迁移完成后只在新目录写入。
 */
function ensureMigrated(newDir, legacyDir, label) {
  if (_migratedSet.has(label)) return;
  _migratedSet.add(label);

  if (newDir === legacyDir) return; // 用户显式指了 legacy 路径
  if (!existsSync(legacyDir)) return;
  if (existsSync(newDir)) {
    // 新目录已有内容，不自动迁移（避免覆盖）
    return;
  }

  try {
    mkdirSync(dirname(newDir), { recursive: true });
    // 用 renameSync 一次性 move（旧数据可能跨子目录）
    // 如果跨设备，renameSync 会抛 EXDEV，回退到递归拷贝
    try {
      renameSync(legacyDir, newDir);
      log.warn({ label, from: legacyDir, to: newDir }, 'migrated legacy data');
      return;
    } catch (err) {
      if (err?.code !== 'EXDEV') throw err;
    }
    mkdirSync(newDir, { recursive: true });
    copyDirRecursive(legacyDir, newDir);
    rmDirRecursive(legacyDir);
    log.warn({ label, from: legacyDir, to: newDir }, 'migrated legacy data (recursive copy)');
  } catch (err) {
    log.error({ label, err: err.message }, 'migration failed');
    // 失败不阻塞启动，旧路径仍可用
  }
}

function copyDirRecursive(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    const stat = statSync(s);
    if (stat.isDirectory()) copyDirRecursive(s, d);
    else { copyFileSync(s, d); unlinkSync(s); }
  }
}

function rmDirRecursive(dir) {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const p = join(dir, entry);
      const stat = statSync(p);
      if (stat.isDirectory()) {
        rmDirRecursive(p);
      } else {
        try { renameSync(p, join(dir, '..', `.${entry}.deleted`)); } catch { /* ignore */ }
      }
    }
    // 留个空目录让用户手动删，避免误删源码
    try { mkdirSync(join(dir, '.migrated-to-' + basename(newDirForOld(dir))), { recursive: true }); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function basename(p) {
  return p.split(/[\\/]/).pop();
}

function newDirForOld(oldDir) {
  if (oldDir.includes('cognition')) return '~/.perseng-cli/cognition';
  if (oldDir.includes('rolex')) return '~/.perseng-cli/rolex';
  return 'home';
}

/**
 * 重置缓存（用于测试）
 */
export function resetDataPaths() {
  _cognitionDir = null;
  _rolexDir = null;
  _blackboardDir = null;
  _migratedSet = new Set();
}
