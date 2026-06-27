import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

function createTempDir() {
    return mkdtempSync(join(tmpdir(), 'perseng-feishu-register-'));
}

async function loadCommandModule() {
    const url = pathToFileURL(join(process.cwd(), 'src/commands/feishu-register.js')).href;
    return import(`${url}?t=${Date.now()}-${Math.random()}`);
}

test('feishuRegisterCommand prints QR link and saves config when requested', async (t) => {
    const tempDir = createTempDir();
    const previousDataDir = process.env.PERSENG_CLI_DATA_DIR;

    t.after(() => {
        if (previousDataDir === undefined) {
            delete process.env.PERSENG_CLI_DATA_DIR;
        } else {
            process.env.PERSENG_CLI_DATA_DIR = previousDataDir;
        }
        rmSync(tempDir, { recursive: true, force: true });
    });

    process.env.PERSENG_CLI_DATA_DIR = tempDir;

    const printed = [];
    const stderr = [];
    const originalStdout = process.stdout.write;
    const originalStderr = process.stderr.write;
    process.stdout.write = (chunk) => {
        printed.push(String(chunk));
        return true;
    };
    process.stderr.write = (chunk) => {
        stderr.push(String(chunk));
        return true;
    };

    t.after(() => {
        process.stdout.write = originalStdout;
        process.stderr.write = originalStderr;
    });

    const mockLark = {
        async registerApp(params) {
            params.onQRCodeReady?.({ url: 'https://example.com/qrcode', expireIn: 60 });
            params.onStatusChange?.({ status: 'polling', interval: 5 });
            return {
                client_id: 'cli_test_app',
                client_secret: 'secret_test_app',
                user_info: { open_id: 'ou_test', tenant_brand: 'feishu' },
            };
        },
    };

    const { feishuRegisterCommand } = await loadCommandModule();
    await feishuRegisterCommand({
        lark: mockLark,
        saveConfig: true,
        quiet: true,
    });

    const outputText = printed.join('');
    assert.match(outputText, /https:\/\/example\.com\/qrcode/);
    assert.match(outputText, /FEISHU_APP_ID=cli_test_app/);
    assert.match(outputText, /FEISHU_APP_SECRET=secret_test_app/);

    const configPath = join(tempDir, 'config.json');
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.equal(saved.feishuAppId, 'cli_test_app');
    assert.equal(saved.feishuAppSecret, 'secret_test_app');
    assert.equal(stderr.length, 0);
});

test('feishuRegisterCommand supports json output', async () => {
    const printed = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = (chunk) => {
        printed.push(String(chunk));
        return true;
    };
    try {
        const mockLark = {
            async registerApp(params) {
                params.onQRCodeReady?.({ url: 'https://example.com/qrcode', expireIn: 60 });
                return { client_id: 'cli_json_app', client_secret: 'secret_json_app' };
            },
        };

        const { feishuRegisterCommand } = await loadCommandModule();
        await feishuRegisterCommand({
            lark: mockLark,
            json: true,
            quiet: true,
        });
    } finally {
        process.stdout.write = originalStdout;
    }

    const lines = printed.join('').split(/\r?\n/).filter(Boolean);
    assert.ok(lines.some((line) => JSON.parse(line).type === 'qrcode'));
    const payload = JSON.parse(lines[lines.length - 1]);
    assert.equal(payload.appId, 'cli_json_app');
    assert.equal(payload.appSecret, 'secret_json_app');
});

