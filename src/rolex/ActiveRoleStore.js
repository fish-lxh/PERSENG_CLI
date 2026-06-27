import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { getRolexDir } from '../data-paths.js';

function getStoreFilePath() {
  const dir = getRolexDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, 'active.json');
}

export function readActiveRoleId() {
  const filePath = getStoreFilePath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return typeof data?.roleId === 'string' && data.roleId.length > 0 ? data.roleId : null;
  } catch {
    return null;
  }
}

export function writeActiveRoleId(roleId) {
  if (!roleId || typeof roleId !== 'string') return;
  const filePath = getStoreFilePath();
  // 原子写入：temp + rename（防并发/崩溃中途损坏）
  const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(
    tmp,
    JSON.stringify({ roleId, updatedAt: new Date().toISOString() }, null, 2),
    'utf-8'
  );
  renameSync(tmp, filePath);
}
