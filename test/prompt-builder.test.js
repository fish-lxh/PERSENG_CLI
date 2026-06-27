import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMessages, buildSystemPrompt } from '../src/prompt-builder.js';

const role = {
    id: 'tester',
    name: 'Test Role',
    description: 'Handles tests.',
    persona: {
        type: 'INTJ',
        traits: ['structured', 'calm'],
        dialogue_style: {
            tone: 'direct',
            structure: 'top-down',
        },
    },
    principles: [
        { name: 'Be precise', content: 'Return exact answers.' },
    ],
    knowledge: ['testing'],
    routes_to: ['codex'],
    gherkin_source: 'Feature: Testing',
};

test('buildSystemPrompt includes role details, memories, and constraints', () => {
    const prompt = buildSystemPrompt(role, {
        memories: ['Remember the last test'],
    });

    assert.match(prompt, /# 角色: Test Role/);
    assert.match(prompt, /## 相关记忆/);
    assert.match(prompt, /Remember the last test/);
    assert.match(prompt, /## 行为约束/);
    // route_to_agent 已废弃：所有任务都通过内置工具自己完成
    assert.doesNotMatch(prompt, /route_to_agent/);
    assert.match(prompt, /```gherkin/);
});

test('buildMessages injects instructions before the main task', () => {
    const messages = buildMessages('Execute the task', {
        instructions: 'Follow the house style.',
    });

    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0], {
        role: 'user',
        content: 'Follow the house style.',
    });
    assert.deepEqual(messages[1], {
        role: 'assistant',
        content: '明白，我会遵循这些指令。请告诉我具体任务。',
    });
    assert.deepEqual(messages[2], {
        role: 'user',
        content: 'Execute the task',
    });
});

// ─── Phase 4.1: 多模态 attachments ─────────────────────

test('buildMessages 支持 image attachment（多模态）', () => {
    const messages = buildMessages('看看这张图', {
        attachments: [
            { type: 'image', base64: 'AAA', mediaType: 'image/png' },
        ],
    });

    assert.equal(messages.length, 1);
    const userMsg = messages[0];
    assert.equal(userMsg.role, 'user');
    assert.ok(Array.isArray(userMsg.content), 'content 应是数组');
    assert.equal(userMsg.content.length, 2);
    assert.equal(userMsg.content[0].type, 'text');
    assert.equal(userMsg.content[0].text, '看看这张图');
    assert.equal(userMsg.content[1].type, 'image');
    assert.equal(userMsg.content[1].base64, 'AAA');
    assert.equal(userMsg.content[1].mediaType, 'image/png');
});

test('buildMessages 多张图按顺序追加', () => {
    const messages = buildMessages('compare', {
        attachments: [
            { type: 'image', base64: 'A', mediaType: 'image/png' },
            { type: 'image', base64: 'B', mediaType: 'image/jpeg' },
        ],
    });

    assert.equal(messages[0].content.length, 3);
    assert.equal(messages[0].content[1].base64, 'A');
    assert.equal(messages[0].content[2].base64, 'B');
    assert.equal(messages[0].content[2].mediaType, 'image/jpeg');
});

test('buildMessages attachments 为空数组 → 走纯文本路径', () => {
    const messages = buildMessages('hello', { attachments: [] });
    assert.equal(messages[0].content, 'hello');
});
