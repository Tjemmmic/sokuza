import { describe, it, expect } from 'vitest';
import { isStringTruthy } from './truthy.js';

describe('isStringTruthy', () => {
    // Pin the falsy set explicitly. Both the runtime's `condition:`
    // evaluator and the flow.if node body call this; if the set drifts,
    // a node could skip while a downstream flow.if takes the truthy
    // branch on the same expression, which is exactly the bug the
    // shared helper exists to prevent.
    it.each([
        ['', false],
        ['false', false],
        ['0', false],
        ['undefined', false],
        ['null', false],
        ['true', true],
        ['1', true],
        ['some text', true],
        ['False', true],     // case-sensitive on purpose — only the literal 'false' is falsy
        ['0.0', true],       // not 0
        [' ', true],         // whitespace ≠ empty
    ])('isStringTruthy(%j) === %s', (input, expected) => {
        expect(isStringTruthy(input)).toBe(expected);
    });
});
