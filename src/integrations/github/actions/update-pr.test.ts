import { describe, it, expect, vi, beforeEach } from 'vitest';
import { githubUpdatePrAction, emptyToUndef, validateState, VALID_PR_STATES } from './update-pr.js';
import { makeContext, mockFetch } from './_test-helpers.js';

beforeEach(() => {
    vi.restoreAllMocks();
});

// ── Pure-function unit tests ──────────────────────────────────────────────
//
// These complement the integration tests below. The integration path
// only exercises one combination of inputs at a time; unit tests pin
// every branch of the validation helpers exhaustively, so a refactor
// that changes the contract has nowhere to hide.

describe('emptyToUndef', () => {
    it('returns undefined for empty string', () => {
        expect(emptyToUndef('')).toBeUndefined();
    });

    it('returns the string unchanged for non-empty input', () => {
        expect(emptyToUndef('text')).toBe('text');
        expect(emptyToUndef(' ')).toBe(' '); // whitespace is preserved on purpose
        expect(emptyToUndef('0')).toBe('0'); // string "0" is not empty
    });

    it('returns undefined for non-string input (number, boolean, null, object)', () => {
        // Without the typeof check, an upstream wire producing a number
        // or boolean would be coerced to its String() form by the API
        // client — silently retitling/blanking the PR with garbage.
        expect(emptyToUndef(42)).toBeUndefined();
        expect(emptyToUndef(true)).toBeUndefined();
        expect(emptyToUndef(false)).toBeUndefined();
        expect(emptyToUndef(null)).toBeUndefined();
        expect(emptyToUndef(undefined)).toBeUndefined();
        expect(emptyToUndef({})).toBeUndefined();
    });
});

describe('validateState', () => {
    it('passes through every state in VALID_PR_STATES', () => {
        for (const state of VALID_PR_STATES) {
            expect(validateState(state)).toBe(state);
        }
        // Sanity check that the canonical set hasn't quietly grown to
        // include unsupported values like 'merged' or 'draft'.
        expect([...VALID_PR_STATES]).toEqual(['open', 'closed']);
    });

    it('returns undefined when given undefined (no state change requested)', () => {
        expect(validateState(undefined)).toBeUndefined();
    });

    it('throws on values outside the whitelist', () => {
        // 'draft' is GitHub's UI term but isn't a writable state via
        // PATCH /pulls/:n. 'merged' isn't writable either. Accept these
        // and the API would 422 with an opaque error.
        expect(() => validateState('draft')).toThrow(/state must be one of open, closed.*draft/);
        expect(() => validateState('merged')).toThrow(/state must be one of/);
        expect(() => validateState('opened')).toThrow(/state must be one of/); // typo of 'open'
        expect(() => validateState('')).toThrow(/state must be one of/);
        expect(() => validateState('OPEN')).toThrow(/state must be one of/); // case-sensitive
    });
});

// ── Integration tests through the full handler ────────────────────────────

describe('github-update-pr (handler)', () => {
    it('PATCHes only the supplied fields', async () => {
        const spy = mockFetch([
            () => new Response(JSON.stringify({ html_url: 'https://github.com/octo/r/pull/42', state: 'closed' }), { status: 200 }),
        ]);
        const result = await githubUpdatePrAction(
            { pr_number: 42, repo: 'octo/r', state: 'closed' },
            makeContext(),
        );
        const [url, init] = spy.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/repos/octo/r/pulls/42');
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ state: 'closed' });
        expect(result).toMatchObject({ url: 'https://github.com/octo/r/pull/42', state: 'closed', number: 42 });
    });

    it('omits empty/undefined fields from the PATCH body', async () => {
        const spy = mockFetch([() => new Response(JSON.stringify({ html_url: 'x', state: 'open' }), { status: 200 })]);
        await githubUpdatePrAction({ pr_number: 42, repo: 'octo/r', title: 'New title' }, makeContext());
        const init = spy.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ title: 'New title' });
    });

    it('throws when no field is supplied (empty-body guard)', async () => {
        // No fetch should happen — the guard fires before the API call.
        const spy = mockFetch([() => new Response('{}', { status: 200 })]);
        await expect(
            githubUpdatePrAction({ pr_number: 42, repo: 'octo/r' }, makeContext()),
        ).rejects.toThrow(/at least one of title\/body\/state\/base/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('treats empty-string fields as "no change" instead of forwarding them', async () => {
        // The legacy steps executor doesn't filter empty interpolation
        // results; defending in the handler protects callers from
        // silently blanking the PR body when an upstream {{...}} fails
        // to resolve.
        const spy = mockFetch([
            () => new Response(JSON.stringify({ html_url: 'x', state: 'open' }), { status: 200 }),
        ]);
        await githubUpdatePrAction(
            { pr_number: 42, repo: 'octo/r', title: 'Real title', body: '', state: '', base: '' },
            makeContext(),
        );
        const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit)?.body ?? '{}'));
        expect(body).toEqual({ title: 'Real title' });
    });

    it('rejects an all-empty payload with the no-fields error, not the empty-title error', async () => {
        // After emptyToUndef normalization, every field is undefined →
        // the API client's "at least one of …" guard fires with the
        // clearer message instead of the lower-level "title must not be
        // empty" error.
        const spy = mockFetch([() => new Response('{}', { status: 200 })]);
        await expect(
            githubUpdatePrAction(
                { pr_number: 42, repo: 'octo/r', title: '', body: '', state: '', base: '' },
                makeContext(),
            ),
        ).rejects.toThrow(/at least one of title\/body\/state\/base/);
        expect(spy).not.toHaveBeenCalled();
    });

    it('drops non-string field values (number/boolean/null) instead of forwarding them', async () => {
        const spy = mockFetch([
            () => new Response(JSON.stringify({ html_url: 'x', state: 'open' }), { status: 200 }),
        ]);
        await githubUpdatePrAction(
            // Cast through unknown to reflect what could arrive from a
            // wired upstream port at runtime. Non-string state goes
            // through emptyToUndef → undefined before reaching
            // validateState, so it's dropped, not rejected.
            { pr_number: 42, repo: 'octo/r', title: 'Real title', body: 42 as unknown as string, state: false as unknown as string, base: null as unknown as string },
            makeContext(),
        );
        const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit)?.body ?? '{}'));
        expect(body).toEqual({ title: 'Real title' });
    });

    it('rejects an unknown state value with a clear error (not an opaque 422 from GitHub)', async () => {
        const spy = mockFetch([() => new Response('{}', { status: 200 })]);
        await expect(
            githubUpdatePrAction(
                { pr_number: 42, repo: 'octo/r', state: 'draft' },
                makeContext(),
            ),
        ).rejects.toThrow(/state must be one of open, closed.*draft/);
        expect(spy).not.toHaveBeenCalled();
    });
});
