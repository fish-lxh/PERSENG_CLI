import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRoleCommand, parseRoleCommand } from '../src/feishu-role-switch.js';

test('parseRoleCommand recognizes list/show/set', () => {
    assert.deepEqual(parseRoleCommand('/role list'), { action: 'list' });
    assert.deepEqual(parseRoleCommand('/role ls'), { action: 'list' });
    assert.deepEqual(parseRoleCommand('/role show'), { action: 'show' });
    assert.deepEqual(parseRoleCommand('/role set nuwa'), { action: 'set', roleId: 'nuwa' });
    assert.equal(parseRoleCommand('hello'), null);
});

test('handleRoleCommand enforces roleAdmins for set', () => {
    const roleAdmins = new Set(['u-admin']);

    const denied = handleRoleCommand({
        text: '/role set nuwa',
        currentRoleId: 'jiangziya',
        senderId: 'u-guest',
        roleAdmins,
    });

    assert.equal(denied.handled, true);
    assert.match(denied.reply, /无权限/);
});

test('handleRoleCommand allows admins to set roles', () => {
    const roleAdmins = new Set(['u-admin']);
    const ok = handleRoleCommand({
        text: '/role set nuwa',
        currentRoleId: 'jiangziya',
        senderId: 'u-admin',
        roleAdmins,
    });

    assert.equal(ok.handled, true);
    assert.equal(ok.nextRoleId, 'nuwa');
    assert.match(ok.reply, /已切换角色/);
});

