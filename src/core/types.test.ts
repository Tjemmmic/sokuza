import { describe, it, expect } from 'vitest';
import { toArray } from './types.js';

describe('toArray', () => {
    it('returns empty array for undefined', () => {
        expect(toArray(undefined)).toEqual([]);
    });

    it('returns empty array for null', () => {
        expect(toArray(null as unknown as undefined)).toEqual([]);
    });

    it('wraps a single string in an array', () => {
        expect(toArray('github')).toEqual(['github']);
    });

    it('wraps a single number in an array', () => {
        expect(toArray(42)).toEqual([42]);
    });

    it('returns the same array when given an array', () => {
        expect(toArray(['a', 'b'])).toEqual(['a', 'b']);
    });

    it('returns empty array as-is', () => {
        expect(toArray([])).toEqual([]);
    });

    it('handles boolean values', () => {
        expect(toArray(true)).toEqual([true]);
        expect(toArray(false)).toEqual([false]);
    });
});
