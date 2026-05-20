import { describe, it, expect } from 'vitest';
import { mockFetch } from './_test-helpers.js';

// Regression coverage for the URL extraction in `mockFetch`. The shared
// mock used to do `(input as URL).toString()` for non-string inputs,
// which silently produced `[object Request]` if any code path ever
// passed a `Request` to fetch. URL assertions across the GitHub test
// suite would then either fail mysteriously or pass against the bogus
// string. The current implementation handles all three shapes fetch
// accepts (string, URL, Request) so the mock stays robust against
// future refactors of the API client.

describe('mockFetch URL extraction', () => {
    it('returns a string URL untouched', async () => {
        let captured = '';
        const spy = mockFetch([(url) => {
            captured = url;
            return new Response('', { status: 200 });
        }]);
        try {
            await fetch('https://api.github.com/repos/octo/r');
            expect(captured).toBe('https://api.github.com/repos/octo/r');
        } finally {
            spy.mockRestore();
        }
    });

    it('extracts the URL from a URL instance', async () => {
        let captured = '';
        const spy = mockFetch([(url) => {
            captured = url;
            return new Response('', { status: 200 });
        }]);
        try {
            await fetch(new URL('https://api.github.com/repos/octo/r'));
            expect(captured).toBe('https://api.github.com/repos/octo/r');
        } finally {
            spy.mockRestore();
        }
    });

    it('extracts the URL from a Request instance (not "[object Request]" as the previous cast produced)', async () => {
        // Skip when Request isn't available — Node ≥18 always has it,
        // but defensive against unusual runtimes.
        if (typeof Request === 'undefined') return;
        let captured = '';
        const spy = mockFetch([(url) => {
            captured = url;
            return new Response('', { status: 200 });
        }]);
        try {
            await fetch(new Request('https://api.github.com/repos/octo/r'));
            expect(captured).toBe('https://api.github.com/repos/octo/r');
        } finally {
            spy.mockRestore();
        }
    });
});
