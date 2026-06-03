import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import pino from 'pino';
import { GitHubPollIntegration } from '../integrations/github-poll/index.js';
import type { EventPayload } from '../core/types.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Pino logger set to `silent` — same interface the engine passes in
 *  production, just with no output. Lets the integration call
 *  `this.logger.error(...)` without crashing on `undefined.error`. */
const TEST_LOGGER = pino({ level: 'silent' });

function makePr(overrides: Record<string, unknown> = {}) {
    return {
        number: 1,
        state: 'open',
        head: { sha: 'abc123' },
        base: { ref: 'main' },
        user: { login: 'alice' },
        labels: [],
        merged_at: null,
        ...overrides,
    };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
    return {
        number: 10,
        state: 'open',
        user: { login: 'bob' },
        labels: [],
        ...overrides,
    };
}

function makeBranch(name: string, sha: string) {
    return { name, commit: { sha } };
}

function makeComment(id: number, issueNumber: number) {
    return {
        id,
        body: `Comment ${id}`,
        user: { login: 'commenter' },
        issue_url: `https://api.github.com/repos/org/repo/issues/${issueNumber}`,
    };
}

/**
 * Create a poll integration with mocked fetch and run N poll cycles.
 * `apiResponses` is called on each fetch with the URL to return mock data.
 */
