// Shared test fixtures for the GitHub action handler test suites.
// Co-locating makeContext + mockFetch here keeps the per-handler test
// files (merge-pr.test.ts, update-pr.test.ts, round-trip.test.ts) on
// the same setup so a context-shape change touches one place. The `_`
// prefix matches the existing convention (see `_target.ts`) signalling
// "internal helper, not a public action handler."

import { vi } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';

const logger = pino({ level: 'silent' });

export function makeContext(overrides?: Partial<ActionContext>): ActionContext {
    return {
        event: {
            source: 'github',
            event: 'pull_request.opened',
            timestamp: '2026-05-04T00:00:00Z',
            payload: { pull_request: { number: 42 } },
            metadata: { repo: 'octo/r', owner: 'octo', repoName: 'r', prNumber: 42 },
        },
        results: {},
        steps: {},
        integrationConfigs: { github: { token: 'gh_test_token' } },
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        workflowName: 'test',
        ...overrides,
    } as unknown as ActionContext;
}

/** Drop-in for `globalThis.fetch`. Each call advances through the
 *  handlers list; once exhausted, the last handler is reused so a test
 *  doesn't need to enumerate every poll round. Returns the spy so
 *  individual tests can assert on call counts and payloads. */
export function mockFetch(handlers: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>) {
    let i = 0;
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = extractFetchUrl(input);
        const handler = handlers[Math.min(i, handlers.length - 1)];
        i++;
        return handler(url);
    });
}

/** Pull the URL out of any of `fetch`'s three accepted input shapes.
 *  `Request.toString()` returns `[object Request]`, so the previous
 *  `(input as URL).toString()` cast would silently produce that string
 *  if a caller ever switched to passing a Request — URL assertions in
 *  tests would then either fail mysteriously or pass against the
 *  bogus value. fetchWithTimeout only takes `string | URL` today, but
 *  the mock should stay correct under future refactors.
 *
 *  Typed as `unknown` rather than the DOM `RequestInfo | URL` because
 *  the tsconfig doesn't include the DOM lib; the runtime checks below
 *  are exhaustive across all three shapes the fetch API accepts. */
function extractFetchUrl(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    // `Request` exists in the global scope at runtime (Node 18+ / browser)
    // but may not be declared at the type level. Guard against the
    // referenceError before using `instanceof`.
    const RequestCtor = (globalThis as { Request?: new (...args: unknown[]) => unknown }).Request;
    if (RequestCtor && input instanceof RequestCtor) {
        return (input as { url: string }).url;
    }
    return String(input);
}
