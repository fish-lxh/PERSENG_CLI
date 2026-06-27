import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { getConfig } from '../config.js';
import { getDoctorVisibleConfigFields } from '../config-catalog.js';
import { getLoadedProjectEnvInfo } from '../../env.js';

/**
 * 主动 ping LLM 端点，验证 key 是否真能用。
 * - OpenAI 兼容：GET {apiBase}/models（不消耗 token，不计费）
 * - Anthropic：发一个 minimal message（成本 ~$0.0001，可接受）
 *
 * 返回 { ok, status, reason }
 *   - ok: true / false
 *   - status: HTTP status code（如果有）
 *   - reason: 失败原因描述（无 key / timeout / 401 / 403 / 5xx / network）
 */
async function pingLlmProvider({ anthropicKey, openaiKey, apiBase, timeoutMs = 5000 }) {
  if (!anthropicKey && !openaiKey) {
    return { ok: false, reason: 'no-key' };
  }

  // 优先用 OpenAI 兼容端点（便宜，0 token）
  if (openaiKey) {
    const base = apiBase || 'https://api.openai.com/v1';
    const url = `${base.replace(/\/+$/, '')}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${openaiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.status === 200) return { ok: true, status: 200 };
      if (resp.status === 401) return { ok: false, status: 401, reason: 'unauthorized (401 — key 无效或已撤销)' };
      if (resp.status === 403) return { ok: false, status: 403, reason: 'forbidden (403 — key 权限不足)' };
      if (resp.status === 429) return { ok: false, status: 429, reason: 'rate-limited (429 — 账户限流)' };
      if (resp.status >= 500) return { ok: false, status: resp.status, reason: `server-error (${resp.status})` };
      return { ok: false, status: resp.status, reason: `unexpected-status (${resp.status})` };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') return { ok: false, reason: `timeout after ${timeoutMs}ms` };
      return { ok: false, reason: `network-error: ${err.message || err}` };
    }
  }

  // Anthropic：用 minimal message（成本极低）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'p' }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (resp.status === 200) return { ok: true, status: 200 };
    if (resp.status === 401) return { ok: false, status: 401, reason: 'unauthorized (401 — key 无效或已撤销)' };
    if (resp.status === 403) return { ok: false, status: 403, reason: 'forbidden (403 — key 权限不足)' };
    if (resp.status === 429) return { ok: false, status: 429, reason: 'rate-limited (429 — 账户限流)' };
    if (resp.status >= 500) return { ok: false, status: resp.status, reason: `server-error (${resp.status})` };
    return { ok: false, status: resp.status, reason: `unexpected-status (${resp.status})` };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') return { ok: false, reason: `timeout after ${timeoutMs}ms` };
    return { ok: false, reason: `network-error: ${err.message || err}` };
  }
}

function outputResult(result, options = {}) {
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (typeof result === 'string') {
    process.stdout.write(result + '\n');
    return;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function maskValue(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}***${s.slice(-2)}(len=${s.length})`;
}

function parseEnvContent(content) {
  const env = {};
  for (const rawLine of String(content || '').split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}

function safeReadFile(path) {
  try {
    if (!existsSync(path)) return { ok: false, reason: 'not_found', content: '' };
    return { ok: true, content: readFileSync(path, 'utf-8') };
  } catch (e) {
    return { ok: false, reason: e?.message || 'read_failed', content: '' };
  }
}

function safeParseJson(content) {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (e) {
    return { ok: false, reason: e?.message || 'json_parse_failed', value: null };
  }
}

function getValueByPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), obj);
}

function hasMeaningfulValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function formatConfigValue(field, value) {
  if (!hasMeaningfulValue(value)) return '(missing)';
  if (field.secret) return maskValue(value);
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value);
}

