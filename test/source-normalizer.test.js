import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRolexSource } from '../src/rolex/SourceNormalizer.js';

test('normalizeRolexSource leaves full feature sources untouched', () => {
  const source = 'Feature: Ready\n\n  Scenario: Demo\n    Given a prepared source';

  assert.equal(normalizeRolexSource(source), source);
});

test('normalizeRolexSource wraps scenario blocks with a feature header', () => {
  const normalized = normalizeRolexSource('Scenario: Plan\n  Given a target', {
    name: 'Roadmap',
    operation: 'plan',
  });

  assert.match(normalized, /^Feature: Roadmap/);
  assert.match(normalized, /Scenario: Plan/);
});

test('normalizeRolexSource converts plain text lines into Gherkin steps', () => {
  const normalized = normalizeRolexSource('first line\nsecond line', {
    name: 'Goal',
    operation: 'want',
  });

  assert.match(normalized, /Feature: Goal/);
  assert.match(normalized, /Scenario: want/);
  assert.match(normalized, /Given first line/);
  assert.match(normalized, /And second line/);
});
