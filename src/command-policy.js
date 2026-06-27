/**
 * 命令策略 (P0.2)
 *
 * 为 run_command 工具提供：
 * 1. 通过 PERSENG_RUN_COMMAND_ALLOWLIST 环境变量限制允许执行的二进制
 * 2. 检测 shell 元字符，阻止命令拼接
 * 3. 拒绝绝对路径（防止绕过 allowlist）
 *
 * 用法:
 *   PERSENG_RUN_COMMAND_ALLOWLIST="multica,git,ls,cat"
 *   → 只允许执行二进制名在该列表中的命令
 *   → 未设置环境变量时维持旧行为（向后兼容）
 */

import { basename } from 'path';
import { getConfig } from './config.js';

// 视为危险的 shell 元字符（含换行和管道、变量展开、命令替换）
const SHELL_METACHARS = /[;&|`$<>(){}\n\r\\]|&&|\|\|/;

/**
 * 简易 shell token 解析（双引号/单引号/反斜杠转义）。
 * 不追求 100% POSIX 兼容，但能处理大多数日常命令。
 */
export function tokenizeCommand(cmd) {
  const tokens = [];
  let current = '';
  let quote = null; // '"' | "'" | null
  let escaped = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) tokens.push(current);
  if (quote) {
    throw new Error(`Unclosed quote in command: ${cmd}`);
  }
  return tokens;
}

/**
 * 解析 PERSENG_RUN_COMMAND_ALLOWLIST，返回 binary basename 集合。
 * 空字符串 / 未设置 → null（表示未启用 allowlist）。
 */
export function getAllowlist() {
  const list = getConfig().runCommandAllowlist;
  if (!Array.isArray(list) || list.length === 0) return null;
  return new Set(
    list
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

/**
 * 校验一条命令是否符合策略。
 *
 * @param {string} command
 * @returns {{ ok: true, binary: string } | { ok: false, reason: string }}
 */
export function checkCommand(command) {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, reason: 'command is empty' };
  }

  // 先查 shell 元字符
  if (SHELL_METACHARS.test(command)) {
    return {
      ok: false,
      reason:
        'command contains shell metacharacters (;, |, &, >, <, $, `, \\, etc.); ' +
        'this is rejected for safety. Run them as separate commands or use a different tool.',
    };
  }

  let tokens;
  try {
    tokens = tokenizeCommand(command);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (tokens.length === 0) {
    return { ok: false, reason: 'command has no tokens' };
  }

  const binary = tokens[0];

  // 拒绝绝对路径（Linux / Windows 盘符 / UNC）
  if (
    binary.startsWith('/') ||
    binary.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(binary)
  ) {
    return {
      ok: false,
      reason:
        `absolute path "${binary}" is rejected; use a bare binary name on PATH ` +
        '(and add it to PERSENG_RUN_COMMAND_ALLOWLIST if allowlist is enabled).',
    };
  }

  const allowlist = getAllowlist();
  if (allowlist === null) {
    // 未启用 allowlist — 行为向后兼容，仅做元字符 + 绝对路径检查
    return { ok: true, binary };
  }

  const binName = basename(binary);
  if (!allowlist.has(binName)) {
    return {
      ok: false,
      reason:
        `binary "${binName}" is not in PERSENG_RUN_COMMAND_ALLOWLIST. ` +
        `Allowed: ${Array.from(allowlist).join(', ')}`,
    };
  }

  return { ok: true, binary: binName };
}