function readActiveConfigFile(config) {
  const primaryPath = join(config.dataDir, 'config.json');
  const primary = safeReadFile(primaryPath);
  if (primary.ok) {
    const parsed = safeParseJson(primary.content);
    if (parsed.ok) return { path: primaryPath, values: parsed.value || {} };
  }

  const legacyPath = join(homedir(), '.promptx-cli', 'config.json');
  const legacy = safeReadFile(legacyPath);
  if (legacy.ok) {
    const parsed = safeParseJson(legacy.content);
    if (parsed.ok) return { path: legacyPath, values: parsed.value || {} };
  }

  return { path: primaryPath, values: {} };
}

function collectConfigSourceRows(config) {
  const envInfo = getLoadedProjectEnvInfo();
  const configFile = readActiveConfigFile(config);

  return getDoctorVisibleConfigFields().map((field) => {
    const envKey = field.env;
    const envLoadedFromFile = envKey && envInfo.appliedKeys.includes(envKey);
    const envPresentInProcess = envKey && process.env[envKey] !== undefined;
    const configFileValue = getValueByPath(configFile.values, field.key);
    let source = 'default';
    let sourceDetail = field.defaultValue === undefined ? 'built-in' : `default=${formatConfigValue(field, field.defaultValue)}`;

    if (envLoadedFromFile) {
      source = 'env-file';
      sourceDetail = envInfo.path || '.env';
    } else if (envPresentInProcess) {
      source = 'process-env';
      sourceDetail = envKey;
    } else if (hasMeaningfulValue(configFileValue)) {
      source = 'config-file';
      sourceDetail = configFile.path;
    }

    return {
      key: field.key,
      env: envKey,
      description: field.description,
      value: formatConfigValue(field, getValueByPath(config, field.key)),
      source,
      sourceDetail,
    };
  });
}

function runSystemctl(args) {
  try {
    const r = spawnSync('systemctl', args, { encoding: 'utf-8' });
    return {
      ok: r.status === 0,
      status: r.status,
      stdout: (r.stdout || '').trim(),
      stderr: (r.stderr || '').trim(),
    };
  } catch (e) {
    return { ok: false, status: -1, stdout: '', stderr: e?.message || '' };
  }
}

function parseUnitContent(unitContent) {
  const unit = {
    execStart: '',
    workingDirectory: '',
    user: '',
    environmentFiles: [],
    environment: {},
  };

  const envFiles = [];
  const envKvs = [];
  const lines = String(unitContent || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('ExecStart=')) unit.execStart = line.slice('ExecStart='.length).trim();
    if (line.startsWith('WorkingDirectory=')) unit.workingDirectory = line.slice('WorkingDirectory='.length).trim();
    if (line.startsWith('User=')) unit.user = line.slice('User='.length).trim();
    if (line.startsWith('EnvironmentFile=')) envFiles.push(line.slice('EnvironmentFile='.length).trim());
    if (line.startsWith('Environment=')) envKvs.push(line.slice('Environment='.length).trim());
  }

  for (const ef of envFiles) {
    const s = ef.trim();
    if (!s) continue;
    const optional = s.startsWith('-');
    const path = optional ? s.slice(1) : s;
    unit.environmentFiles.push({ path, optional });
  }

  for (const entry of envKvs) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
    Object.assign(unit.environment, parseEnvContent(unquoted));
  }

  return unit;
}

function summarizeVar(name, value) {
  if (!value) return `${name}: (missing)`;
  if (name.includes('SECRET') || name.includes('KEY') || name.includes('TOKEN')) {
    return `${name}: ${maskValue(value)}`;
  }
  return `${name}: ${value}`;
}

function pushCheck(checks, level, message, meta = {}) {
  checks.push({ level, message, ...meta });
}

