import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { getRolexDir } from '../data-paths.js';

const OPERATION_STAGE_MAP = {
    want: 'goal',
    plan: 'planning',
    todo: 'execution',
    finish: 'execution',
    achieve: 'reflection',
    abandon: 'reflection',
};

function getStoreFilePath() {
    const dir = getRolexDir();
    mkdirSync(dir, { recursive: true });
    return join(dir, 'lifecycle-state.json');
}

function readStore() {
    const filePath = getStoreFilePath();
    if (!existsSync(filePath)) {
        return { roles: {} };
    }

    try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
        return { roles: {} };
    }
}

/**
 * 原子写入：先写 temp 再 rename
 */
function writeStore(store) {
    const filePath = getStoreFilePath();
    const tmp = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmp, filePath);
}

export function getLifecycleStage(roleId) {
    if (!roleId) return null;
    const store = readStore();
    return store.roles?.[roleId] || null;
}

export function recordLifecycleOperation(roleId, operation, metadata = {}) {
    if (!roleId || !operation) return;

    const store = readStore();
    const previous = store.roles?.[roleId] || {};
    const nextStage = OPERATION_STAGE_MAP[operation] || previous.stage || 'idle';

    store.roles[roleId] = {
        ...previous,
        roleId,
        stage: nextStage,
        lastOperation: operation,
        updatedAt: new Date().toISOString(),
        ...metadata,
    };

    writeStore(store);
}
