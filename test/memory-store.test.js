import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

function createTempRoot() {
    return mkdtempSync(join(tmpdir(), 'perseng-memory-'));
}

async function loadMemoryStore(tempRoot) {
    process.env.PERSENG_CLI_COGNITION_DIR = join(tempRoot, 'cognition');
    const moduleUrl = pathToFileURL(resolve('src/cognition/MemoryStore.js')).href;
    return import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
}

test('MemoryStore remembers and recalls matching content', async (t) => {
    const tempRoot = createTempRoot();
    const previousDir = process.env.PERSENG_CLI_COGNITION_DIR;
    t.after(() => {
        if (previousDir === undefined) {
            delete process.env.PERSENG_CLI_COGNITION_DIR;
        } else {
            process.env.PERSENG_CLI_COGNITION_DIR = previousDir;
        }
        rmSync(tempRoot, { recursive: true, force: true });
    });

    const store = await loadMemoryStore(tempRoot);
    const id = await store.remember('tester', 'alpha beta memory', {
        schema: ['alpha', 'beta'],
    });
    const recalled = await store.recall('tester', 'alpha');

    assert.ok(id);
    assert.ok(recalled.length >= 1);
    assert.ok(recalled.some((item) => item.id === id));
    assert.ok(recalled.some((item) => item.content.includes('alpha beta memory')));
});

test('MemoryStore supports batch inserts and result snapshots', async (t) => {
    const tempRoot = createTempRoot();
    const previousDir = process.env.PERSENG_CLI_COGNITION_DIR;
    t.after(() => {
        if (previousDir === undefined) {
            delete process.env.PERSENG_CLI_COGNITION_DIR;
        } else {
            process.env.PERSENG_CLI_COGNITION_DIR = previousDir;
        }
        rmSync(tempRoot, { recursive: true, force: true });
    });

    const store = await loadMemoryStore(tempRoot);
    const batchIds = await store.rememberBatch('tester', [
        { content: 'gamma delta memory', schema: ['gamma', 'delta'] },
        { content: 'epsilon zeta memory', schema: ['epsilon', 'zeta'] },
    ]);

    await store.rememberFromResult('tester', 'investigate issue', 'produce concise summary');
    const recalled = await store.recall('tester', 'gamma');
    const snapshots = await store.recall('tester', 'investigate');

    assert.equal(batchIds.length, 2);
    assert.ok(recalled.some((item) => item.content.includes('gamma delta memory')));
    assert.ok(snapshots.some((item) => item.content.includes('Task: investigate issue')));
});

// ─── P2.3: 记忆去重 ──────────────────────────────────────────────

test('MemoryStore dedupes identical content (P2.3)', async (t) => {
    const tempRoot = createTempRoot();
    const previousDir = process.env.PERSENG_CLI_COGNITION_DIR;
    t.after(() => {
        if (previousDir === undefined) delete process.env.PERSENG_CLI_COGNITION_DIR;
        else process.env.PERSENG_CLI_COGNITION_DIR = previousDir;
        rmSync(tempRoot, { recursive: true, force: true });
    });

    const store = await loadMemoryStore(tempRoot);
    const id1 = await store.remember('tester', '重复内容 alpha-beta', { schema: ['alpha', 'beta'] });
    const id2 = await store.remember('tester', '重复内容 alpha-beta', { schema: ['alpha', 'beta'] });
    assert.equal(id1, id2, '应返回相同 id（去重命中）');

    const recalled = await store.recall('tester', 'alpha');
    assert.equal(recalled.length, 1, '应只有 1 条记录');
});

test('MemoryStore keeps distinct content separate', async (t) => {
    const tempRoot = createTempRoot();
    const previousDir = process.env.PERSENG_CLI_COGNITION_DIR;
    t.after(() => {
        if (previousDir === undefined) delete process.env.PERSENG_CLI_COGNITION_DIR;
        else process.env.PERSENG_CLI_COGNITION_DIR = previousDir;
        rmSync(tempRoot, { recursive: true, force: true });
    });

    const store = await loadMemoryStore(tempRoot);
    await store.remember('tester', '内容 A alpha-one', { schema: ['alpha', 'one'] });
    await store.remember('tester', '内容 B beta-two', { schema: ['beta', 'two'] });
    const recalledAlpha = await store.recall('tester', 'alpha one');
    const recalledBeta = await store.recall('tester', 'beta two');
    assert.ok(recalledAlpha.length >= 1, 'alpha 召回应至少 1 条');
    assert.ok(recalledBeta.length >= 1, 'beta 召回应至少 1 条');
});

test('MemoryStore rememberFromResult dedupes', async (t) => {
    const tempRoot = createTempRoot();
    const previousDir = process.env.PERSENG_CLI_COGNITION_DIR;
    t.after(() => {
        if (previousDir === undefined) delete process.env.PERSENG_CLI_COGNITION_DIR;
        else process.env.PERSENG_CLI_COGNITION_DIR = previousDir;
        rmSync(tempRoot, { recursive: true, force: true });
    });

    const store = await loadMemoryStore(tempRoot);
    await store.rememberFromResult('tester', 'task alpha beta', 'result gamma delta');
    await store.rememberFromResult('tester', 'task alpha beta', 'result gamma delta');
    await store.rememberFromResult('tester', 'task alpha beta', 'result gamma delta');
    // recall 用多关键词命中
    const recalled = await store.recall('tester', 'alpha gamma');
    assert.ok(recalled.length >= 1, '应能召回到至少 1 条');
});