function collectLegacyCopilotFindings(unit, serviceEnv) {
  const findings = [];
  const execStart = unit?.execStart || '';

  if (execStart.includes('bin/copilot.js')) {
    findings.push('ExecStart 仍引用 `bin/copilot.js`，应改为 `bin/perseng.js`');
  }
  if (execStart.includes('/usr/bin/copilot') || execStart.includes(' copilot ')) {
    findings.push('ExecStart 仍引用 `copilot` 二进制，建议改为 `perseng`');
  }
  // 检测旧 promptx 重命名前的二进制路径（perseng 重命名期间会有过渡期）
  if (execStart.includes('bin/promptx.js')) {
    findings.push('ExecStart 仍引用 `bin/promptx.js`，应改为 `bin/perseng.js`');
  }
  if (execStart.includes('/usr/bin/promptx') || execStart.match(/ (?:\/usr\/bin\/)?promptx /)) {
    findings.push('ExecStart 仍引用 `promptx` 二进制，建议改为 `perseng`');
  }

  for (const key of Object.keys(serviceEnv || {})) {
    if (key.includes('COPILOT')) {
      findings.push(`检测到旧环境变量 ${key}，建议迁移为对应的 PERSENG 命名`);
    }
  }

  const promptxPath = serviceEnv.MULTICA_PERSENG_PATH || '';
  const copilotPath = serviceEnv.MULTICA_COPILOT_PATH || '';
  if (copilotPath && !promptxPath) {
    findings.push('检测到 `MULTICA_COPILOT_PATH`，但未配置 `MULTICA_PERSENG_PATH`');
  }

  // 旧 promptx-cli 期间的过渡兼容：读取并打 deprecation warn
  if (serviceEnv.MULTICA_PROMPTX_PATH && !promptxPath) {
    findings.push('检测到已弃用的 `MULTICA_PROMPTX_PATH`，请改用 `MULTICA_PERSENG_PATH`（旧值仍可被读取，但将在下一版本移除）');
  }

  return findings;
}

function renderTextReport(report) {
  const lines = [];
  lines.push(`perseng doctor`);
  lines.push(`platform: ${report.platform}`);
  lines.push(`node: ${report.node}`);
  lines.push('');
  for (const c of report.checks) {
    const tag = c.level.toUpperCase().padEnd(5, ' ');
    lines.push(`${tag} ${c.message}`);
  }
  if (report.configSources?.length) {
    lines.push('');
    lines.push('CONFIG SOURCES');
    for (const item of report.configSources) {
      lines.push(`INFO  ${item.env || item.key} <= ${item.source} (${item.sourceDetail}) => ${item.value}`);
    }
  }
  return lines.join('\n');
}

export { pingLlmProvider };

