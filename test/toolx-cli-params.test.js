import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExecuteParameters } from '../src/commands/toolx.js';

test('buildExecuteParameters: 合并 params-json 与 param key=value', () => {
    const parameters = buildExecuteParameters({
        action: 'search',
        paramsJson: '{"backend":"duckduckgo","limit":5}',
        param: ['query=飞书机器人', 'brainArea=jiangziya', 'debug=true'],
    });

    assert.deepEqual(parameters, {
        action: 'search',
        backend: 'duckduckgo',
        limit: 5,
        query: '飞书机器人',
        brainArea: 'jiangziya',
        debug: true,
    });
});

test('buildExecuteParameters: 显式参数优先级高于通用参数', () => {
    const parameters = buildExecuteParameters({
        action: 'think',
        paramsJson: '{"question":"json question","brainArea":"json-area"}',
        param: ['question=kv question', 'brainArea=kv-area'],
        question: 'explicit question',
        brainArea: 'explicit-area',
    });

    assert.equal(parameters.action, 'think');
    assert.equal(parameters.question, 'explicit question');
    assert.equal(parameters.brainArea, 'explicit-area');
});

test('buildExecuteParameters: 支持对象与数组字面量', () => {
    const parameters = buildExecuteParameters({
        action: 'capture',
        param: ['metadata={"source":"cli"}', 'tags=["gbrain","toolx"]'],
    });

    assert.deepEqual(parameters, {
        action: 'capture',
        metadata: { source: 'cli' },
        tags: ['gbrain', 'toolx'],
    });
});

test('buildExecuteParameters: 非法 param 格式抛出友好错误', () => {
    assert.throws(
        () => buildExecuteParameters({ action: 'search', param: ['broken'] }),
        /--param 参数必须是 key=value 格式/
    );
});

test('buildExecuteParameters: 非法 params-json 抛出友好错误', () => {
    assert.throws(
        () => buildExecuteParameters({ action: 'search', paramsJson: '[]' }),
        /--params-json 必须是 JSON 对象/
    );
});

test('buildExecuteParameters: 兼容 PowerShell 去引号后的宽松对象写法', () => {
    const parameters = buildExecuteParameters({
        action: 'think',
        paramsJson: '{question:test-question,brainArea:jiangziya,debug:true}',
    });

    assert.deepEqual(parameters, {
        action: 'think',
        question: 'test-question',
        brainArea: 'jiangziya',
        debug: true,
    });
});
