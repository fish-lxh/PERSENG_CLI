import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('createRolexDispatcher returns a mock dispatcher when enabled', async (t) => {
  const previousMock = process.env.PERSENG_CLI_ROLEX_MOCK;
  const previousV2 = process.env.PERSENG_ENABLE_V2;

  t.after(() => {
    if (previousMock === undefined) {
      delete process.env.PERSENG_CLI_ROLEX_MOCK;
    } else {
      process.env.PERSENG_CLI_ROLEX_MOCK = previousMock;
    }

    if (previousV2 === undefined) {
      delete process.env.PERSENG_ENABLE_V2;
    } else {
      process.env.PERSENG_ENABLE_V2 = previousV2;
    }
  });

  process.env.PERSENG_CLI_ROLEX_MOCK = '1';
  delete process.env.PERSENG_ENABLE_V2;

  const moduleUrl = pathToFileURL(resolve('src/rolex/RolexDispatcherLoader.js')).href;
  const { createRolexDispatcher } = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
  const dispatcher = await createRolexDispatcher();
  const result = await dispatcher.dispatch('activate', { role: 'jiangziya' });

  assert.deepEqual(result, {
    type: 'mock',
    operation: 'activate',
    args: { role: 'jiangziya' },
  });
  assert.equal(await dispatcher.isV2Role('jiangziya'), true);
  assert.equal(process.env.PERSENG_ENABLE_V2, '1');
});
