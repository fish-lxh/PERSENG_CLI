import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activateRole,
  clearRoleCache,
  listRolesSync,
  loadRole,
  resolveRoleWorkspace,
} from '../src/role-loader.js';

test('listRolesSync returns bundled roles', () => {
  const roles = listRolesSync();
  const ids = roles.map((role) => role.id);

  assert.ok(ids.includes('jiangziya'));
  assert.ok(ids.includes('nuwa'));
});

test('loadRole caches role instances and activateRole renders sections', () => {
  clearRoleCache();

  const first = loadRole('jiangziya');
  const second = loadRole('jiangziya');
  const prompt = activateRole(first);

  assert.equal(first, second);
  assert.match(prompt, /# 角色:/);
  assert.match(prompt, /## 人格特征/);
  assert.match(prompt, /## 行为原则/);
  assert.match(prompt, /## 知识域/);
});

test('loadRole throws for a missing role', () => {
  clearRoleCache();

  assert.throws(() => loadRole('missing-role'), /未找到/);
});

test('role workspace resolves relative to project root', () => {
  clearRoleCache();

  const boduan = loadRole('boduan');
  const rotation = loadRole('rotation');

  assert.equal(boduan.workspace, './Boduan');
  assert.equal(rotation.workspace, './Rotation');
  assert.match(resolveRoleWorkspace(boduan), /perseng-cli[\\/]+Boduan$/);
  assert.match(resolveRoleWorkspace(rotation), /perseng-cli[\\/]+Rotation$/);
});
