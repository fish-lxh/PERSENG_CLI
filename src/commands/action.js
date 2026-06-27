import { createRolexDispatcher } from '../rolex/RolexDispatcherLoader.js';
import { normalizeRolexSource } from '../rolex/SourceNormalizer.js';
import { writeActiveRoleId } from '../rolex/ActiveRoleStore.js';

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

export async function actionCommand(options) {
  const dispatcher = await createRolexDispatcher();
  const operation = options.operation;

  if (!operation) {
    throw new Error('operation is required');
  }

  if (options.v2 === false) {
    process.env.PERSENG_ENABLE_V2 = '0';
  } else if (process.env.PERSENG_ENABLE_V2 === undefined) {
    process.env.PERSENG_ENABLE_V2 = '1';
  }

  const args = {
    role: options.role,
    operation,
    name: options.name,
    source: normalizeRolexSource(options.source, {
      operation,
      name: options.name,
      role: options.role,
    }),
  };

  const result = await dispatcher.dispatch(operation, args);
  if (operation === 'activate' && typeof options.role === 'string' && options.role !== '_') {
    writeActiveRoleId(options.role);
  }
  outputResult(result, options);
}
