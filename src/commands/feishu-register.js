import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ErrorCode, PersengError } from '../errors.js';
import { getConfig, saveConfig } from '../config.js';

function parseJsonLike(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'object') return value;
    const text = String(value).trim();
    if (!text) return null;
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        return JSON.parse(text);
    }
    const filePath = resolve(process.cwd(), text);
    if (existsSync(filePath)) {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
    return JSON.parse(text);
}

async function loadLarkSdk(injected) {
    if (injected) return injected;
    const mod = await import('@larksuiteoapi/node-sdk');
    return mod.default || mod;
}

function output(payload, options) {
    if (options.json) {
        process.stdout.write(JSON.stringify(payload) + '\n');
        return;
    }

    const lines = [
        '',
        '已获取飞书应用凭据：',
        `FEISHU_APP_ID=${payload.appId}`,
        `FEISHU_APP_SECRET=${payload.appSecret}`,
    ];
    if (payload.userInfo?.open_id) {
        lines.push(`扫码用户 open_id: ${payload.userInfo.open_id}`);
    }
    if (payload.userInfo?.tenant_brand) {
        lines.push(`租户类型: ${payload.userInfo.tenant_brand}`);
    }
    if (payload.savedToConfig) {
        lines.push('已写入本机配置文件 (~/.perseng-cli/config.json)。');
    }
    lines.push('', '下一步：', '  perseng feishu --app-id $FEISHU_APP_ID --app-secret $FEISHU_APP_SECRET');
    process.stdout.write(lines.join('\n') + '\n');
}

export async function feishuRegisterCommand(options = {}, deps = {}) {
    const config = deps.getConfig ? deps.getConfig() : getConfig();
    const lark = await loadLarkSdk(options.lark || deps.lark);

    const source = options.source || 'perseng-cli';
    const appPreset = {
        avatar: options.appAvatar ? String(options.appAvatar).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        name: options.appName || undefined,
        desc: options.appDesc || undefined,
    };
    const cleanedPreset = Object.fromEntries(Object.entries(appPreset).filter(([, v]) => v !== undefined));

    let addons = null;
    try {
        addons = parseJsonLike(options.addons);
    } catch (err) {
        throw new PersengError({
            code: ErrorCode.CONFIG_MISSING,
            message: `Invalid addons: ${err.message}`,
            userMessage: `addons 解析失败：${err.message}`,
        });
    }

    const abortCtl = new AbortController();
    const cleanup = () => {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
    };
    const onSigint = () => abortCtl.abort('SIGINT');
    const onSigterm = () => abortCtl.abort('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    try {
        const result = await lark.registerApp({
            source,
            signal: abortCtl.signal,
            createOnly: options.createOnly || false,
            appId: options.targetAppId || options.appId || undefined,
            addons: addons || undefined,
            appPreset: Object.keys(cleanedPreset).length > 0 ? cleanedPreset : undefined,
            onQRCodeReady(info) {
                if (options.json) {
                    process.stdout.write(JSON.stringify({ type: 'qrcode', ...info }) + '\n');
                    return;
                }
                process.stdout.write(`请在飞书/Lark 打开并确认：${info.url}\n`);
                process.stdout.write(`链接将在 ${info.expireIn} 秒后过期\n`);
            },
            onStatusChange(info) {
                if (options.quiet) return;
                if (options.json) {
                    process.stdout.write(JSON.stringify({ type: 'status', ...info }) + '\n');
                    return;
                }
                process.stderr.write(`[feishu-register] status=${info.status}${info.interval ? ` interval=${info.interval}` : ''}\n`);
            },
        });

        const appId = result?.client_id || '';
        const appSecret = result?.client_secret || '';

        if (!appId || !appSecret) {
            throw new PersengError({
                code: ErrorCode.INTERNAL,
                message: 'registerApp returned empty credentials',
                userMessage: '飞书返回的凭据为空，请重试或检查扫码授权是否完成。',
            });
        }

        let savedToConfig = false;
        if (options.saveConfig) {
            const save = deps.saveConfig || saveConfig;
            save({ feishuAppId: appId, feishuAppSecret: appSecret });
            savedToConfig = true;
        }

        output({
            appId,
            appSecret,
            userInfo: result?.user_info || null,
            savedToConfig,
            configDataDir: config.dataDir,
        }, options);
    } catch (err) {
        if (err?.code && err?.description) {
            throw new PersengError({
                code: ErrorCode.INTERNAL,
                message: `feishu registerApp error: ${err.code} ${err.description}`,
                userMessage: `飞书授权失败：${err.code}（${err.description}）`,
                context: { code: err.code, description: err.description },
            });
        }
        if (err instanceof PersengError) throw err;
        throw new PersengError({
            code: ErrorCode.INTERNAL,
            message: err?.message || String(err),
            userMessage: err?.message || '飞书授权失败',
            cause: err instanceof Error ? err : undefined,
        });
    } finally {
        cleanup();
    }
}
