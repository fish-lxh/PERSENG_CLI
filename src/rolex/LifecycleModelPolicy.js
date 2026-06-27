import { getConfig } from '../config.js';
import { getLifecycleStage } from './LifecycleStageStore.js';

function normalizePolicy(policy) {
    if (!policy || typeof policy !== 'object') return {};
    return {
        idle: policy.idle || '',
        goal: policy.goal || '',
        planning: policy.planning || '',
        execution: policy.execution || '',
        reflection: policy.reflection || '',
    };
}

export function resolveLifecycleModel(options = {}) {
    const config = getConfig();
    const role = options.role || {};

    if (options.explicitModel) {
        return {
            model: options.explicitModel,
            stage: 'explicit',
            source: 'explicit',
        };
    }

    const lifecycleState = getLifecycleStage(options.roleId);
    const stage = lifecycleState?.stage || 'idle';
    const rolePolicy = normalizePolicy(role.modelStrategy || role.model_strategy);
    const globalPolicy = normalizePolicy(config.modelStrategy);

    if (rolePolicy[stage]) {
        return {
            model: rolePolicy[stage],
            stage,
            source: 'role-stage-policy',
        };
    }

    if (globalPolicy[stage]) {
        return {
            model: globalPolicy[stage],
            stage,
            source: 'global-stage-policy',
        };
    }

    if (role.model) {
        return {
            model: role.model,
            stage,
            source: 'role-default',
        };
    }

    return {
        model: options.defaultModel || config.model,
        stage,
        source: 'global-default',
    };
}

