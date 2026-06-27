import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

function createTempDir() {
    return mkdtempSync(join(tmpdir(), 'perseng-serve-'));
}

test('serve emits NDJSON events for ping and task flows', async (t) => {
    const tempDir = createTempDir();
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));
    const drive = tempDir.slice(0, 2);
    const homePath = tempDir.slice(2);

    const bootstrap = `
    import { TaskEngine } from './src/task-engine.js';

    TaskEngine.prototype.getLlmClient = async function getMockClient() {
      return {
        async streamMessages({ onText }) {
          onText?.('mock streamed reply');
          return { text: 'mock streamed reply', toolCalls: [] };
        },
      };
    };

    const { serveCommand } = await import('./src/commands/serve.js');
    serveCommand({ role: 'jiangziya' }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

    const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            HOME: tempDir,
            USERPROFILE: tempDir,
            HOMEDRIVE: drive,
            HOMEPATH: homePath,
            OPENAI_API_KEY: 'test-key',
            PERSENG_CLI_COGNITION_DIR: join(tempDir, 'cognition'),
            PERSENG_CLI_ROLEX_MOCK: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
    });

    child.stdin.write(JSON.stringify({ type: 'ping' }) + '\n');
    child.stdin.write(JSON.stringify({
        type: 'task',
        id: 'task-1',
        prompt: 'say hello',
        context: { requestId: 'req-1' },
    }) + '\n');
    child.stdin.end();

    const exitCode = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error(`serve test timed out\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
        }, 5000);

        child.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });

        child.on('close', (code) => {
            clearTimeout(timeout);
            resolve(code);
        });
    });

    assert.equal(exitCode, 0, stderr);

    const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));

    assert.ok(lines.some((line) => line.type === 'status' && line.status === 'ready'));
    assert.ok(lines.some((line) => line.type === 'pong'));
    assert.ok(lines.some((line) => line.type === 'status' && line.status === 'task_received'));
    assert.ok(lines.some((line) => line.type === 'status' && line.status === 'processing'));
    assert.ok(lines.some((line) => line.type === 'text' && line.content === 'mock streamed reply'));
    assert.ok(lines.some((line) => line.type === 'status' && line.status === 'completed'));
});
