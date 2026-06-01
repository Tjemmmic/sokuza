import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { GitHubPollIntegration } from '../integrations/github-poll/index.js';
import type { EventPayload } from '../core/types.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

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
    });

    // Capture the onEvent handler by calling registerRoutes with a fake server
    const fakeServer = {} as any;
    integration.registerRoutes(fakeServer, async (event) => {
        emitted.push(event);
    });
    // Stop the timer immediately — we'll drive polling manually
    integration.stop();

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
    describe('initialization', () => {
        it('should throw if token is missing', async () => {
            const integration = new GitHubPollIntegration();
            await expect(
                integration.initialize({ repos: ['org/repo'] }),
            ).rejects.toThrow('token is required');
        });

        it('should throw if both repos and orgs are empty', async () => {
            // Validation widened to accept either source — but at least
            // one of them must be supplied, otherwise there's nothing
            // for the poll loop to iterate over.
            const integration = new GitHubPollIntegration();
            await expect(
                integration.initialize({ token: 'tok', repos: [] }),
            ).rejects.toThrow('at least one of `repos` or `orgs`');
        });

        it('accepts orgs-only config (no explicit repos)', async () => {
            // The new path: a user wants to watch all repos in an org
            // without listing them. Validation must accept this even
            // though `repos` is empty / unset.
            const integration = new GitHubPollIntegration();
            await expect(
                integration.initialize({ token: 'tok', orgs: ['my-org'] }),
            ).resolves.toBeUndefined();
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
            });
            const fakeServer = {} as any;
            integration.registerRoutes(fakeServer, async (e) => { emitted.push(e); });
            integration.stop(); // We'll drive poll() + refreshOrgRepos() by hand.

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
            await integration.initialize({ token: 'tok', orgs: ['huge-org'] });
            const fakeServer = {} as any;
            integration.registerRoutes(fakeServer, async () => { /* noop */ });
            integration.stop();

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
});