async function setupAndPoll(opts: {
    events?: string[];
    repos?: string[];
    apiResponses: (url: string) => unknown;
    pollCycles?: number;
}): Promise<EventPayload[]> {
    const emitted: EventPayload[] = [];

    const integration = new GitHubPollIntegration();
    await integration.initialize({
        token: 'test-token',
        repos: opts.repos ?? ['org/repo'],
        events: opts.events,
    }, TEST_LOGGER);

    // Wire onEvent directly without going through registerRoutes/stop.
    // The previous pattern (registerRoutes to wire onEvent, then stop()
    // to halt the 2s startup timer) is incompatible with the new
    // cooperative-cancellation check at the top of poll()'s loop —
    // `stop()` flips `this.stopped` and the next manually-driven
    // `poll()` would bail immediately. Setting onEvent directly skips
    // both the timer scheduling and the stopped flag.
    (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
        .onEvent = async (event) => { emitted.push(event); };

    // Mock global fetch
    const fetchMock = vi.fn(async (url: string | URL | Request) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => opts.apiResponses(String(url)),
    })) as unknown as typeof globalThis.fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
        const cycles = opts.pollCycles ?? 2; // 1 = seed, 2+ = emit
        for (let i = 0; i < cycles; i++) {
            // Access private poll() via bracket notation
            await (integration as any).poll();
        }
    } finally {
        globalThis.fetch = originalFetch;
    }

    return emitted;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('GitHubPollIntegration', () => {
    // Restore globalThis.fetch after every test. The `makeIntegrationWithOrgs`
    // and state-pruning `makeIntegration` helpers below install a mock
    // without an explicit cleanup of their own (the per-test try/finally
    // pattern only covers tests that drive their own fetch directly).
    // Without this guard, a leftover mock from one test could silently be
    // inherited by another if test ordering changed or a new test added
    // upstream forgot to install its own.
    const _origFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = _origFetch; });

    describe('initialization', () => {
        it('should throw if token is missing', async () => {
            const integration = new GitHubPollIntegration();
            await expect(
                integration.initialize({ repos: ['org/repo'] }, TEST_LOGGER),
            ).rejects.toThrow('token is required');
        });

        it('should throw if both repos and orgs are empty', async () => {
            // Validation widened to accept either source — but at least
            // one of them must be supplied, otherwise there's nothing
            // for the poll loop to iterate over.
            const integration = new GitHubPollIntegration();
            await expect(
                integration.initialize({ token: 'tok', repos: [] }, TEST_LOGGER),
            ).rejects.toThrow('at least one of `repos` or `orgs`');
        });

        it('accepts orgs-only config (no explicit repos)', async () => {
            // The new path: a user wants to watch all repos in an org
            // without listing them. Validation must accept this even
            // though `repos` is empty / unset.
            const integration = new GitHubPollIntegration();
            await expect(
                integration.initialize({ token: 'tok', orgs: ['my-org'] }, TEST_LOGGER),
            ).resolves.toBeUndefined();
        });

        it('rejects an orgs-only config whose entries are all empty / whitespace', async () => {
            // Without cleaning, `orgs: ['']` slips past `orgs?.length > 0`
            // (length is 1) and surfaces at request time as `/orgs//repos`
            // which 404s — noise the user didn't intend. Validation must
            // run against the cleaned list so this rejects with the same
            // "at least one of repos or orgs" message as `orgs: []`.
            const integration = new GitHubPollIntegration();
            await expect(
                integration.initialize({ token: 'tok', orgs: ['', '  '] }, TEST_LOGGER),
            ).rejects.toThrow('at least one of `repos` or `orgs`');
        });

        it('trims and dedupes org names so refresh hits each org exactly once', async () => {
            // Duplicate `orgs: ['my-org', 'my-org']` or padded
            // `orgs: [' my-org ', 'my-org']` would burn API quota
            // re-enumerating the same org on every refresh. Pin that the
            // cleaned list collapses to one entry.
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                orgs: [' my-org ', 'my-org', '', 'other-org'],
            }, TEST_LOGGER);
            // No public accessor — read the private field via bracket
            // notation. The cleaned list is what `refreshOrgRepos` iterates,
            // so this is the user-visible behavior even if it goes through
            // a private field.
            expect((integration as any).orgs).toEqual(['my-org', 'other-org']);
        });

        it('trims and dedupes repos the same way orgs are cleaned', async () => {
            // The orgs path goes through trim+filter+dedupe; repos should
            // get the same treatment for consistency. Empty/whitespace
            // entries are no-op'd at poll time by the owner/repo split
            // guard but appear in `allRepos()` output and any log statement
            // that includes the repo key — the inconsistency is surprising.
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                repos: [' owner/alpha ', 'owner/alpha', '', 'owner/beta'],
            }, TEST_LOGGER);
            // explicitRepos is the cleaned set; the union returned by
            // allRepos() is what poll() iterates.
            const explicit = (integration as any).explicitRepos as Set<string>;
            expect(explicit.size).toBe(2);
            expect(explicit.has('owner/alpha')).toBe(true);
            expect(explicit.has('owner/beta')).toBe(true);
        });

        it('rejects a repos-only config whose entries are all empty / whitespace', async () => {
            // Symmetric with the orgs-empty rejection: after cleaning, if
            // both cleaned lists are empty there is nothing to watch and
            // validation must fail.
            const integration = new GitHubPollIntegration();
            await expect(
                integration.initialize({ token: 'tok', repos: ['', '   '] }, TEST_LOGGER),
            ).rejects.toThrow('at least one of `repos` or `orgs`');
        });

        it('initialize() resets stopped/refreshing/polling so an instance can be reused after stop()', async () => {
            // Engine config hot-reload may call stop() then initialize()
            // on the same integration object rather than constructing
            // a fresh one. Without resetting the lifecycle flags,
            // `this.stopped === true` would persist and the next
            // registerRoutes' 2s setTimeout would bail at its first
            // check, leaving the integration silently dead.
            const integration = new GitHubPollIntegration();
            await integration.initialize({ token: 'tok', orgs: ['my-org'] }, TEST_LOGGER);
            integration.stop();
            expect((integration as any).stopped).toBe(true);

            // Force the other two flags to true so the test verifies
            // ALL three are reset (not just stopped).
            (integration as any).refreshing = true;
            (integration as any).polling = true;

            await integration.initialize({ token: 'tok', orgs: ['my-org'] }, TEST_LOGGER);
            expect((integration as any).stopped).toBe(false);
            expect((integration as any).refreshing).toBe(false);
            expect((integration as any).polling).toBe(false);
        });

        it('initialize() resets orgRepos so stale entries from a previous config do not leak into the new watch set', async () => {
            // Sister to the lifecycle-flag reset above. The reuse path
            // also has to drop stale per-org enumeration results,
            // otherwise `allRepos()` unions them into the watch set
            // indefinitely and they're polled forever — `refreshOrgRepos`
            // only iterates `this.orgs` (the cleaned current list), so
            // it can't see or prune org keys from the previous config.
            const integration = new GitHubPollIntegration();
            await integration.initialize({ token: 'tok', orgs: ['old-org'] }, TEST_LOGGER);

            // Simulate a refresh having populated old-org's set.
            (integration as any).orgRepos.set('old-org', new Set(['old-org/legacy-a', 'old-org/legacy-b']));
            expect(((integration as any).allRepos() as Set<string>).has('old-org/legacy-a')).toBe(true);

            integration.stop();
            // Re-initialize with a completely different org. Without the
            // reset, the next allRepos() would still return both
            // old-org/* entries via `orgRepos` plus the new explicit
            // repos — polling repos the user no longer wants to watch.
            await integration.initialize({ token: 'tok', orgs: ['new-org'] }, TEST_LOGGER);
            const watched = (integration as any).allRepos() as Set<string>;
            expect(watched.has('old-org/legacy-a')).toBe(false);
            expect(watched.has('old-org/legacy-b')).toBe(false);
            expect((integration as any).orgRepos.size).toBe(0);
        });

        it('initialize() resets per-repo state so stale seededRepos/lastXxxIds entries from a previous config do not survive a reload', async () => {
            // Sister to the lifecycle-flag and orgRepos reset tests
            // above. Without resetting `state` too, a reload that drops
            // an org from the config leaves `seededRepos` and
            // `lastXxxIds` populated for the now-untracked repos —
            // they can't be cleaned by `refreshOrgRepos`'s
            // previousUnion-vs-currentUnion diff because the orgRepos
            // reset above shrinks previousUnion before the diff runs
            // (allRepos() = explicitRepos ∪ {} = explicitRepos). On a
            // subsequent reload that re-adds the org,
            // `seededRepos.has(repo)` still returns true and firstSight
            // evaluates to false against a stale snapshot — emitting
            // transition events for every change across the reload gap.
            const integration = new GitHubPollIntegration();
            await integration.initialize({ token: 'tok', orgs: ['old-org'] }, TEST_LOGGER);

            // Simulate a previous cycle having seeded state for old-org's repos.
            const state = (integration as any).state;
            state.seededRepos.add('old-org/legacy-a');
            state.seededRepos.add('old-org/legacy-b');
            state.lastPrIds.set('old-org/legacy-a', new Set([1, 2]));
            state.lastPrHeadShas.set('old-org/legacy-a', new Map([[1, 'sha-1']]));
            state.lastPrStates.set('old-org/legacy-a', new Map([[1, 'open']]));
            state.lastIssueIds.set('old-org/legacy-a', new Set([10]));
            state.lastIssueStates.set('old-org/legacy-a', new Map([[10, 'open']]));
            state.lastBranchShas.set('old-org/legacy-a', new Map([['main', 'sha-main']]));
            state.lastCommentIds.set('old-org/legacy-a', new Set([100]));
            state.lastReviewIds.set('old-org/legacy-a', new Set([1000]));
            expect(state.seededRepos.has('old-org/legacy-a')).toBe(true);
            expect(state.lastPrIds.has('old-org/legacy-a')).toBe(true);

            integration.stop();
            await integration.initialize({ token: 'tok', orgs: ['new-org'] }, TEST_LOGGER);

            const stateAfter = (integration as any).state;
            // Every per-repo map and the seed set should be empty after
            // re-initialize — fresh-construction equivalence.
            expect(stateAfter.seededRepos.size).toBe(0);
            expect(stateAfter.lastPrIds.size).toBe(0);
            expect(stateAfter.lastPrHeadShas.size).toBe(0);
            expect(stateAfter.lastPrStates.size).toBe(0);
            expect(stateAfter.lastIssueIds.size).toBe(0);
            expect(stateAfter.lastIssueStates.size).toBe(0);
            expect(stateAfter.lastBranchShas.size).toBe(0);
            expect(stateAfter.lastCommentIds.size).toBe(0);
            expect(stateAfter.lastReviewIds.size).toBe(0);
        });

        it('apiGetAllPages throws on a non-array body on a subsequent page (preserves prior pages via per-org isolation)', async () => {
            // Pre-existing pagination edge case amplified by the new
            // enumerateOrgRepos caller. If GitHub ever returned 200
            // with a non-array body on page 2 (server contract
            // violation, but possible via proxy/cache corruption), the
            // old code returned that non-array and silently discarded
            // every accumulated page in `all`. Downstream:
            //   - enumerateOrgRepos sees [] and stores an empty set
            //   - refreshOrgRepos diffs previous union against current
            //     and prunes state for every repo that "disappeared"
            //   - next poll re-emits every existing PR/issue/comment
            //     across the entire org as new — the exact flood the
            //     per-repo seeding refactor exists to prevent.
            // Throwing instead lets the per-org catch in
            // refreshOrgRepos preserve the previous set (the documented
            // "transient API hiccup" contract).
            const integration = new GitHubPollIntegration();
            await integration.initialize({ token: 'tok', orgs: ['my-org'] }, TEST_LOGGER);

            const PAGE_1_URL = 'https://api.github.com/orgs/my-org/repos?per_page=100&type=all&sort=updated';
            const PAGE_2_URL = 'https://api.github.com/orgs/my-org/repos?per_page=100&page=2';

            globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                if (s === PAGE_1_URL) {
                    return {
                        ok: true, status: 200, statusText: 'OK',
                        headers: { get: (h: string) => h.toLowerCase() === 'link' ? `<${PAGE_2_URL}>; rel="next"` : null },
                        json: async () => ([{ full_name: 'my-org/page1-a' }, { full_name: 'my-org/page1-b' }]),
                    };
                }
                if (s === PAGE_2_URL) {
                    // Server contract violation: page 2 returns a
                    // single object instead of an array.
                    return {
                        ok: true, status: 200, statusText: 'OK',
                        headers: { get: () => null },
                        json: async () => ({ message: 'something went sideways' }),
                    };
                }
                throw new Error(`unexpected url: ${s}`);
            }) as unknown as typeof globalThis.fetch;

            await expect(
                (integration as any).apiGetAllPages(PAGE_1_URL),
            ).rejects.toThrow(/expected array on subsequent page/i);
        });

        it('apiGetAllPages still allows a non-array body on the FIRST page (single-resource endpoints)', async () => {
            // Sanity: the new guard must only fire on subsequent pages.
            // Endpoints like `/repos/{owner}/{repo}/issues/{n}` return
            // a single object on page 1, and callers downstream expect
            // that object — throwing here would break every
            // single-resource call.
            const integration = new GitHubPollIntegration();
            await integration.initialize({ token: 'tok', orgs: ['my-org'] }, TEST_LOGGER);

            globalThis.fetch = vi.fn(async () => ({
                ok: true, status: 200, statusText: 'OK',
                headers: { get: () => null },
                json: async () => ({ number: 42, title: 'Single issue' }),
            })) as unknown as typeof globalThis.fetch;

            const result = await (integration as any).apiGetAllPages('https://api.github.com/repos/o/r/issues/42');
            expect(result).toEqual({ number: 42, title: 'Single issue' });
        });
    });

    describe('seed run', () => {
        it('should not emit any events on the first poll (seed)', async () => {
            const emitted = await setupAndPoll({
                pollCycles: 1, // Only seed
                apiResponses: (url) => {
                    if (url.includes('/pulls')) return [makePr()];
                    if (url.includes('/issues?')) return [makeIssue()];
                    if (url.includes('/branches')) return [makeBranch('main', 'aaa')];
                    if (url.includes('/comments')) return [makeComment(1, 10)];
                    return [];
                },
            });
            expect(emitted).toHaveLength(0);
        });
    });

    describe('pull_request.opened', () => {
        it('should emit when a new PR appears after seed', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['pull_request.opened'],
                apiResponses: (url) => {
                    if (url.includes('/pulls')) {
                        cycle++;
                        if (cycle <= 1) return []; // Seed: no PRs
                        return [makePr({ number: 5 })]; // New PR appears
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('pull_request.opened');
            expect(emitted[0].payload.number).toBe(5);
            expect(emitted[0].source).toBe('github-poll');
            expect(emitted[0].metadata.repo).toBe('org/repo');
        });
    });

    describe('pull_request.synchronize', () => {
        it('should emit when PR head SHA changes', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['pull_request.synchronize'],
                apiResponses: (url) => {
                    if (url.includes('/pulls')) {
                        cycle++;
                        if (cycle <= 1) return [makePr({ number: 1, head: { sha: 'sha-v1' } })];
                        return [makePr({ number: 1, head: { sha: 'sha-v2' } })]; // SHA changed
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('pull_request.synchronize');
            expect(emitted[0].payload.before).toBe('sha-v1');
            expect(emitted[0].payload.after).toBe('sha-v2');
        });

        it('should NOT emit synchronize for closed PRs with SHA changes', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['pull_request.synchronize'],
                apiResponses: (url) => {
                    if (url.includes('/pulls')) {
                        cycle++;
                        if (cycle <= 1) return [makePr({ number: 1, state: 'closed', head: { sha: 'sha-v1' } })];
                        return [makePr({ number: 1, state: 'closed', head: { sha: 'sha-v2' } })];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(0);
        });
    });

    describe('pull_request.closed', () => {
        it('should emit when PR transitions from open to closed', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['pull_request.closed'],
                apiResponses: (url) => {
                    if (url.includes('/pulls')) {
                        cycle++;
                        if (cycle <= 1) return [makePr({ number: 3, state: 'open' })];
                        return [makePr({ number: 3, state: 'closed' })]; // Closed
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('pull_request.closed');
            expect(emitted[0].payload.action).toBe('closed');
            expect(emitted[0].payload.number).toBe(3);
        });

        it('should emit when PR is merged', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['pull_request.closed'],
                apiResponses: (url) => {
                    if (url.includes('/pulls')) {
                        cycle++;
                        if (cycle <= 1) return [makePr({ number: 3, state: 'open', merged_at: null })];
                        return [makePr({ number: 3, state: 'closed', merged_at: '2026-01-01T00:00:00Z' })];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('pull_request.closed');
        });
    });

    describe('issues.opened', () => {
        it('should emit when a new issue appears', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['issues.opened'],
                apiResponses: (url) => {
                    if (url.includes('/issues?')) {
                        cycle++;
                        if (cycle <= 1) return [];
                        return [makeIssue({ number: 20 })];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('issues.opened');
            expect(emitted[0].payload.issue).toBeDefined();
            expect((emitted[0].payload.issue as any).number).toBe(20);
        });

        it('should skip entries that are pull requests disguised as issues', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['issues.opened'],
                apiResponses: (url) => {
                    if (url.includes('/issues?')) {
                        cycle++;
                        if (cycle <= 1) return [];
                        // GitHub /issues endpoint includes PRs with a pull_request key
                        return [{ ...makeIssue({ number: 30 }), pull_request: { url: '...' } }];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(0);
        });
    });

    describe('issues.closed', () => {
        it('should emit when an issue transitions from open to closed', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['issues.closed'],
                apiResponses: (url) => {
                    if (url.includes('/issues?')) {
                        cycle++;
                        if (cycle <= 1) return [makeIssue({ number: 15, state: 'open' })];
                        return [makeIssue({ number: 15, state: 'closed' })];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('issues.closed');
            expect(emitted[0].payload.action).toBe('closed');
        });

        it('should NOT emit closed for already-closed issues', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['issues.closed'],
                apiResponses: (url) => {
                    if (url.includes('/issues?')) {
                        cycle++;
                        // Issue was closed in both seed and second poll
                        return [makeIssue({ number: 15, state: 'closed' })];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(0);
        });
    });

    describe('issue_comment.created', () => {
        it('should emit when a new comment appears', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['issue_comment.created'],
                apiResponses: (url) => {
                    if (url.includes('/comments')) {
                        cycle++;
                        if (cycle <= 1) return [makeComment(100, 5)];
                        return [makeComment(100, 5), makeComment(101, 5)]; // New comment 101
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('issue_comment.created');
            expect(emitted[0].payload.action).toBe('created');
            expect((emitted[0].payload.comment as any).id).toBe(101);
            expect((emitted[0].payload.issue as any).number).toBe(5);
        });
    });

    describe('push', () => {
        it('should emit when a branch SHA changes', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['push'],
                apiResponses: (url) => {
                    if (url.includes('/branches')) {
                        cycle++;
                        if (cycle <= 1) return [makeBranch('main', 'old-sha')];
                        return [makeBranch('main', 'new-sha')];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].event).toBe('push');
            expect(emitted[0].payload.ref).toBe('refs/heads/main');
            expect(emitted[0].payload.before).toBe('old-sha');
            expect(emitted[0].payload.after).toBe('new-sha');
        });

        it('should emit push for each changed branch independently', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['push'],
                apiResponses: (url) => {
                    if (url.includes('/branches')) {
                        cycle++;
                        if (cycle <= 1) return [
                            makeBranch('main', 'sha-a'),
                            makeBranch('dev', 'sha-b'),
                        ];
                        return [
                            makeBranch('main', 'sha-a-new'),
                            makeBranch('dev', 'sha-b-new'),
                        ];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(2);
            expect(emitted[0].payload.ref).toBe('refs/heads/main');
            expect(emitted[1].payload.ref).toBe('refs/heads/dev');
        });

        it('should NOT emit push if SHA is unchanged', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['push'],
                apiResponses: (url) => {
                    if (url.includes('/branches')) {
                        cycle++;
                        return [makeBranch('main', 'same-sha')]; // Always same
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(0);
        });
    });

    describe('event filtering', () => {
        it('should not poll PRs if no PR events are enabled', async () => {
            let prPolled = false;
            const emitted = await setupAndPoll({
                events: ['push'], // Only push
                apiResponses: (url) => {
                    if (url.includes('/pulls')) {
                        prPolled = true;
                        return [makePr()];
                    }
                    if (url.includes('/branches')) return [makeBranch('main', 'aaa')];
                    return [];
                },
            });

            expect(prPolled).toBe(false);
        });

        it('should not poll comments if issue_comment.created is not enabled', async () => {
            let commentsPolled = false;
            const emitted = await setupAndPoll({
                events: ['issues.opened'], // No comment events
                apiResponses: (url) => {
                    if (url.includes('/comments')) {
                        commentsPolled = true;
                        return [];
                    }
                    if (url.includes('/issues?')) return [];
                    return [];
                },
            });

            expect(commentsPolled).toBe(false);
        });
    });

    describe('event payload shape', () => {
        it('should include source=github-poll and metadata.pollSource', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                events: ['issues.opened'],
                apiResponses: (url) => {
                    if (url.includes('/issues?')) {
                        cycle++;
                        if (cycle <= 1) return [];
                        return [makeIssue({ number: 99 })];
                    }
                    return [];
                },
            });

            expect(emitted).toHaveLength(1);
            expect(emitted[0].source).toBe('github-poll');
            expect(emitted[0].metadata.pollSource).toBe(true);
            expect(emitted[0].metadata.repo).toBe('org/repo');
        });
    });

    describe('error resilience', () => {
        it('should continue polling other repos if one fails', async () => {
            let cycle = 0;
            const emitted = await setupAndPoll({
                repos: ['org/good-repo', 'org/bad-repo'],
                events: ['issues.opened'],
                apiResponses: (url) => {
                    if (url.includes('bad-repo')) throw new Error('API error');
                    if (url.includes('/issues?')) {
                        cycle++;
                        if (cycle <= 1) return [];
                        return [makeIssue({ number: 1 })];
                    }
                    return [];
                },
            });

            // Should still get the event from good-repo
            expect(emitted).toHaveLength(1);
        });
    });

    // ─── Org enumeration ────────────────────────────────────────────────────
    //
    // The integration polls a union of `config.repos` (explicit list) and
    // `config.orgs` (auto-enumerated via /orgs/{org}/repos). The enumeration
    // happens in registerRoutes (after server boot), which the existing
    // setupAndPoll helper bypasses by driving poll() directly. These tests
    // drive `refreshOrgRepos()` explicitly so we can observe the resulting
    // watch set without spinning up a real timer.

    describe('org enumeration', () => {
        async function makeIntegrationWithOrgs(opts: {
            repos?: string[];
            orgs?: string[];
            apiResponses: (url: string) => unknown;
        }): Promise<{ integration: GitHubPollIntegration; emitted: EventPayload[] }> {
            const emitted: EventPayload[] = [];
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                repos: opts.repos,
                orgs: opts.orgs,
            }, TEST_LOGGER);
            // Skip registerRoutes — its 2s startup setTimeout would either
            // need clearing via stop() (which now sets the `stopped` flag
            // that the new cooperative-cancellation path in
            // refreshOrgRepos respects, blocking the manual drive
            // below) or fake timers. Directly wiring onEvent matches the
            // production observable behaviour (event emission) without
            // touching the timer lifecycle the tests aren't here to exercise.
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async (e) => { emitted.push(e); };

            const fetchMock = vi.fn(async (url: string | URL | Request) => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => null },
                json: async () => opts.apiResponses(String(url)),
            })) as unknown as typeof globalThis.fetch;
            globalThis.fetch = fetchMock;

            return { integration, emitted };
        }

        it('enumerates /orgs/{org}/repos and adds them to the watch set', async () => {
            const { integration } = await makeIntegrationWithOrgs({
                orgs: ['my-org'],
                apiResponses: (url) => {
                    if (url.includes('/orgs/my-org/repos')) {
                        return [
                            { full_name: 'my-org/alpha' },
                            { full_name: 'my-org/beta' },
                        ];
                    }
                    return [];
                },
            });

            await (integration as any).refreshOrgRepos();
            const watched = (integration as any).allRepos() as Set<string>;

            expect(watched.has('my-org/alpha')).toBe(true);
            expect(watched.has('my-org/beta')).toBe(true);
            expect(watched.size).toBe(2);
        });

        it('merges explicit repos with enumerated org repos (dedup on overlap)', async () => {
            // Real-world setup: a workflow watches a specific repo plus
            // the rest of an org. The watch set must be the union, with
            // overlap deduplicated so the poll loop doesn't hit the same
            // repo twice per cycle.
            const { integration } = await makeIntegrationWithOrgs({
                repos: ['my-org/alpha', 'other-org/standalone'],
                orgs: ['my-org'],
                apiResponses: (url) => {
                    if (url.includes('/orgs/my-org/repos')) {
                        return [
                            { full_name: 'my-org/alpha' },     // overlap
                            { full_name: 'my-org/beta' },
                        ];
                    }
                    return [];
                },
            });

            await (integration as any).refreshOrgRepos();
            const watched = (integration as any).allRepos() as Set<string>;

            expect(watched.has('my-org/alpha')).toBe(true);
            expect(watched.has('my-org/beta')).toBe(true);
            expect(watched.has('other-org/standalone')).toBe(true);
            expect(watched.size).toBe(3);
        });

        it('REPLACES (not merges) per-org sets on refresh — removed repos drop out', async () => {
            // The point of refresh: if a repo is removed from the org or
            // made private, it should stop being polled. Implemented by
            // REPLACING the org's Set on each refresh, not accumulating.
            // Without this guard, a deleted-and-recreated repo would be
            // permanently watched even after admin action.
            let call = 0;
            const { integration } = await makeIntegrationWithOrgs({
                orgs: ['my-org'],
                apiResponses: (url) => {
                    if (!url.includes('/orgs/my-org/repos')) return [];
                    call++;
                    if (call === 1) {
                        return [
                            { full_name: 'my-org/alpha' },
                            { full_name: 'my-org/beta' },
                        ];
                    }
                    // Second call: beta is gone (deleted / made private).
                    return [{ full_name: 'my-org/alpha' }];
                },
            });

            await (integration as any).refreshOrgRepos();
            expect(((integration as any).allRepos() as Set<string>).size).toBe(2);

            await (integration as any).refreshOrgRepos();
            const watched = (integration as any).allRepos() as Set<string>;
            expect(watched.has('my-org/alpha')).toBe(true);
            expect(watched.has('my-org/beta')).toBe(false);
            expect(watched.size).toBe(1);
        });

        it('keeps the prior org set on refresh failure (transient API error)', async () => {
            // Defense: an org-enumeration failure shouldn't blank the
            // watch list. We log and keep the previous Set so the next
            // poll still has work to do.
            let call = 0;
            const { integration } = await makeIntegrationWithOrgs({
                orgs: ['my-org'],
                apiResponses: (url) => {
                    if (!url.includes('/orgs/my-org/repos')) return [];
                    call++;
                    if (call === 1) {
                        return [{ full_name: 'my-org/alpha' }];
                    }
                    // Second call: simulate transient failure.
                    throw new Error('rate limit exceeded');
                },
            });
            // First refresh succeeds; second throws but is caught.
            await (integration as any).refreshOrgRepos();
            await (integration as any).refreshOrgRepos();

            const watched = (integration as any).allRepos() as Set<string>;
            expect(watched.has('my-org/alpha')).toBe(true);
            expect(watched.size).toBe(1);
        });

        it('isolates one failing org from another (one org down does not blank others)', async () => {
            // Two orgs configured. If the API blows up on the first, the
            // second should still enumerate. Pin this so a future
            // refactor that uses Promise.all instead of sequential
            // iteration would have to deliberately re-add the isolation.
            const { integration } = await makeIntegrationWithOrgs({
                orgs: ['bad-org', 'good-org'],
                apiResponses: (url) => {
                    if (url.includes('/orgs/bad-org/repos')) {
                        throw new Error('API error');
                    }
                    if (url.includes('/orgs/good-org/repos')) {
                        return [{ full_name: 'good-org/healthy' }];
                    }
                    return [];
                },
            });

            await (integration as any).refreshOrgRepos();
            const watched = (integration as any).allRepos() as Set<string>;
            expect(watched.has('good-org/healthy')).toBe(true);
            expect(watched.size).toBe(1);
        });

        it('excludes archived repos from the watch set', async () => {
            // Archived repos are immutable — no PR/issue/push events
            // possible — but each one still costs 5 API calls per poll
            // cycle. For orgs with deep history (often 10:1 archived
            // ratio) this can dominate the rate-limit budget. Filtered
            // at enumeration time so they never enter `orgRepos`.
            const { integration } = await makeIntegrationWithOrgs({
                orgs: ['my-org'],
                apiResponses: (url) => {
                    if (url.includes('/orgs/my-org/repos')) {
                        return [
                            { full_name: 'my-org/active', archived: false },
                            { full_name: 'my-org/dormant', archived: true },
                            { full_name: 'my-org/legacy', archived: true },
                            { full_name: 'my-org/current' }, // no archived field
                        ];
                    }
                    return [];
                },
            });

            await (integration as any).refreshOrgRepos();
            const watched = (integration as any).allRepos() as Set<string>;

            expect(watched.has('my-org/active')).toBe(true);
            expect(watched.has('my-org/current')).toBe(true);
            expect(watched.has('my-org/dormant')).toBe(false);
            expect(watched.has('my-org/legacy')).toBe(false);
            expect(watched.size).toBe(2);
        });

        // Regression guard: enumerateOrgRepos delegates pagination to the
        // shared `apiGetAllPages` helper, which walks `Link: rel="next"`.
        // The other org tests use a no-Link mock so they never exercise
        // the multi-page path — if a refactor ever single-pages the
        // helper (or the caller bypasses it), every test above would
        // still pass while orgs with >100 repos silently lose the tail.
        // This test wires fetch with a chained Link header to prove the
        // walk happens end-to-end.
        it('follows GitHub Link headers to accumulate org repos across pages', async () => {
            const integration = new GitHubPollIntegration();
            await integration.initialize({ token: 'tok', orgs: ['huge-org'] }, TEST_LOGGER);
            // Skip registerRoutes/stop — driving refreshOrgRepos
            // directly. See note in makeIntegrationWithOrgs.

            const PAGE_1_URL = 'https://api.github.com/orgs/huge-org/repos?per_page=100&type=all&sort=updated';
            const PAGE_2_URL = 'https://api.github.com/orgs/huge-org/repos?per_page=100&page=2';
            const PAGE_3_URL = 'https://api.github.com/orgs/huge-org/repos?per_page=100&page=3';

            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                // Each page returns 2 stub repos + a Link header pointing
                // at the next page until the third (terminal) page.
                if (s === PAGE_1_URL) {
                    return {
                        ok: true, status: 200, statusText: 'OK',
                        headers: { get: (h: string) => h.toLowerCase() === 'link' ? `<${PAGE_2_URL}>; rel="next"` : null },
                        json: async () => ([{ full_name: 'huge-org/p1a' }, { full_name: 'huge-org/p1b' }]),
                    };
                }
                if (s === PAGE_2_URL) {
                    return {
                        ok: true, status: 200, statusText: 'OK',
                        headers: { get: (h: string) => h.toLowerCase() === 'link' ? `<${PAGE_3_URL}>; rel="next"` : null },
                        json: async () => ([{ full_name: 'huge-org/p2a' }, { full_name: 'huge-org/p2b' }]),
                    };
                }
                if (s === PAGE_3_URL) {
                    return {
                        ok: true, status: 200, statusText: 'OK',
                        headers: { get: () => null }, // terminal page — no next
                        json: async () => ([{ full_name: 'huge-org/p3a' }]),
                    };
                }
                throw new Error(`unexpected url in pagination test: ${s}`);
            }) as unknown as typeof globalThis.fetch;
            globalThis.fetch = fetchMock;

            await (integration as any).refreshOrgRepos();
            const watched = (integration as any).allRepos() as Set<string>;

            // All five repos from the three pages must end up in the
            // watch set. If pagination is broken, only p1a + p1b appear
            // and this test fails loudly.
            expect(watched.has('huge-org/p1a')).toBe(true);
            expect(watched.has('huge-org/p1b')).toBe(true);
            expect(watched.has('huge-org/p2a')).toBe(true);
            expect(watched.has('huge-org/p2b')).toBe(true);
            expect(watched.has('huge-org/p3a')).toBe(true);
            expect(watched.size).toBe(5);

            // …and we made exactly three fetch calls — one per page.
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });
    });

    // ─── Shutdown lifecycle ─────────────────────────────────────────────────
    //
    // registerRoutes defers its first refresh+poll by 2s via setTimeout so the
    // server has time to finish booting. The handle was previously discarded,
    // so a synchronous `stop()` within the 2s window — which is exactly what
    // setupAndPoll, makeIntegrationWithOrgs, and any fast graceful shutdown
    // do — would NOT cancel the callback. It would fire at +2s on a stopped
    // instance, issue a network call, and re-arm both intervals that stop()
    // had no way to clear. Pin the fix so a future refactor can't reintroduce
    // the race.

    describe('shutdown', () => {
        it('stop() during the 2s startup window halts the deferred refresh + intervals', async () => {
            vi.useFakeTimers();
            try {
                const integration = new GitHubPollIntegration();
                await integration.initialize({
                    token: 'tok',
                    orgs: ['my-org'],
                    org_refresh: 10,
                    interval: 5,
                }, TEST_LOGGER);
                integration.registerRoutes({} as any, async () => { /* noop */ });
                integration.stop();

                // Install the fetch spy AFTER stop() so we observe only
                // requests that were issued *after* the stop. If the
                // deferred callback weren't guarded, the 2s timer would
                // call refreshOrgRepos() → fetch, and the subsequent
                // intervals would issue further polls.
                const fetchMock = vi.fn(async () => ({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: { get: () => null },
                    json: async () => [],
                })) as unknown as typeof globalThis.fetch;
                const originalFetch = globalThis.fetch;
                globalThis.fetch = fetchMock;

                try {
                    // Advance well past the 2s startup timer AND the 5s
                    // poll interval AND the 10s org-refresh interval.
                    await vi.advanceTimersByTimeAsync(20_000);

                    expect(fetchMock).not.toHaveBeenCalled();
                    expect((integration as any).timer).toBeNull();
                    expect((integration as any).orgRefreshTimer).toBeNull();
                    expect((integration as any).startupTimer).toBeNull();
                    expect((integration as any).stopped).toBe(true);
                } finally {
                    globalThis.fetch = originalFetch;
                }
            } finally {
                vi.useRealTimers();
            }
        });

        it('stop() is idempotent and safe to call twice', async () => {
            // Defensive: graceful shutdown might call stop() multiple times
            // through different cleanup paths. Make sure the second call
            // doesn't throw on already-cleared handles.
            const integration = new GitHubPollIntegration();
            await integration.initialize({ token: 'tok', orgs: ['my-org'] }, TEST_LOGGER);
            integration.registerRoutes({} as any, async () => { /* noop */ });
            integration.stop();
            expect(() => integration.stop()).not.toThrow();
        });

        it('stop() called mid-refresh halts further org enumeration', async () => {
            // The shutdown test above proves stop() before the 2s
            // startup timer halts everything. This test proves stop()
            // DURING a refresh — after one org's fetch resolved but
            // before the next has been issued — also bails. Without
            // this cooperative-cancellation point, a stop() during a
            // multi-org enumeration would keep burning API quota and
            // mutating state on a stopped integration.
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                orgs: ['org-a', 'org-b', 'org-c'],
            }, TEST_LOGGER);

            let aResolved: (() => void) | null = null;
            const aPromise = new Promise<void>((r) => { aResolved = r; });

            // org-a's fetch suspends until we manually resolve it. That
            // gives us a deterministic window to call stop() while
            // refreshOrgRepos is mid-loop. org-b/org-c should NEVER be
            // fetched after the stop.
            let fetchedOrgs: string[] = [];
            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                const orgMatch = s.match(/\/orgs\/([^/]+)\/repos/);
                if (orgMatch) {
                    const org = orgMatch[1];
                    fetchedOrgs.push(org);
                    if (org === 'org-a') {
                        await aPromise;
                        return jsonOk([{ full_name: 'org-a/repo' }]);
                    }
                    return jsonOk([{ full_name: `${org}/repo` }]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                // Start the refresh; it hangs on org-a's fetch.
                const refreshPromise = (integration as any).refreshOrgRepos();
                // Let microtasks drain so the first fetch is issued.
                await new Promise((r) => setImmediate(r));
                expect(fetchedOrgs).toEqual(['org-a']);

                // Stop mid-flight. The post-await stopped check will
                // discard the response, and the loop top will skip
                // org-b and org-c.
                integration.stop();
                aResolved!();
                await refreshPromise;

                expect(fetchedOrgs).toEqual(['org-a']);
                // org-a's fetched repos were NOT applied because we
                // stopped between the await resolving and the
                // `orgRepos.set` mutation.
                expect((integration as any).orgRepos.size).toBe(0);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('stop() called mid-poll halts further repo iteration', async () => {
            // Symmetric with the refresh-mid-flight test. poll() iterates
            // a snapshot of `allRepos()`; without a cooperative
            // cancellation point it would keep fetching every remaining
            // repo and emitting events into a consumer that may have
            // already torn down. With the guard, the next iteration
            // boundary bails.
            const emitted: EventPayload[] = [];
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                repos: ['org/alpha', 'org/beta', 'org/gamma'],
                events: ['pull_request.opened'],
            }, TEST_LOGGER);
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async (e) => { emitted.push(e); };

            let polledRepos: string[] = [];
            let alphaResolved: (() => void) | null = null;
            const alphaPromise = new Promise<void>((r) => { alphaResolved = r; });

            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                const m = s.match(/\/repos\/(org\/[^/]+)\/pulls/);
                if (m) {
                    const repo = m[1];
                    polledRepos.push(repo);
                    if (repo === 'org/alpha') {
                        await alphaPromise;
                        return jsonOk([]);
                    }
                    return jsonOk([]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                // Start a poll; it suspends inside pollPullRequests for alpha.
                const pollPromise = (integration as any).poll();
                await new Promise((r) => setImmediate(r));
                expect(polledRepos).toEqual(['org/alpha']);

                // Stop mid-poll. The cancellation check at the top of
                // the next iteration must skip beta and gamma.
                integration.stop();
                alphaResolved!();
                await pollPromise;

                expect(polledRepos).toEqual(['org/alpha']);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('stop() called between sub-pollers halts the remaining sub-pollers for the current repo', async () => {
            // Finer-grained than the outer-loop stop-mid-poll test. A
            // stop() that lands AFTER pollPullRequests resolves but
            // BEFORE pollIssues runs used to let the remaining four
            // sub-pollers (issues, push, comments, reviews) fire — each
            // making fetch() calls and possibly emit() against a
            // stopped integration. The pollRepo body now mirrors poll()
            // and refreshOrgRepos's cancellation pattern.
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                repos: ['org/alpha'],
                events: [
                    'pull_request.opened',
                    'issues.opened',
                    'push',
                    'issue_comment.created',
                    'pull_request_review.submitted',
                ],
            }, TEST_LOGGER);
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async () => { /* discard */ };

            let fetchedEndpoints: string[] = [];
            let prResolved: (() => void) | null = null;
            const prPromise = new Promise<void>((r) => { prResolved = r; });

            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                if (s.includes('/repos/org/alpha/pulls') && !s.includes('/reviews')) {
                    fetchedEndpoints.push('pulls');
                    if (!s.includes('state=open')) {
                        // pollPullRequests' /pulls?state=all — suspend so
                        // we can stop() before the next sub-poller fires.
                        await prPromise;
                    }
                    return jsonOk([]);
                }
                if (s.includes('/repos/org/alpha/issues') && !s.includes('/comments')) {
                    fetchedEndpoints.push('issues');
                    return jsonOk([]);
                }
                if (s.includes('/repos/org/alpha/branches')) {
                    fetchedEndpoints.push('branches');
                    return jsonOk([]);
                }
                if (s.includes('/repos/org/alpha/issues/comments')) {
                    fetchedEndpoints.push('comments');
                    return jsonOk([]);
                }
                if (s.includes('/reviews')) {
                    fetchedEndpoints.push('reviews');
                    return jsonOk([]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                const pollPromise = (integration as any).poll();
                await new Promise((r) => setImmediate(r));
                expect(fetchedEndpoints).toEqual(['pulls']);

                // Stop while pollPullRequests is suspended. The check
                // after pollPullRequests' await must bail before
                // pollIssues runs.
                integration.stop();
                prResolved!();
                await pollPromise;

                expect(fetchedEndpoints).toEqual(['pulls']);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });

    // ─── State pruning on org-set churn ─────────────────────────────────────
    //
    // The per-repo state maps (lastPrIds, lastBranchShas, etc.) accumulate
    // keys as new repos enter the watch set. When a repo drops out of an
    // org's enumeration, its keys must be deleted so a long-running process
    // doesn't grow them without bound. Pin two important nuances:
    //
    //   1. State is pruned for repos that fell out of the *union* — i.e.
    //      no other source (explicit list or another org) still watches
    //      them. Pruning per-org would lose state for cross-listed repos.
    //
    //   2. Explicit-list repos are never pruned by org refresh, even if
    //      they happen to overlap with a dropped org repo.

    describe('state pruning on org refresh', () => {
        async function makeIntegration(opts: {
            repos?: string[];
            orgs?: string[];
            apiResponses: (url: string) => unknown;
        }): Promise<GitHubPollIntegration> {
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                repos: opts.repos,
                orgs: opts.orgs,
            }, TEST_LOGGER);
            // Skip registerRoutes — see note in makeIntegrationWithOrgs.
            // These tests drive refreshOrgRepos directly; we don't need
            // the 2s startup timer or a wired onEvent.
            const fetchMock = vi.fn(async (url: string | URL | Request) => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: { get: () => null },
                json: async () => opts.apiResponses(String(url)),
            })) as unknown as typeof globalThis.fetch;
            globalThis.fetch = fetchMock;
            return integration;
        }

        it('frees per-repo state when a repo drops out of an org refresh', async () => {
            let call = 0;
            const integration = await makeIntegration({
                orgs: ['my-org'],
                apiResponses: (url) => {
                    if (!url.includes('/orgs/my-org/repos')) return [];
                    call++;
                    if (call === 1) {
                        return [
                            { full_name: 'my-org/alpha' },
                            { full_name: 'my-org/beta' },
                        ];
                    }
                    // Second refresh: beta has been removed / made private.
                    return [{ full_name: 'my-org/alpha' }];
                },
            });

            // Initial enumeration populates the watch set.
            await (integration as any).refreshOrgRepos();
            // Simulate that the poll loop has already learned state for
            // both repos. Without this, the test is vacuous — `delete` on
            // a key that never existed is a no-op.
            const state = (integration as any).state;
            state.lastPrIds.set('my-org/alpha', new Set([1]));
            state.lastPrIds.set('my-org/beta', new Set([99]));
            state.lastBranchShas.set('my-org/beta', new Map([['main', 'sha-b']]));
            state.lastIssueIds.set('my-org/beta', new Set([7]));

            // Second refresh drops `beta`. State for `beta` (which is no
            // longer in any source) must be cleared. State for `alpha`
            // (still enumerated) must be preserved.
            await (integration as any).refreshOrgRepos();

            expect(state.lastPrIds.has('my-org/alpha')).toBe(true);
            expect(state.lastPrIds.has('my-org/beta')).toBe(false);
            expect(state.lastBranchShas.has('my-org/beta')).toBe(false);
            expect(state.lastIssueIds.has('my-org/beta')).toBe(false);
        });

        it('does NOT prune state for a repo that is still in the explicit list', async () => {
            // Subtle correctness: if the user has BOTH `repos: ['my-org/alpha']`
            // and `orgs: ['my-org']`, then an org refresh that no longer
            // returns alpha must NOT drop alpha's state — alpha is still
            // being polled via the explicit list. A naïve per-org diff
            // would prune it and the next poll would re-emit every PR as
            // "new" since the seeded check would see an empty oldIds.
            let call = 0;
            const integration = await makeIntegration({
                repos: ['my-org/alpha'],
                orgs: ['my-org'],
                apiResponses: (url) => {
                    if (!url.includes('/orgs/my-org/repos')) return [];
                    call++;
                    if (call === 1) {
                        return [{ full_name: 'my-org/alpha' }];
                    }
                    // Second refresh: alpha is private now, but the
                    // explicit `repos` list still watches it.
                    return [];
                },
            });

            await (integration as any).refreshOrgRepos();
            const state = (integration as any).state;
            state.lastPrIds.set('my-org/alpha', new Set([42]));

            await (integration as any).refreshOrgRepos();

            // alpha left the org's set but is still in explicitRepos, so
            // it remains in the union and its state survives.
            expect(state.lastPrIds.has('my-org/alpha')).toBe(true);
            expect(state.lastPrIds.get('my-org/alpha').has(42)).toBe(true);
            expect(((integration as any).allRepos() as Set<string>).has('my-org/alpha')).toBe(true);
        });
    });

    // ─── Per-repo seeding ───────────────────────────────────────────────────
    //
    // Before the per-repo seeding fix, a single global `state.seeded` flag
    // was flipped after the first `poll()` cycle. With the static watch
    // sets the integration used to have, that was correct — every repo
    // was seen on the first cycle. With dynamic org enumeration, a repo
    // that joins the watch set on a *later* refresh would arrive with
    // empty per-repo state but `seeded === true`, and the next poll's
    // "is this PR new?" check would fire `pull_request.opened` for every
    // existing PR on it (same flood for issues/comments/branches).
    // Triggering scenarios: org repo created from template, repo
    // transferred in, private repo flipped public, user adds an org to
    // `config.orgs` mid-run.
    //
    // The fix replaces `state.seeded` with `state.seededRepos: Set<string>`
    // and threads a `firstSight` boolean through every sub-poller. Pin
    // the behaviour end-to-end so a future refactor can't quietly slip
    // back to a global flag.

    describe('per-repo seeding on dynamic watch set', () => {
        it('does NOT emit historical events when a new repo joins the watch set post-startup', async () => {
            // Two refresh cycles: first sees only `my-org/alpha`, second
            // discovers `my-org/beta`. Drive a poll after each. beta's
            // pre-existing PRs/issues/comments must NOT emit on its
            // first poll — that's the whole point of seeding.
            const emitted: EventPayload[] = [];
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                orgs: ['my-org'],
                events: [
                    'pull_request.opened',
                    'issues.opened',
                    'issue_comment.created',
                    'push',
                ],
            }, TEST_LOGGER);
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async (e) => { emitted.push(e); };

            let orgCycle = 0;
            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                if (s.includes('/orgs/my-org/repos')) {
                    orgCycle++;
                    if (orgCycle === 1) return jsonOk([{ full_name: 'my-org/alpha' }]);
                    return jsonOk([
                        { full_name: 'my-org/alpha' },
                        { full_name: 'my-org/beta' },
                    ]);
                }
                if (s.includes('/repos/my-org/alpha/pulls')) {
                    return jsonOk([makePr({ number: 1 })]);
                }
                if (s.includes('/repos/my-org/alpha/issues')) {
                    return jsonOk([makeIssue({ number: 10 })]);
                }
                if (s.includes('/repos/my-org/alpha/branches')) {
                    return jsonOk([makeBranch('main', 'sha-a')]);
                }
                if (s.includes('/repos/my-org/alpha/issues/comments')) {
                    return jsonOk([makeComment(100, 10)]);
                }
                // `beta` has 50 existing PRs and several issues/branches
                // already at the moment it joins the watch set. NONE of
                // these should emit on its first poll.
                if (s.includes('/repos/my-org/beta/pulls')) {
                    return jsonOk(Array.from({ length: 50 }, (_, i) => makePr({ number: i + 1 })));
                }
                if (s.includes('/repos/my-org/beta/issues')) {
                    return jsonOk([makeIssue({ number: 500 }), makeIssue({ number: 501 })]);
                }
                if (s.includes('/repos/my-org/beta/branches')) {
                    return jsonOk([
                        makeBranch('main', 'sha-main'),
                        makeBranch('dev', 'sha-dev'),
                    ]);
                }
                if (s.includes('/repos/my-org/beta/issues/comments')) {
                    return jsonOk([makeComment(9000, 500), makeComment(9001, 501)]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                // Cycle 1: seed alpha. seededRepos becomes {my-org/alpha}.
                await (integration as any).refreshOrgRepos();
                await (integration as any).poll();
                expect(emitted).toHaveLength(0);

                // Cycle 2: beta enters the watch set. Its first poll
                // must SEED (no emissions), not fire pull_request.opened
                // × 50, issues.opened × 2, push × 2, issue_comment ×2.
                await (integration as any).refreshOrgRepos();
                await (integration as any).poll();
                expect(emitted).toHaveLength(0);

                // Sanity check: seededRepos now contains both repos so
                // the NEXT cycle would emit real diffs (this test
                // doesn't drive cycle 3, but the fix's invariant is that
                // both repos are seeded once each).
                const seeded = (integration as any).state.seededRepos as Set<string>;
                expect(seeded.has('my-org/alpha')).toBe(true);
                expect(seeded.has('my-org/beta')).toBe(true);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('emits real events for a known repo on the same cycle that adds a new repo', async () => {
            // Sister case: when a freshly-enumerated repo seeds, the
            // ALREADY-seeded repo on the same poll cycle must continue
            // to emit normally. The fix must not blanket-suppress the
            // whole cycle's emissions.
            const emitted: EventPayload[] = [];
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                orgs: ['my-org'],
                events: ['pull_request.opened'],
            }, TEST_LOGGER);
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async (e) => { emitted.push(e); };

            let orgCycle = 0;
            let alphaPrsSeenInCycle2 = false;
            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                if (s.includes('/orgs/my-org/repos')) {
                    orgCycle++;
                    if (orgCycle === 1) return jsonOk([{ full_name: 'my-org/alpha' }]);
                    return jsonOk([
                        { full_name: 'my-org/alpha' },
                        { full_name: 'my-org/beta' },
                    ]);
                }
                if (s.includes('/repos/my-org/alpha/pulls')) {
                    // Cycle 1: alpha has [1]. Cycle 2: alpha gains PR #2.
                    // PR #2 is genuinely new and must emit.
                    if (!alphaPrsSeenInCycle2) {
                        alphaPrsSeenInCycle2 = true;
                        return jsonOk([makePr({ number: 1 })]);
                    }
                    return jsonOk([makePr({ number: 2 }), makePr({ number: 1 })]);
                }
                if (s.includes('/repos/my-org/beta/pulls')) {
                    // beta has pre-existing PRs — must seed, not flood.
                    return jsonOk([makePr({ number: 99 }), makePr({ number: 100 })]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                await (integration as any).refreshOrgRepos();
                await (integration as any).poll(); // seeds alpha
                expect(emitted).toHaveLength(0);

                await (integration as any).refreshOrgRepos();
                await (integration as any).poll();

                // alpha emits pull_request.opened for PR #2.
                // beta emits nothing — it's seeding.
                expect(emitted).toHaveLength(1);
                expect(emitted[0].event).toBe('pull_request.opened');
                expect(emitted[0].payload.number).toBe(2);
                expect(emitted[0].metadata.repo).toBe('my-org/alpha');
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('treats a repo that left and re-entered the watch set as first-sight again', async () => {
            // Sister to the basic per-repo seeding test. The org-refresh
            // path can REMOVE a repo from the watch set (private flip /
            // deleted / transferred out), then later RE-ADD it. The
            // seededRepos set must be cleared by pruneState; otherwise
            // the re-introduced repo's first poll runs with
            // firstSight=false against empty lastXxxIds maps and floods
            // pull_request.opened / issues.opened / push events for every
            // existing item — the precise flood the per-repo seeding
            // refactor exists to prevent.
            const emitted: EventPayload[] = [];
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                orgs: ['my-org'],
                events: ['pull_request.opened', 'issues.opened', 'push'],
            }, TEST_LOGGER);
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async (e) => { emitted.push(e); };

            let orgCycle = 0;
            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                if (s.includes('/orgs/my-org/repos')) {
                    orgCycle++;
                    if (orgCycle === 1) return jsonOk([{ full_name: 'my-org/beta' }]);
                    if (orgCycle === 2) return jsonOk([]); // beta drops out
                    return jsonOk([{ full_name: 'my-org/beta' }]); // beta returns
                }
                if (s.includes('/repos/my-org/beta/pulls')) {
                    return jsonOk(Array.from({ length: 50 }, (_, i) => makePr({ number: i + 1 })));
                }
                if (s.includes('/repos/my-org/beta/issues')) {
                    return jsonOk([makeIssue({ number: 500 }), makeIssue({ number: 501 })]);
                }
                if (s.includes('/repos/my-org/beta/branches')) {
                    return jsonOk([makeBranch('main', 'sha-main')]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                // Cycle 1: beta enters, seeds silently.
                await (integration as any).refreshOrgRepos();
                await (integration as any).poll();
                expect(emitted).toHaveLength(0);
                expect((integration as any).state.seededRepos.has('my-org/beta')).toBe(true);

                // Cycle 2: beta drops out. pruneState fires for it,
                // which must also drop it from seededRepos.
                await (integration as any).refreshOrgRepos();
                expect((integration as any).state.seededRepos.has('my-org/beta')).toBe(false);
                expect((integration as any).state.lastPrIds.has('my-org/beta')).toBe(false);

                // Cycle 3: beta returns. Its first re-poll must SEED
                // again — not flood 50 PR + 2 issue + 1 push emissions.
                await (integration as any).refreshOrgRepos();
                await (integration as any).poll();
                expect(emitted).toHaveLength(0);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('does NOT resurrect pruned state when refresh runs mid-pollRepo', async () => {
            // Concurrency regression: poll() and refreshOrgRepos() share
            // no mutual-exclusion lock. A pollRepo(X) that's suspended
            // mid-await when a refresh drops X from the watch set used
            // to write the captured snapshot AFTER pruneState(X) had
            // cleared it. State was resurrected and X re-entered
            // `seededRepos`, defeating the per-repo seeding invariant on
            // the next re-entry. Each final state write and the
            // seededRepos.add now re-check `allRepos().has(key)` to
            // detect this and abandon the write.
            //
            // Reproduce: cycle 1 seeds my-org/beta. Cycle 2 starts a
            // poll whose PR-fetch for beta is suspended on a held
            // promise. While suspended, we drive a manual refresh that
            // drops beta and prunes its state. Then resolve the held
            // promise — pollPullRequests for beta finishes and tries to
            // write the snapshot. The guard must block the write.
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                orgs: ['my-org'],
                events: ['pull_request.opened'],
            }, TEST_LOGGER);
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async () => { /* discard */ };

            let orgCycle = 0;
            let betaPullCycle = 0;
            let betaPullResolver: ((value: unknown) => void) | null = null;
            const betaPullPromise = new Promise((r) => { betaPullResolver = r; });

            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                if (s.includes('/orgs/my-org/repos')) {
                    orgCycle++;
                    if (orgCycle === 1) return jsonOk([{ full_name: 'my-org/beta' }]);
                    return jsonOk([]); // beta drops
                }
                if (s.includes('/repos/my-org/beta/pulls')) {
                    betaPullCycle++;
                    if (betaPullCycle === 1) {
                        // Cycle 1: seed normally.
                        return jsonOk([makePr({ number: 1 })]);
                    }
                    // Cycle 2: suspend so the test can drive a refresh
                    // that prunes beta out from under this in-flight poll.
                    await betaPullPromise;
                    return jsonOk([makePr({ number: 1 }), makePr({ number: 2 })]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                // Cycle 1: seed beta normally.
                await (integration as any).refreshOrgRepos();
                await (integration as any).poll();
                expect((integration as any).state.seededRepos.has('my-org/beta')).toBe(true);

                // Start cycle 2's poll — it hangs on beta's PR fetch.
                const pollPromise = (integration as any).poll();
                await new Promise((r) => setImmediate(r));
                // Drive a refresh that drops beta. Pruning fires and
                // clears beta's state + seededRepos.
                await (integration as any).refreshOrgRepos();
                expect((integration as any).state.seededRepos.has('my-org/beta')).toBe(false);
                expect((integration as any).state.lastPrIds.has('my-org/beta')).toBe(false);

                // Release pollPullRequests for beta. Its terminal
                // `lastPrIds.set` and pollRepo's `seededRepos.add` both
                // run AFTER the prune. The guards must abandon both.
                betaPullResolver!(undefined);
                await pollPromise;

                expect((integration as any).state.seededRepos.has('my-org/beta')).toBe(false);
                expect((integration as any).state.lastPrIds.has('my-org/beta')).toBe(false);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('mid-poll guard protects ALL sub-pollers — issues, push, comments, reviews — not just PRs', async () => {
            // The 'resurrect pruned state' test above only enables
            // pull_request.opened, so only `pollPullRequests`' final
            // `if (this.allRepos().has(key))` guard is exercised. The
            // identical guards in pollIssues / pollPushes / pollComments
            // / pollPullRequestReviews are not — a future refactor that
            // removed one of them would not fail any existing test.
            // Pin them end-to-end by enabling every event type, holding
            // a single sub-poller's fetch suspended, pruning the repo
            // mid-flight, then asserting NONE of the lastXxxIds maps
            // were resurrected.
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                orgs: ['my-org'],
                events: [
                    'pull_request.opened',
                    'issues.opened',
                    'push',
                    'issue_comment.created',
                    'pull_request_review.submitted',
                ],
            }, TEST_LOGGER);
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async () => { /* discard */ };

            let orgCycle = 0;
            let betaReviewCycle = 0;
            let reviewResolver: ((value: unknown) => void) | null = null;
            const reviewPromise = new Promise((r) => { reviewResolver = r; });

            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                if (s.includes('/orgs/my-org/repos')) {
                    orgCycle++;
                    if (orgCycle === 1) return jsonOk([{ full_name: 'my-org/beta' }]);
                    return jsonOk([]); // beta drops on cycle 2
                }
                // Sub-poller responses for beta. Suspension is on the
                // LAST sub-poller (PR reviews) so by the time we drive
                // the mid-flight refresh, the other four sub-pollers
                // have already returned and *attempted* their terminal
                // state writes. With the guards, the writes that happen
                // BEFORE the prune succeed (correct — repo was still
                // watched at that moment); the prune then deletes them.
                // The review write that happens AFTER the prune is the
                // critical case, and its guard must prevent the write.
                //
                // To cover ALL FIVE guards in one test we need to drive
                // TWO cycles: cycle 1 seeds beta (so cycle 2 has
                // firstSight=false and would actually do diff writes),
                // cycle 2 is where the race happens.
                if (s.match(/\/repos\/my-org\/beta\/(pulls|issues|branches|issues\/comments)/)) {
                    if (s.endsWith('/pulls')) return jsonOk([makePr({ number: 1 })]);
                    if (s.endsWith('/issues?state=all&sort=updated&direction=desc&per_page=20&filter=all')) return jsonOk([makeIssue({ number: 100 })]);
                    if (s.endsWith('/branches?per_page=50')) return jsonOk([makeBranch('main', 'sha-1')]);
                    if (s.includes('/issues/comments')) return jsonOk([makeComment(5000, 100)]);
                    return jsonOk([]);
                }
                if (s.includes('/repos/my-org/beta/pulls/1/reviews')) {
                    betaReviewCycle++;
                    if (betaReviewCycle === 1) return jsonOk([{ id: 9000 }]);
                    // Cycle 2: suspend on the last sub-poller so we
                    // can drive a refresh that prunes beta mid-flight.
                    await reviewPromise;
                    return jsonOk([{ id: 9001 }]);
                }
                if (s.includes('/repos/my-org/beta/pulls?state=open')) {
                    // pollPullRequestReviews fetches open PRs first.
                    return jsonOk([{ number: 1, head: { sha: 'sha' }, state: 'open' }]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                // Cycle 1: seed all five sub-pollers' state for beta.
                await (integration as any).refreshOrgRepos();
                await (integration as any).poll();
                const state = (integration as any).state;
                expect(state.lastPrIds.has('my-org/beta')).toBe(true);
                expect(state.lastIssueIds.has('my-org/beta')).toBe(true);
                expect(state.lastBranchShas.has('my-org/beta')).toBe(true);
                expect(state.lastCommentIds.has('my-org/beta')).toBe(true);
                expect(state.lastReviewIds.has('my-org/beta')).toBe(true);

                // Cycle 2: start a poll that hangs on the reviews fetch.
                const pollPromise = (integration as any).poll();
                await new Promise((r) => setImmediate(r));

                // Drive a refresh that drops beta and prunes its state.
                await (integration as any).refreshOrgRepos();
                expect(state.lastPrIds.has('my-org/beta')).toBe(false);
                expect(state.lastIssueIds.has('my-org/beta')).toBe(false);
                expect(state.lastBranchShas.has('my-org/beta')).toBe(false);
                expect(state.lastCommentIds.has('my-org/beta')).toBe(false);
                expect(state.lastReviewIds.has('my-org/beta')).toBe(false);

                // Release the suspended reviews fetch. The terminal
                // `lastReviewIds.set` runs AFTER the prune and the
                // guard there must abandon it. Same for the other
                // sub-pollers whose terminal writes had been
                // computing newIds since before the suspension —
                // actually, the other four had already written
                // BEFORE the suspension, so their writes were valid
                // at that time. The prune then deleted everything.
                // Result: none of the state maps should have beta.
                reviewResolver!(undefined);
                await pollPromise;

                expect(state.lastPrIds.has('my-org/beta')).toBe(false);
                expect(state.lastIssueIds.has('my-org/beta')).toBe(false);
                expect(state.lastBranchShas.has('my-org/beta')).toBe(false);
                expect(state.lastCommentIds.has('my-org/beta')).toBe(false);
                expect(state.lastReviewIds.has('my-org/beta')).toBe(false);
                expect(state.seededRepos.has('my-org/beta')).toBe(false);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it('does NOT double-emit when setInterval fires a second poll while the first is mid-flight', async () => {
            // setInterval(() => poll(), N) does not await the previous
            // poll. With dynamic org watch sets this PR introduces, a
            // single cycle (N repos × 5 sub-pollers × per-fetch latency)
            // can routinely outlast `interval`. Without a re-entrance
            // guard, both polls would observe oldIds=[1] for the same
            // repo, both classify PR #2 as new, and both
            // `emit('pull_request.opened', #2)`. The `polling` flag
            // skips the second cycle so each PR transition produces
            // exactly one event.
            //
            // Drive deterministically by suspending the first poll's PR
            // fetch on a held promise, kicking off a second concurrent
            // poll(), then resolving — exactly one emission must result.
            const emitted: EventPayload[] = [];
            const integration = new GitHubPollIntegration();
            await integration.initialize({
                token: 'tok',
                repos: ['org/alpha'],
                events: ['pull_request.opened'],
            }, TEST_LOGGER);
            (integration as unknown as { onEvent: (e: EventPayload) => Promise<void> })
                .onEvent = async (e) => { emitted.push(e); };

            let pullCycle = 0;
            let firstPollResolver: ((value: unknown) => void) | null = null;
            const firstPollPromise = new Promise((r) => { firstPollResolver = r; });
            const fetchMock = vi.fn(async (url: string | URL | Request) => {
                const s = String(url);
                if (s.includes('/repos/org/alpha/pulls')) {
                    pullCycle++;
                    if (pullCycle === 1) {
                        // Seed: alpha has PR #1.
                        return jsonOk([makePr({ number: 1 })]);
                    }
                    if (pullCycle === 2) {
                        // Cycle 2 starts; suspend before responding.
                        await firstPollPromise;
                        return jsonOk([makePr({ number: 2 }), makePr({ number: 1 })]);
                    }
                    // Cycle 3 (would-be overlap): should never run if
                    // the polling guard works. If the guard is broken,
                    // both polls reach here and the test catches it.
                    return jsonOk([makePr({ number: 2 }), makePr({ number: 1 })]);
                }
                return jsonOk([]);
            }) as unknown as typeof globalThis.fetch;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = fetchMock;

            try {
                // Cycle 1: seed alpha. seededRepos becomes {org/alpha}.
                await (integration as any).poll();
                expect(emitted).toHaveLength(0);

                // Cycle 2: starts, hangs on PR fetch (held promise).
                const firstPoll = (integration as any).poll();
                // Let the event loop drain so cycle 2's await is parked.
                await new Promise((r) => setImmediate(r));
                expect((integration as any).polling).toBe(true);

                // Cycle 3 (simulated overlap): setInterval fires while
                // cycle 2 is still suspended. With the guard, this is a
                // no-op. Without it, it would have its own snapshot
                // path and double-emit PR #2.
                const secondPoll = (integration as any).poll();
                await secondPoll;
                // Second poll returned WITHOUT doing any work because
                // polling was already true. Pull cycle counter still 2.
                expect(pullCycle).toBe(2);
                expect(emitted).toHaveLength(0);

                // Release cycle 2; it completes normally and emits #2 once.
                firstPollResolver!(undefined);
                await firstPoll;
                expect(emitted).toHaveLength(1);
                expect(emitted[0].event).toBe('pull_request.opened');
                expect(emitted[0].payload.number).toBe(2);
                expect((integration as any).polling).toBe(false);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });
});

function jsonOk(payload: unknown): {
    ok: true; status: 200; statusText: 'OK';
    headers: { get: () => null };
    json: () => Promise<unknown>;
} {
    return {
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => null },
        json: async () => payload,
    };
}
