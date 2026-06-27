import { createRequire } from 'module';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

function ensurePersEngLogDir() {
  if (process.env.PERSENG_NO_WORKERS === undefined) {
    process.env.PERSENG_NO_WORKERS = 'true';
  }
  const dir = resolve(homedir(), '.perseng', 'logs');
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
    }
  }
}

async function loadFromPackage() {
  ensurePersEngLogDir();
  const core = await import('@promptx/core');
  const coreExports = core.default || core;
  const { RolexActionDispatcher } = coreExports.rolex || {};
  if (!RolexActionDispatcher) {
    throw new Error('RolexActionDispatcher not found in @promptx/core');
  }
  return { RolexActionDispatcher };
}

function loadFromLocalPersEng() {
  ensurePersEngLogDir();
  const promptxRoot =
    process.env.PERSENG_CLI_PERSENG_ROOT || resolve(__dirname, '..', '..', '..', 'PromptX');
  if (!existsSync(resolve(promptxRoot, 'package.json'))) {
    throw new Error(`PromptX repo not found at: ${promptxRoot}`);
  }
  if (!existsSync(resolve(promptxRoot, 'node_modules'))) {
    throw new Error(
      [
        'PromptX repo is present but dependencies are not installed.',
        `PromptX path: ${promptxRoot}`,
        'Run:',
        `  cd ${promptxRoot}`,
        '  pnpm install',
      ].join('\n')
    );
  }
  const persengRequire = createRequire(resolve(promptxRoot, 'package.json'));
  const core = persengRequire('@promptx/core');
  const coreExports = core.default || core;
  const { RolexActionDispatcher } = coreExports.rolex || {};
  if (!RolexActionDispatcher) throw new Error('RolexActionDispatcher not found in local PromptX');
  return { RolexActionDispatcher };
}

export async function createRolexDispatcher() {
  if (process.env.PERSENG_ENABLE_V2 === undefined) {
    process.env.PERSENG_ENABLE_V2 = '1';
  }

  if (process.env.PERSENG_CLI_ROLEX_MOCK === '1') {
    class MockDispatcher {
      async dispatch(operation, args = {}) {
        return {
          type: 'mock',
          operation,
          args,
        };
      }

      async isV2Role() {
        return true;
      }
    }

    return new MockDispatcher();
  }

  let lastError;
  try {
    const { RolexActionDispatcher } = await loadFromPackage();
    return new RolexActionDispatcher();
  } catch (e) {
    lastError = e;
  }

  try {
    const { RolexActionDispatcher } = loadFromLocalPersEng();
    return new RolexActionDispatcher();
  } catch (e) {
    lastError = e;
  }

  const localPathHint = resolve(__dirname, '..', '..', '..', 'PromptX');
  throw new Error(
    [
      'RoleX (V2) is not available in this environment.',
      'Install @promptx/core, or place PromptX repo at:',
      `  ${localPathHint}`,
      'You can also set PERSENG_CLI_PERSENG_ROOT to point at your PromptX repo.',
      'Or set PERSENG_CLI_ROLEX_MOCK=1 for wiring tests.',
      lastError ? `\nDetails:\n${lastError.message}` : '',
    ].join('\n')
  );
}
