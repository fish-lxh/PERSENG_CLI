import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfig, resetConfig, saveConfig } from '../config.js';
import { getRolesDir } from '../role-loader.js';

const VALID_STAGES = ['idle', 'goal', 'planning', 'execution', 'reflection'];

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

function normalizeStrategy(strategy) {
  return {
    idle: strategy?.idle || '',
    goal: strategy?.goal || '',
    planning: strategy?.planning || '',
    execution: strategy?.execution || '',
    reflection: strategy?.reflection || '',
  };
}

function resolveRoleFile(roleId) {
  const filePath = join(getRolesDir(), `${roleId}.json`);
  if (!existsSync(filePath)) {
    throw new Error(`角色 "${roleId}" 未找到`);
  }
  return filePath;
}

function readRoleConfig(roleId) {
  const filePath = resolveRoleFile(roleId);
  return {
    filePath,
    role: JSON.parse(readFileSync(filePath, 'utf-8')),
  };
}

function updateRoleStrategy(roleId, updater) {
  const { filePath, role } = readRoleConfig(roleId);
  const nextRole = updater(role);
  writeFileSync(filePath, JSON.stringify(nextRole, null, 2) + '\n', 'utf-8');
  return nextRole;
}

function getGlobalPolicyPayload() {
  const config = getConfig();
  return {
    scope: 'global',
    strategy: normalizeStrategy(config.modelStrategy),
    defaultModel: config.model,
  };
}

function getRolePolicyPayload(roleId) {
  const { role } = readRoleConfig(roleId);
  return {
    scope: 'role',
    role: roleId,
    defaultModel: role.model || '',
    strategy: normalizeStrategy(role.modelStrategy || role.model_strategy),
  };
}

function validateStage(stage) {
  if (!VALID_STAGES.includes(stage)) {
    throw new Error(`stage 必须是以下之一: ${VALID_STAGES.join(', ')}`);
  }
}

export async function policyCommand(options) {
  const action = options.action || 'show';
  const scopeRole = options.role || '';

  if (action === 'show') {
    const payload = scopeRole ? getRolePolicyPayload(scopeRole) : getGlobalPolicyPayload();
    outputResult(payload, options);
    return;
  }

  if (action === 'set') {
    validateStage(options.stage);
    if (!options.model) {
      throw new Error('set 操作需要提供 --model');
    }

    if (scopeRole) {
      const nextRole = updateRoleStrategy(scopeRole, (role) => ({
        ...role,
        modelStrategy: {
          ...normalizeStrategy(role.modelStrategy || role.model_strategy),
          [options.stage]: options.model,
        },
      }));

      outputResult({
        scope: 'role',
        role: scopeRole,
        stage: options.stage,
        model: options.model,
        strategy: normalizeStrategy(nextRole.modelStrategy),
      }, options);
      return;
    }

    const config = getConfig();
    const nextStrategy = {
      ...normalizeStrategy(config.modelStrategy),
      [options.stage]: options.model,
    };
    saveConfig({ modelStrategy: nextStrategy });
    resetConfig();

    outputResult({
      scope: 'global',
      stage: options.stage,
      model: options.model,
      strategy: normalizeStrategy(nextStrategy),
    }, options);
    return;
  }

  if (action === 'clear') {
    validateStage(options.stage);

    if (scopeRole) {
      const nextRole = updateRoleStrategy(scopeRole, (role) => ({
        ...role,
        modelStrategy: {
          ...normalizeStrategy(role.modelStrategy || role.model_strategy),
          [options.stage]: '',
        },
      }));

      outputResult({
        scope: 'role',
        role: scopeRole,
        cleared: options.stage,
        strategy: normalizeStrategy(nextRole.modelStrategy),
      }, options);
      return;
    }

    const config = getConfig();
    const nextStrategy = {
      ...normalizeStrategy(config.modelStrategy),
      [options.stage]: '',
    };
    saveConfig({ modelStrategy: nextStrategy });
    resetConfig();

    outputResult({
      scope: 'global',
      cleared: options.stage,
      strategy: normalizeStrategy(nextStrategy),
    }, options);
    return;
  }

  throw new Error(`不支持的 policy 操作: ${action}`);
}

