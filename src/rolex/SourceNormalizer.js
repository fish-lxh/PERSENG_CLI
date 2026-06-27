import { PersengError, ErrorCode } from '../errors.js';

const FEATURE_HEADER_RE = /^\s*Feature:/m;
const SCENARIO_HEADER_RE = /^\s*Scenario(?: Outline)?:/m;
const STEP_RE = /^\s*(Given|When|Then|And|But)\b/m;

function sanitizeInlineText(value, fallback) {
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    return text || fallback;
}

function indentLines(text, spaces) {
    const prefix = ' '.repeat(spaces);
    return text
        .split(/\r?\n/)
        .map((line) => (line ? `${prefix}${line}` : ''))
        .join('\n');
}

function buildFeatureTitle(context = {}) {
    return sanitizeInlineText(
        context.name || context.id || context.org || context.parent,
        `${context.operation || 'source'} context`
    );
}

function buildScenarioTitle(context = {}) {
    return sanitizeInlineText(
        context.operation || context.name || context.id,
        'details'
    );
}

export function normalizeRolexSource(source, context = {}) {
    if (typeof source !== 'string') return source;

    const trimmed = source.trim();
    // 关键修复：原代码对空字符串返回空串，下游会写出 "Feature: \n\n  Scenario: details" 这种空壳 Gherkin。
    // 改为：明确报错，让调用方处理缺省值。
    if (!trimmed) {
        const op = context?.operation || 'unknown';
        throw new PersengError({
            code: ErrorCode.ROLE_SOURCE_INVALID,
            message: `normalizeRolexSource: empty source for operation "${op}"`,
            userMessage: `--source 不能为空 (operation=${op})`,
            context: { operation: op },
        });
    }

    if (FEATURE_HEADER_RE.test(trimmed)) {
        return trimmed;
    }

    const featureTitle = buildFeatureTitle(context);
    const scenarioTitle = buildScenarioTitle(context);

    if (SCENARIO_HEADER_RE.test(trimmed)) {
        return `Feature: ${featureTitle}\n\n${indentLines(trimmed, 2)}`;
    }

    if (STEP_RE.test(trimmed)) {
        return [
            `Feature: ${featureTitle}`,
            '',
            `  Scenario: ${scenarioTitle}`,
            indentLines(trimmed, 4),
        ].join('\n');
    }

    const lines = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const steps = lines.map((line, index) => `    ${index === 0 ? 'Given' : 'And'} ${line}`);

    return [
        `Feature: ${featureTitle}`,
        '',
        `  Scenario: ${scenarioTitle}`,
        ...steps,
    ].join('\n');
}