export async function doctorCommand(options = {}) {
  const checks = [];
  const config = getConfig();

  const major = Number(String(process.versions.node || '').split('.')[0] || '0');
  if (major >= 20) {
    pushCheck(checks, 'ok', `Node.js 版本满足要求 (${process.version})`);
  } else {
    pushCheck(checks, 'fail', `Node.js 版本过低 (${process.version})，需要 20+`);
  }

  const feishuAppId = config.feishuAppId || '';
  const feishuAppSecret = config.feishuAppSecret || '';
  const anthropicKey = config.anthropicApiKey || '';
  const openaiKey = config.openaiApiKey || '';
  const apiBase = config.apiBase || '';
  const model = config.model || '';

  // 检测遗留的 PROMPTX_* 环境变量（重命名期间过渡兼容）
  const legacyEnvVars = Object.keys(process.env).filter((k) => /^PROMPTX_[A-Z_]+$/.test(k));
  if (legacyEnvVars.length > 0) {
    pushCheck(
      checks,
      'warn',
      `检测到已弃用的 PROMPTX_* 环境变量：${legacyEnvVars.join(', ')}。请改用对应的 PERSENG_* 命名（旧值仍可被读取，但将在下一版本移除）`
    );
  }

  // 检测遗留数据目录 ~/.promptx-cli/ 是否仍存在
  const legacyDataDir = join(homedir(), '.promptx-cli');
  if (existsSync(legacyDataDir)) {
    pushCheck(
      checks,
      'info',
      `检测到旧数据目录 ${legacyDataDir}，建议手动迁移：mv ~/.promptx-cli ~/.perseng-cli（当前版本对旧路径有读时回退兼容）`
    );
  }

  if (options.mode === 'feishu' || options.mode === 'all' || !options.mode) {
    if (feishuAppId && feishuAppSecret) {
      pushCheck(checks, 'ok', `飞书凭据已配置（${summarizeVar('FEISHU_APP_ID', feishuAppId)}; ${summarizeVar('FEISHU_APP_SECRET', feishuAppSecret)}）`);
    } else {
      pushCheck(checks, 'fail', '飞书凭据缺失：需要 FEISHU_APP_ID 与 FEISHU_APP_SECRET');
    }
  }

  if (options.mode === 'llm' || options.mode === 'all' || !options.mode) {
    if (anthropicKey || openaiKey) {
      const keyName = anthropicKey ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      const keyVal = anthropicKey || openaiKey;
      pushCheck(checks, 'ok', `模型凭据已配置（${summarizeVar(keyName, keyVal)}）`);

      // 主动 ping 验证 key 真假 — 避免只看 length > 0 就报 OK 的盲区
      if (!options.skipLlmPing) {
        const ping = await pingLlmProvider({ anthropicKey, openaiKey, apiBase });
        if (ping.ok) {
          pushCheck(checks, 'ok', `模型凭据可用性验证通过（HTTP ${ping.status}）`);
        } else {
          const provider = openaiKey ? `OpenAI (${apiBase || 'https://api.openai.com/v1'})` : 'Anthropic';
          pushCheck(checks, 'fail', `模型凭据可用性验证失败：${provider} → ${ping.reason}（key 字符串非空但远端拒绝；常见原因：key 错、过期、被撤销、端点 URL 错）`);
        }
      } else {
        pushCheck(checks, 'info', '已跳过 LLM 可用性 ping（--skip-llm-ping）');
      }
    } else {
      pushCheck(checks, 'fail', '模型凭据缺失：需要 ANTHROPIC_API_KEY 或 OPENAI_API_KEY');
    }

    if (model) pushCheck(checks, 'ok', `PERSENG_MODEL=${model}`);
    else pushCheck(checks, 'warn', 'PERSENG_MODEL 未设置（将使用默认模型）');

    if (model && /deepseek/i.test(model) && !apiBase) {
      pushCheck(checks, 'warn', '检测到 DeepSeek 模型名，但 PERSENG_API_BASE 为空；若你不是走 OpenAI 官方端点，可能会导致 403');
    }
  }

  const systemdEnabled = options.systemd === true
    || options.mode === 'systemd'
    || options.mode === 'all';

  if (systemdEnabled) {
    if (process.platform !== 'linux') {
      pushCheck(checks, 'skip', `systemd 检查仅支持 Linux（当前 platform=${process.platform}）`);
    } else {
      const service = options.service || 'perseng-feishu';
      const isActive = runSystemctl(['is-active', service]);
      if (isActive.ok) pushCheck(checks, 'ok', `systemd 服务已运行：${service}`);
      else pushCheck(checks, 'warn', `systemd 服务未处于 active：${service}（${isActive.stdout || isActive.stderr || 'unknown'}）`);

      const cat = runSystemctl(['cat', service]);
      let unitContent = cat.ok ? cat.stdout : '';
      let unitFrom = 'systemctl cat';
      if (!unitContent) {
        const fallbackPath = `/etc/systemd/system/${service}.service`;
        const r = safeReadFile(fallbackPath);
        if (r.ok) {
          unitContent = r.content;
          unitFrom = fallbackPath;
        }
      }

      if (!unitContent) {
        pushCheck(checks, 'fail', `无法读取 service 定义：${service}（建议检查 /etc/systemd/system/${service}.service）`);
      } else {
        pushCheck(checks, 'ok', `读取 service 定义成功（来源：${unitFrom}）`);
        const unit = parseUnitContent(unitContent);

        if (!unit.execStart) {
          pushCheck(checks, 'warn', 'service 未找到 ExecStart=');
        } else {
          const first = unit.execStart.split(/\s+/)[0] || '';
          if (first === 'node') {
            pushCheck(checks, 'warn', 'ExecStart 使用了 node（非绝对路径），建议写成 /usr/bin/node 或你的 node 安装绝对路径，避免 PATH 差异');
          } else if (first && !first.startsWith('/')) {
            pushCheck(checks, 'warn', `ExecStart 可能不是绝对路径：${first}`);
          } else {
            pushCheck(checks, 'ok', `ExecStart=${unit.execStart}`);
          }
        }

        const serviceEnv = {};
        const envFileDetails = [];
        for (const ef of unit.environmentFiles) {
          const r = safeReadFile(ef.path);
          envFileDetails.push({ path: ef.path, optional: ef.optional, ok: r.ok });
          if (r.ok) Object.assign(serviceEnv, parseEnvContent(r.content));
          else if (!ef.optional) pushCheck(checks, 'fail', `EnvironmentFile 不可读：${ef.path}`);
        }
        Object.assign(serviceEnv, unit.environment);

        if (envFileDetails.length === 0 && Object.keys(unit.environment).length === 0) {
          pushCheck(checks, 'warn', 'service 未配置 EnvironmentFile/Environment，可能导致环境变量在 systemd 下缺失');
        } else {
          for (const f of envFileDetails) {
            if (f.ok) pushCheck(checks, 'ok', `EnvironmentFile 已加载：${f.path}`);
          }
        }

        const legacyFindings = collectLegacyCopilotFindings(unit, serviceEnv);
        for (const finding of legacyFindings) {
          pushCheck(checks, 'warn', `检测到旧 copilot 配置残留：${finding}`);
        }

        const required = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];
        const llmRequired = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
        for (const k of required) {
          if (serviceEnv[k]) pushCheck(checks, 'ok', `service 环境已包含 ${summarizeVar(k, serviceEnv[k])}`);
          else pushCheck(checks, 'fail', `service 环境缺少 ${k}`);
        }
        if (serviceEnv.ANTHROPIC_API_KEY || serviceEnv.OPENAI_API_KEY) {
          const kk = serviceEnv.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
          pushCheck(checks, 'ok', `service 环境已包含 ${summarizeVar(kk, serviceEnv[kk])}`);
        } else {
          pushCheck(checks, 'fail', `service 环境缺少 ${llmRequired.join(' 或 ')}`);
        }

        if (serviceEnv.PERSENG_MODEL) pushCheck(checks, 'ok', `service 环境 PERSENG_MODEL=${serviceEnv.PERSENG_MODEL}`);
        else pushCheck(checks, 'warn', 'service 环境 PERSENG_MODEL 未设置（将使用默认值）');

        if (serviceEnv.PERSENG_API_BASE) pushCheck(checks, 'ok', `service 环境 PERSENG_API_BASE=${serviceEnv.PERSENG_API_BASE}`);
        else pushCheck(checks, 'warn', 'service 环境 PERSENG_API_BASE 未设置（若使用非 OpenAI 官方端点可能会失败）');

        const show = runSystemctl(['show', service, '-p', 'NRestarts', '--value']);
        if (show.ok) {
          const n = Number(show.stdout || '0');
          if (Number.isFinite(n) && n > 5) pushCheck(checks, 'warn', `服务近期重启次数较高：NRestarts=${n}`);
        }
      }
    }
  }

  const ok = !checks.some((c) => c.level === 'fail');
  const configSources = options.showConfigSources || options.json
    ? collectConfigSourceRows(config)
    : [];
  const report = {
    ok,
    platform: process.platform,
    node: process.version,
    checks,
    configSources,
    timestamp: new Date().toISOString(),
  };

  if (options.json) {
    outputResult(report, options);
    return;
  }

  outputResult(renderTextReport(report), options);
}
