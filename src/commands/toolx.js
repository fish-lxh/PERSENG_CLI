/**
 * toolx 命令 — ToolX 协议的 CLI 入口
 *
 * 使用:
 *   perseng toolx discover                    发现所有工具
 *   perseng toolx manual --tool tool://filesystem   查看工具文档
 *   perseng toolx exec --tool tool://filesystem --action read --path file.txt
 *   perseng toolx dryrun --tool tool://filesystem --action write --path test.txt --content hello
 *   perseng toolx configure --tool tool://filesystem --key allowPathOutsideCwd --value true
 *   perseng toolx log --tool tool://filesystem
 *   perseng toolx run --yaml '{"tool":"tool://filesystem","mode":"execute","parameters":{"action":"read","path":"test.txt"}}'
 */

import { ToolXProtocol } from '../toolx/ToolXProtocol.js';
import { getConfig } from '../config.js';

const EXPLICIT_EXEC_OPTION_KEYS = [
  'name', 'id', 'source', 'path', 'content', 'query', 'question',
  'brainArea', 'slug', 'pattern', 'glob', 'sheet', 'uri',
  'description', 'actions', 'encode', 'shell',
];

function parseCliScalar(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);

  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }

  return raw;
}

function parseExtraParamEntries(entries) {
  if (!entries) return {};

  const items = Array.isArray(entries) ? entries : [entries];
  const parsed = {};
  for (const item of items) {
    const text = String(item);
    const idx = text.indexOf('=');
    if (idx <= 0) {
      throw new Error('--param 参数必须是 key=value 格式');
    }
    const key = text.slice(0, idx).trim();
    const rawValue = text.slice(idx + 1);
    if (!key) {
      throw new Error('--param 参数必须包含非空 key');
    }
    parsed[key] = parseCliScalar(rawValue);
  }
  return parsed;
}

function splitTopLevelComma(text) {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';

    if (quote) {
      current += ch;
      if (ch === quote && prev !== '\\') {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '{' || ch === '[') {
      depth += 1;
      current += ch;
      continue;
    }

    if (ch === '}' || ch === ']') {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function parseLooseObjectLiteral(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('--params-json 必须是有效的 JSON 对象字符串');
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return {};

  const result = {};
  for (const pair of splitTopLevelComma(inner)) {
    const idx = pair.indexOf(':');
    if (idx <= 0) {
      throw new Error('--params-json 必须是有效的 JSON 对象字符串');
    }

    const rawKey = pair.slice(0, idx).trim();
    const rawValue = pair.slice(idx + 1).trim();
    const key = rawKey.replace(/^["']|["']$/g, '');
    if (!key) {
      throw new Error('--params-json 必须包含非空 key');
    }

    let value;
    if ((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith('\'') && rawValue.endsWith('\''))) {
      value = rawValue.slice(1, -1);
    } else {
      value = parseCliScalar(rawValue);
    }
    result[key] = value;
  }

  return result;
}

function parseExtraParamsJson(jsonText) {
  if (!jsonText) return {};

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = parseLooseObjectLiteral(jsonText);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--params-json 必须是 JSON 对象');
  }

  return parsed;
}

export function buildExecuteParameters(options) {
  if (!options.action) {
    throw new Error('exec/dryrun 模式需要 --action 参数');
  }

  const parameters = {
    ...parseExtraParamsJson(options.paramsJson),
    ...parseExtraParamEntries(options.param),
    action: options.action,
  };

  for (const key of EXPLICIT_EXEC_OPTION_KEYS) {
    if (options[key] !== undefined) {
      parameters[key] = options[key];
    }
  }

  return parameters;
}

function outputResult(result, options = {}) {
  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  if (result.ok === false) {
    process.stdout.write(`❌ ${result.error}\n`);
    return;
  }

  switch (result.mode) {
    case 'discover': {
      process.stdout.write(`# 可用工具 (${result.tools.length})\n\n`);
      for (const t of result.tools) {
        process.stdout.write(`- **${t.uri}**: ${t.description}\n`);
        if (t.actions?.length) {
          process.stdout.write(`  操作: ${t.actions.map((a) => a.name).join(', ')}\n`);
        }
      }
      break;
    }

    case 'manual': {
      process.stdout.write(`${result.manual}\n`);
      break;
    }

    case 'dryrun': {
      process.stdout.write(`🔍 [Dry Run] ${result.description}\n`);
      break;
    }

    case 'execute': {
      if (typeof result.result === 'string') {
        process.stdout.write(result.result + '\n');
      } else if (result.data !== undefined) {
        // Excel 等结构化数据
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.roles !== undefined) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else if (result.role !== undefined) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      }
      break;
    }

    case 'configure':
    case 'log': {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }

    default: {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
  }
}

async function runSimple(toolx, options) {
  const modeMap = {
    manual: 'manual',
    exec: 'execute',
    dryrun: 'dryrun',
    configure: 'configure',
    log: 'log',
  };

  const mode = modeMap[options._mode];
  if (!mode) {
    throw new Error(`不支持的操作模式: ${options._mode}`);
  }

  let parameters = {};

  if (mode === 'execute' || mode === 'dryrun') {
    parameters = buildExecuteParameters(options);
  }

  if (mode === 'configure') {
    if (options.key && options.value !== undefined) {
      parameters[options.key] = options.value;
    } else {
      throw new Error('configure 模式需要 --key 和 --value 参数');
    }
  }

  const result = await toolx.dispatch({
    tool: options.tool,
    mode,
    parameters,
  });

  return result;
}

export async function toolxCommand(options) {
  const config = getConfig();
  const toolx = new ToolXProtocol({
    toolRuntime: null,
    cwd: options.cwd || process.cwd(),
  });

  let result;

  if (options._mode === 'discover') {
    // 发现模式
    const disc = toolx.discover();
    result = { ...disc, mode: 'discover' };
  } else if (options._mode === 'run' && options.yaml) {
    // 直接传递 YAML/JSON
    let parsed;
    if (typeof options.yaml === 'string') {
      try {
        parsed = JSON.parse(options.yaml);
      } catch {
        throw new Error('--yaml 参数必须是有效的 JSON 字符串');
      }
    } else {
      parsed = options.yaml;
    }
    result = await toolx.dispatch({
      tool: parsed.tool,
      mode: parsed.mode,
      parameters: parsed.parameters || {},
    });
  } else if (options._mode) {
    result = await runSimple(toolx, options);
  } else {
    // 默认: discover
    const disc = toolx.discover();
    result = { ...disc, mode: 'discover' };
  }

  outputResult(result, options);
}
