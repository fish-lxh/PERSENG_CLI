import { createRolexDispatcher } from '../rolex/RolexDispatcherLoader.js';
import { readActiveRoleId, writeActiveRoleId } from '../rolex/ActiveRoleStore.js';
import { recordLifecycleOperation } from '../rolex/LifecycleStageStore.js';
import { normalizeRolexSource } from '../rolex/SourceNormalizer.js';

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

export async function lifecycleCommand(options) {
    const dispatcher = await createRolexDispatcher();
    const operation = options.operation;
    const role = options.role;
    let effectiveRoleId = role;

    if (!operation) throw new Error('operation is required');
    if (!role) throw new Error('role is required');

    if (role === '_') {
        const activeRoleId = readActiveRoleId();
        if (!activeRoleId) {
            throw new Error('No active role. Run: perseng action -o activate -r <role>');
        }
        effectiveRoleId = activeRoleId;
        await dispatcher.dispatch('activate', { role: activeRoleId, operation: 'activate' });
    } else {
        await dispatcher.dispatch('activate', { role, operation: 'activate' });
        writeActiveRoleId(role);
    }

    if (role && role !== '_') {
        try {
            const isV2 = await dispatcher.isV2Role(role);
            if (!isV2) {
                throw new Error(`V1 角色 "${role}" 不支持 lifecycle（仅支持 V2/RoleX）`);
            }
        } catch (e) {
            if (e?.message?.includes('不支持 lifecycle')) throw e;
        }
    }

    const args = {
        role,
        operation,
        name: options.name,
        source: normalizeRolexSource(options.source, {
            operation,
            name: options.name,
            id: options.id,
            role,
        }),
        id: options.id,
        testable: options.testable,
        experience: options.experience,
        encounter: options.encounter,
    };

    const result = await dispatcher.dispatch(operation, args);
    recordLifecycleOperation(effectiveRoleId, operation, {
        name: options.name,
        planId: options.id,
    });
    outputResult(result, options);
}
