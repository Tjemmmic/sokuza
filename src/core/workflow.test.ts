import { describe, it, expect, vi } from 'vitest';
import { matchesTrigger, executeWorkflow, interpolateParams } from './workflow.js';
import type { EventPayload, WorkflowDefinition, ActionHandler, ActionContext } from './types.js';
import type { Logger } from 'pino';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<EventPayload> = {}): EventPayload {
    return {
        source: 'github',
        event: 'pull_request.opened',
        timestamp: new Date().toISOString(),
        payload: {},
        metadata: {},
        ...overrides,
    };
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
    return {
        name: 'test-wf',
        trigger: {
            source: 'github',
            event: 'pull_request.opened',
        },
        steps: [],
        ...overrides,
    };
}

const noopLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

// ─── matchesTrigger ─────────────────────────────────────────────────────────

describe('matchesTrigger', () => {
    describe('basic matching', () => {
        it('matches when source and event are exact', () => {
            const wf = makeWorkflow();
            const event = makeEvent();
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('does not match wrong source', () => {
            const wf = makeWorkflow({ trigger: { source: 'slack', event: 'message' } });
            const event = makeEvent({ source: 'github', event: 'message' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('does not match wrong event', () => {
            const wf = makeWorkflow({ trigger: { source: 'github', event: 'issues.opened' } });
            const event = makeEvent({ event: 'pull_request.opened' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });
    });

    describe('disabled workflows', () => {
        it('does not match when enabled is false', () => {
            const wf = makeWorkflow({ enabled: false });
            const event = makeEvent();
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('matches when enabled is true', () => {
            const wf = makeWorkflow({ enabled: true });
            const event = makeEvent();
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('matches when enabled is undefined (default enabled)', () => {
            const wf = makeWorkflow();
            const event = makeEvent();
            expect(matchesTrigger(wf, event)).toBe(true);
        });
    });

    describe('multi-value source', () => {
        it('matches any source in the array', () => {
            const wf = makeWorkflow({
                trigger: { source: ['github', 'slack'], event: 'message' },
            });
            expect(matchesTrigger(wf, makeEvent({ source: 'github', event: 'message' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'slack', event: 'message' }))).toBe(true);
        });

        it('does not match source not in the array', () => {
            const wf = makeWorkflow({
                trigger: { source: ['github', 'slack'], event: 'message' },
            });
            expect(matchesTrigger(wf, makeEvent({ source: 'cron', event: 'message' }))).toBe(false);
        });
    });

    describe('multi-value event', () => {
        it('matches any event in the array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: ['pull_request.opened', 'pull_request.synchronize'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({ event: 'pull_request.opened' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ event: 'pull_request.synchronize' }))).toBe(true);
        });

        it('does not match event not in the array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: ['pull_request.opened', 'pull_request.synchronize'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({ event: 'issues.opened' }))).toBe(false);
        });
    });

    describe('source isolation (no cross-matching)', () => {
        it('github-poll source does NOT match github trigger', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'github-poll' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('gh-cli source does NOT match github trigger', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'gh-cli' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('gh-cli source matches gh-cli trigger', () => {
            const wf = makeWorkflow({
                trigger: { source: 'gh-cli', event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'gh-cli' });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('workflow can target multiple sources explicitly', () => {
            const wf = makeWorkflow({
                trigger: { source: ['github', 'gh-cli'], event: 'pull_request.opened' },
            });
            expect(matchesTrigger(wf, makeEvent({ source: 'github' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'gh-cli' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'github-poll' }))).toBe(false);
        });
    });

    describe('manual source matching', () => {
        it('matches when manual is in the trigger source list', () => {
            const wf = makeWorkflow({
                trigger: { source: ['github', 'manual'], event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'manual', event: 'pull_request.opened' });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('does not match when manual is NOT in the trigger source list', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened' },
            });
            const event = makeEvent({ source: 'manual', event: 'pull_request.opened' });
            expect(matchesTrigger(wf, event)).toBe(false);
        });
    });

    describe('filters', () => {
        it('matches when filter value equals resolved path', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'metadata.repo': 'org/repo' },
                },
            });
            const event = makeEvent({ metadata: { repo: 'org/repo' } });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('does not match when filter value differs', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'metadata.repo': 'org/repo' },
                },
            });
            const event = makeEvent({ metadata: { repo: 'other/repo' } });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('supports deep dot-path filters', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'payload.pull_request.base.ref': 'main' },
                },
            });
            const event = makeEvent({
                payload: { pull_request: { base: { ref: 'main' } } },
            });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('supports array-contains filter with [] syntax', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'payload.pull_request.labels[].name': 'needs-review' },
                },
            });
            const event = makeEvent({
                payload: {
                    pull_request: {
                        labels: [
                            { name: 'bug' },
                            { name: 'needs-review' },
                        ],
                    },
                },
            });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('array-contains returns false when label not found', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    filters: { 'payload.pull_request.labels[].name': 'urgent' },
                },
            });
            const event = makeEvent({
                payload: {
                    pull_request: {
                        labels: [{ name: 'bug' }, { name: 'docs' }],
                    },
                },
            });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        describe('glob filters', () => {
            it('matches a substring with leading and trailing *', () => {
                const wf = makeWorkflow({
                    trigger: {
                        source: 'github',
                        event: 'issue_comment.created',
                        filters: { 'payload.comment.body': '*sokuza:run-id=*' },
                    },
                });
                const event = makeEvent({
                    event: 'issue_comment.created',
                    payload: { comment: { body: 'Header\n<!-- sokuza:run-id=abc-123 -->\nBody' } },
                });
                expect(matchesTrigger(wf, event)).toBe(true);
            });

            it('does not match when the substring is absent', () => {
                const wf = makeWorkflow({
                    trigger: {
                        source: 'github',
                        event: 'issue_comment.created',
                        filters: { 'payload.comment.body': '*/sokuza fix*' },
                    },
                });
                const event = makeEvent({
                    event: 'issue_comment.created',
                    payload: { comment: { body: 'lgtm' } },
                });
                expect(matchesTrigger(wf, event)).toBe(false);
            });

            it('matches a prefix with trailing *', () => {
                const wf = makeWorkflow({
                    trigger: {
                        source: 'github',
                        event: 'issue_comment.created',
                        filters: { 'payload.comment.body': '/sokuza fix*' },
                    },
                });
                expect(matchesTrigger(wf, makeEvent({
                    event: 'issue_comment.created',
                    payload: { comment: { body: '/sokuza fix mode=suggest' } },
                }))).toBe(true);
                expect(matchesTrigger(wf, makeEvent({
                    event: 'issue_comment.created',
                    payload: { comment: { body: 'please /sokuza fix this' } },
                }))).toBe(false);
            });

            it('treats non-glob expected as exact match (existing behavior)', () => {
                const wf = makeWorkflow({
                    trigger: {
                        source: 'github',
                        event: 'pull_request.opened',
                        filters: { 'metadata.repo': 'org/repo' },
                    },
                });
                expect(matchesTrigger(wf, makeEvent({ metadata: { repo: 'org/repo' } }))).toBe(true);
                expect(matchesTrigger(wf, makeEvent({ metadata: { repo: 'other/repo' } }))).toBe(false);
            });
        });

        describe('OR-across-paths (| delimiter)', () => {
            // The auto-fix-address-review template relies on this: a single
            // filter key like "payload.review.body|payload.comment.body" must
            // match if EITHER path satisfies the value, because the trigger
            // listens to both pull_request_review.submitted (review body) and
            // issue_comment.created (comment body).
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: ['pull_request_review.submitted', 'issue_comment.created'],
                    filters: { 'payload.review.body|payload.comment.body': '*marker*' },
                },
            });

            it('matches when only the first alternative path is present', () => {
                expect(matchesTrigger(wf, makeEvent({
                    event: 'pull_request_review.submitted',
                    payload: { review: { body: 'some marker here' } },
                }))).toBe(true);
            });

            it('matches when only the second alternative path is present', () => {
                expect(matchesTrigger(wf, makeEvent({
                    event: 'issue_comment.created',
                    payload: { comment: { body: 'some marker here' } },
                }))).toBe(true);
            });

            it('does not match when neither alternative path is present', () => {
                expect(matchesTrigger(wf, makeEvent({
                    event: 'pull_request_review.submitted',
                    payload: {},
                }))).toBe(false);
            });

            it('does not match when both paths exist but neither value satisfies the filter', () => {
                expect(matchesTrigger(wf, makeEvent({
                    event: 'issue_comment.created',
                    payload: {
                        review: { body: 'no token' },
                        comment: { body: 'also nothing' },
                    },
                }))).toBe(false);
            });

            it('tolerates whitespace around the delimiter', () => {
                const spaced = makeWorkflow({
                    trigger: {
                        source: 'github',
                        event: 'issue_comment.created',
                        filters: { 'payload.review.body | payload.comment.body': '*marker*' },
                    },
                });
                expect(matchesTrigger(spaced, makeEvent({
                    event: 'issue_comment.created',
                    payload: { comment: { body: 'has marker inside' } },
                }))).toBe(true);
            });
        });

        it('skips filters for manual triggers', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: ['github', 'manual'],
                    event: 'pull_request.opened',
                    filters: { 'metadata.repo': 'org/repo' },
                },
            });
            const event = makeEvent({ source: 'manual', event: 'pull_request.opened', metadata: {} });
            expect(matchesTrigger(wf, event)).toBe(true);
        });
    });

    describe('multi-value repo/branch/author shorthand matching', () => {
        it('matches when repo is in the trigger array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    repo: ['org/repo-a', 'org/repo-b'],
                },
            });
            const event = makeEvent({ metadata: { repo: 'org/repo-a' } });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('does not match when repo is not in the trigger array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    repo: ['org/repo-a', 'org/repo-b'],
                },
            });
            const event = makeEvent({ metadata: { repo: 'org/repo-c' } });
            expect(matchesTrigger(wf, event)).toBe(false);
        });

        it('matches when branch is in the trigger array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    branch: ['main', 'develop'],
                },
            });
            const event = makeEvent({
                payload: { pull_request: { base: { ref: 'develop' } } },
            });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('matches when author is in the trigger array', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    author: ['user-a', 'user-b'],
                },
            });
            const event = makeEvent({
                payload: { pull_request: { user: { login: 'user-b' } } },
            });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('single-value repo is handled by filters, not shorthand', () => {
            // Single values are < 2 items so shorthand check skips (values.length <= 1)
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    repo: 'org/repo',
                },
            });
            const event = makeEvent({ metadata: { repo: 'org/repo' } });
            // This still matches because single-value is handled by filters or trivially passes
            expect(matchesTrigger(wf, event)).toBe(true);
        });
    });

    describe('glob support in shorthand multi-value matching', () => {
        it('matches when a glob entry covers the event repo', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    repo: ['my-org/*', 'specific/repo'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({ metadata: { repo: 'my-org/anything' } }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ metadata: { repo: 'specific/repo' } }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ metadata: { repo: 'other/repo' } }))).toBe(false);
        });

        it('matches a glob branch entry', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    branch: ['releases/*', 'main'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { base: { ref: 'releases/2026-01' } } },
            }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { base: { ref: 'develop' } } },
            }))).toBe(false);
        });

        it('matches a glob author entry with case-insensitive comparison', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    author: ['*[bot]', 'TjEmmes'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'dependabot[bot]' } } },
            }))).toBe(true);
            // Mixed-case author: case-insensitive compare wins.
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'tjemmes' } } },
            }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'someone-else' } } },
            }))).toBe(false);
        });
    });

    describe('multi-value labels include matching', () => {
        // Single-value labels are converted to a filter; multi-value used
        // to be silently dropped. This pins the fix.
        it('matches when at least one trigger label is on the PR', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    labels: ['needs-review', 'priority'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'priority' }, { name: 'frontend' }] } },
            }))).toBe(true);
        });

        it('rejects when no trigger label is on the PR', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    labels: ['needs-review', 'priority'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'frontend' }] } },
            }))).toBe(false);
        });

        it('also reads labels from payload.issue (issue events)', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'issues.opened',
                    labels: ['triage', 'bug'],
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                event: 'issues.opened',
                payload: { issue: { labels: [{ name: 'bug' }] } },
            }))).toBe(true);
        });
    });

    describe('exclude (negation) filters', () => {
        it('rejects when exclude.author matches the PR author (case-insensitive)', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    exclude: { author: 'Dependabot[bot]' },
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'dependabot[bot]' } } },
            }))).toBe(false);
        });

        it('passes when exclude.author does not match', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    exclude: { author: ['dependabot[bot]', 'renovate[bot]'] },
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'a-human' } } },
            }))).toBe(true);
        });

        it('rejects via exclude.author glob (e.g. all bots)', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    exclude: { author: '*[bot]' },
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'dependabot[bot]' } } },
            }))).toBe(false);
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'human-user' } } },
            }))).toBe(true);
        });

        it('rejects when exclude.labels matches any present label', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    exclude: { labels: ['wip', 'do-not-review'] },
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'wip' }, { name: 'frontend' }] } },
            }))).toBe(false);
        });

        it('passes when exclude.labels are all absent', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    exclude: { labels: ['wip'] },
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'frontend' }] } },
            }))).toBe(true);
        });

        it('rejects via exclude.repo glob (e.g. carve out legacy repos)', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    repo: ['my-org/*'],
                    exclude: { repo: ['my-org/legacy-*'] },
                },
            });
            // Include matches (my-org/*) but exclude wins.
            expect(matchesTrigger(wf, makeEvent({ metadata: { repo: 'my-org/legacy-billing' } }))).toBe(false);
            // Include matches and exclude doesn't → passes.
            expect(matchesTrigger(wf, makeEvent({ metadata: { repo: 'my-org/active' } }))).toBe(true);
        });

        it('rejects via exclude.branch glob', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github',
                    event: 'pull_request.opened',
                    exclude: { branch: ['releases/*'] },
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { base: { ref: 'releases/2026-01' } } },
            }))).toBe(false);
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { base: { ref: 'main' } } },
            }))).toBe(true);
        });

        it('skips exclude evaluation for manual triggers', () => {
            // Manual triggers explicitly bypass filtering; exclude must
            // not sneak in as a backdoor that blocks them.
            const wf = makeWorkflow({
                trigger: {
                    source: ['github', 'manual'],
                    event: 'pull_request.opened',
                    exclude: { author: 'tjemmes' },
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                source: 'manual',
                event: 'pull_request.opened',
                payload: { pull_request: { user: { login: 'tjemmes' } } },
                metadata: {},
            }))).toBe(true);
        });
    });

    describe('author filters resolve across PR and issue events', () => {
        it('matches multi-value author on an issues.* event (issue.user.login)', () => {
            // Issue events carry the author at payload.issue.user.login, not
            // payload.pull_request.user.login — this used to silently never match.
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'issues.opened', author: ['alice', 'bob'] },
            });
            expect(matchesTrigger(wf, makeEvent({
                event: 'issues.opened',
                payload: { issue: { user: { login: 'alice' } } },
            }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({
                event: 'issues.opened',
                payload: { issue: { user: { login: 'carol' } } },
            }))).toBe(false);
        });

        it('still matches multi-value author on a pull_request.* event', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened', author: ['alice', 'bob'] },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'bob' } } },
            }))).toBe(true);
        });

        it('excludes by author on an issues.* event (case-insensitive)', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'issues.opened', exclude: { author: 'Alice' } },
            });
            expect(matchesTrigger(wf, makeEvent({
                event: 'issues.opened',
                payload: { issue: { user: { login: 'alice' } } },
            }))).toBe(false);
            expect(matchesTrigger(wf, makeEvent({
                event: 'issues.opened',
                payload: { issue: { user: { login: 'someone' } } },
            }))).toBe(true);
        });

        it('matches a single-value author OR-path filter (resolveShorthands shape) on either payload', () => {
            const wf = makeWorkflow({
                trigger: {
                    source: 'github', event: ['pull_request.opened', 'issues.opened'],
                    filters: { 'payload.pull_request.user.login|payload.issue.user.login': 'alice' },
                },
            });
            expect(matchesTrigger(wf, makeEvent({
                event: 'issues.opened', payload: { issue: { user: { login: 'alice' } } },
            }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { user: { login: 'alice' } } },
            }))).toBe(true);
        });
    });

    describe('label shorthand globs', () => {
        it('matches include labels by glob', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened', labels: ['needs-*', 'urgent'] },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'needs-review' }] } },
            }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'frontend' }] } },
            }))).toBe(false);
        });

        it('excludes labels by glob', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened', exclude: { labels: ['area/*'] } },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'area/api' }] } },
            }))).toBe(false);
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'bug' }] } },
            }))).toBe(true);
        });

        it('lowercases the glob PATTERN too (Needs-* matches needs-review)', () => {
            // Confirms case-folding is applied to the pattern, not just the
            // label name, before it reaches globMatch.
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened', labels: ['Needs-*'] },
            });
            expect(matchesTrigger(wf, makeEvent({
                payload: { pull_request: { labels: [{ name: 'needs-review' }] } },
            }))).toBe(true);
            // And uppercase exclude pattern against a lowercase label.
            const wfExclude = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened', exclude: { labels: ['AREA/*'] } },
            });
            expect(matchesTrigger(wfExclude, makeEvent({
                payload: { pull_request: { labels: [{ name: 'area/api' }] } },
            }))).toBe(false);
        });

        it('does not crash on a non-string label config (e.g. labels: [123])', () => {
            const wf = makeWorkflow({
                trigger: { source: 'github', event: 'pull_request.opened', labels: [123 as unknown as string] },
            });
            const ev = makeEvent({ payload: { pull_request: { labels: [{ name: 'bug' }] } } });
            // A non-string label pattern is ignored, not thrown on.
            expect(() => matchesTrigger(wf, ev)).not.toThrow();
            expect(matchesTrigger(wf, ev)).toBe(false);
        });
    });

    // ─── Graph trigger + YAML override merge ────────────────────────────
    // Regression for the auto-PR-review trigger bug: a graph workflow that
    // hard-codes `trigger.github` in its first node used to silently
    // overwrite the YAML-level trigger block, so a user running
    // `template: ai-pr-review` with `trigger.source: [github, github-poll,
    // gh-cli]` would never match github-poll/gh-cli events. The fix wires
    // `normalizeGraphWorkflow` into matchesTrigger (and the load pipeline
    // via `normalizeWorkflow`), merging YAML source/event over the graph
    // defaults instead of replacing them.
    describe('graph workflow + YAML trigger override', () => {
        it('matches a github-poll event when YAML widens source beyond the graph node', () => {
            // Shape mirrors `templates/ai-pr-review.yaml`: the graph hard-
            // codes `trigger.github`, but the user's workflow widens both
            // source and event in the outer YAML trigger block.
            const wf: WorkflowDefinition = {
                name: 'auto-pr-review',
                trigger: {
                    source: ['github', 'github-poll', 'gh-cli'],
                    event: ['pull_request.opened', 'pull_request.synchronize'],
                },
                graph: {
                    nodes: [{
                        id: 'trigger',
                        type: 'trigger.github',
                        config: { events: ['pull_request.opened'] },
                    }],
                    edges: [],
                },
            };

            const event = makeEvent({ source: 'github-poll', event: 'pull_request.opened' });
            expect(matchesTrigger(wf, event)).toBe(true);
        });

        it('matches all three sources declared in the YAML override', () => {
            const wf: WorkflowDefinition = {
                name: 'auto-pr-review',
                trigger: {
                    source: ['github', 'github-poll', 'gh-cli'],
                    event: ['pull_request.opened', 'pull_request.synchronize'],
                },
                graph: {
                    nodes: [{
                        id: 'trigger',
                        type: 'trigger.github',
                        config: { events: ['pull_request.opened'] },
                    }],
                    edges: [],
                },
            };

            expect(matchesTrigger(wf, makeEvent({ source: 'github', event: 'pull_request.opened' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'github-poll', event: 'pull_request.opened' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'gh-cli', event: 'pull_request.opened' }))).toBe(true);
        });

        it('falls back to the graph trigger node source when YAML has no trigger block', () => {
            // Negative case: without a YAML override, the graph's
            // `trigger.github` node is the only source-of-truth. A
            // github-poll event must NOT match — proving the merge
            // semantics are intentional, not just "always match".
            const wf: WorkflowDefinition = {
                name: 'graph-only',
                trigger: undefined as unknown as WorkflowDefinition['trigger'],
                graph: {
                    nodes: [{
                        id: 'trigger',
                        type: 'trigger.github',
                        config: { events: ['pull_request.opened'] },
                    }],
                    edges: [],
                },
            };

            expect(matchesTrigger(wf, makeEvent({ source: 'github', event: 'pull_request.opened' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'github-poll', event: 'pull_request.opened' }))).toBe(false);
            expect(matchesTrigger(wf, makeEvent({ source: 'gh-cli', event: 'pull_request.opened' }))).toBe(false);
        });

        it('matches pull_request.synchronize when YAML event list widens the graph node', () => {
            // Sister regression to the source-merge fix: the user's
            // auto-pr-review workflow declares
            //   event: [pull_request.opened, pull_request.synchronize]
            // in YAML, but the ai-pr-review template's `trigger.github`
            // node only declares `events: [pull_request.opened]`. Before
            // this fix, the graph-derived event list won the merge and
            // synchronize events were silently dropped — so the auto
            // re-review on every new commit never fired. YAML now wins
            // for event the same way it wins for source.
            const wf: WorkflowDefinition = {
                name: 'auto-pr-review',
                trigger: {
                    source: 'gh-cli',
                    event: ['pull_request.opened', 'pull_request.synchronize'],
                    author: 'Tjemmmic',
                },
                graph: {
                    nodes: [{
                        id: 'trigger',
                        type: 'trigger.github',
                        config: { events: ['pull_request.opened'] },
                    }],
                    edges: [],
                },
            };

            const syncEvent = makeEvent({
                source: 'gh-cli',
                event: 'pull_request.synchronize',
                payload: { pull_request: { user: { login: 'Tjemmmic' } } },
            });
            expect(matchesTrigger(wf, syncEvent)).toBe(true);

            const openedEvent = makeEvent({
                source: 'gh-cli',
                event: 'pull_request.opened',
                payload: { pull_request: { user: { login: 'Tjemmmic' } } },
            });
            expect(matchesTrigger(wf, openedEvent)).toBe(true);
        });

        it('falls back to the graph trigger node event list when YAML has no event field', () => {
            // Symmetric negative: without an explicit YAML event list, the
            // graph node's events drive matching. A YAML-silent workflow
            // must not silently match every event under the sun.
            const wf: WorkflowDefinition = {
                name: 'graph-event-only',
                trigger: {
                    source: 'github',
                    // No `event:` field — should fall back to graph.
                } as WorkflowDefinition['trigger'],
                graph: {
                    nodes: [{
                        id: 'trigger',
                        type: 'trigger.github',
                        config: { events: ['pull_request.opened'] },
                    }],
                    edges: [],
                },
            };

            expect(matchesTrigger(wf, makeEvent({ source: 'github', event: 'pull_request.opened' }))).toBe(true);
            expect(matchesTrigger(wf, makeEvent({ source: 'github', event: 'pull_request.synchronize' }))).toBe(false);
        });
    });
});

// ─── syncTriggerNodeFromWorkflow (editor display fix) ───────────────────────

describe('syncTriggerNodeFromWorkflow', () => {
    it('projects the merged trigger (source + author) back into the graph node', async () => {
        const { syncTriggerNodeFromWorkflow } = await import('./nodes/graph-trigger.js');
        // The visual-editor bug: graph node is a stale `trigger.github`
        // with no author, but the YAML trigger says gh-cli + author.
        const wf: WorkflowDefinition = {
            name: 'auto-pr-review',
            trigger: {
                source: 'gh-cli',
                event: ['pull_request.opened', 'pull_request.synchronize'],
                author: 'Tjemmmic',
            },
            graph: {
                nodes: [
                    { id: 'trigger', type: 'trigger.github', config: { events: ['pull_request.opened'] } },
                    { id: 'fetch', type: 'github.fetch-diff', config: {} },
                ],
                edges: [],
            },
        } as WorkflowDefinition;

        const out = syncTriggerNodeFromWorkflow(wf);
        const node = out.graph!.nodes.find((n) => n.id === 'trigger')!;
        expect(node.type).toBe('trigger.gh-cli');
        expect(node.config!.events).toEqual(['pull_request.opened', 'pull_request.synchronize']);
        expect(node.config!.authors).toEqual(['Tjemmmic']);
        // Non-trigger nodes are untouched.
        expect(out.graph!.nodes.find((n) => n.id === 'fetch')!.type).toBe('github.fetch-diff');
    });

    it('is a no-op for non-graph (legacy steps) workflows', async () => {
        const { syncTriggerNodeFromWorkflow } = await import('./nodes/graph-trigger.js');
        const wf = { name: 'x', trigger: { source: 'github' }, steps: [] } as unknown as WorkflowDefinition;
        expect(syncTriggerNodeFromWorkflow(wf)).toBe(wf);
    });

    it('is a no-op when the graph has no trigger node', async () => {
        const { syncTriggerNodeFromWorkflow } = await import('./nodes/graph-trigger.js');
        const wf = {
            name: 'x',
            trigger: { source: 'gh-cli' },
            graph: { nodes: [{ id: 'fetch', type: 'github.fetch-diff', config: {} }], edges: [] },
        } as unknown as WorkflowDefinition;
        expect(syncTriggerNodeFromWorkflow(wf)).toBe(wf);
    });

    it('handles a trigger node with null/absent config without throwing', async () => {
        const { syncTriggerNodeFromWorkflow } = await import('./nodes/graph-trigger.js');
        const wf = {
            name: 'x',
            trigger: { source: 'gh-cli', author: 'me' },
            graph: { nodes: [{ id: 'trigger', type: 'trigger.github' }], edges: [] },
        } as unknown as WorkflowDefinition;
        const out = syncTriggerNodeFromWorkflow(wf);
        const node = out.graph!.nodes.find((n) => n.id === 'trigger')!;
        expect(node.type).toBe('trigger.gh-cli');
        expect(node.config!.authors).toEqual(['me']);
    });

    it('array source: node type follows the first source, unknown sources fall back to the node type', async () => {
        const { syncTriggerNodeFromWorkflow } = await import('./nodes/graph-trigger.js');
        // First source is a known one → node type follows it.
        const known = {
            name: 'x',
            trigger: { source: ['gh-cli', 'github'], event: ['push'] },
            graph: { nodes: [{ id: 'trigger', type: 'trigger.github', config: {} }], edges: [] },
        } as unknown as WorkflowDefinition;
        expect(syncTriggerNodeFromWorkflow(known).graph!.nodes[0].type).toBe('trigger.gh-cli');

        // First source unknown → keep the existing node type (no crash).
        const unknown = {
            name: 'y',
            trigger: { source: ['bogus-source'], event: ['push'] },
            graph: { nodes: [{ id: 'trigger', type: 'trigger.github', config: {} }], edges: [] },
        } as unknown as WorkflowDefinition;
        expect(syncTriggerNodeFromWorkflow(unknown).graph!.nodes[0].type).toBe('trigger.github');
    });
});

// ─── interpolateParams ──────────────────────────────────────────────────────

describe('interpolateParams', () => {
    const baseContext: ActionContext = {
        event: makeEvent({
            payload: { pull_request: { title: 'Fix bug', number: 42 } },
            metadata: { repo: 'org/repo' },
        }),
        results: { 0: { summary: 'All good' } },
        steps: { analysis: { needs_fix: true, summary: 'Found issue' } },
        integrationConfigs: {},
        logger: noopLogger,
    };

    it('resolves simple event paths', () => {
        const params = { repo: '{{event.metadata.repo}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.repo).toBe('org/repo');
    });

    it('resolves nested payload paths', () => {
        const params = { title: '{{event.payload.pull_request.title}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.title).toBe('Fix bug');
    });

    it('resolves step results by id', () => {
        const params = { summary: '{{steps.analysis.summary}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.summary).toBe('Found issue');
    });

    it('resolves results by index', () => {
        const params = { prev: '{{results.0.summary}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.prev).toBe('All good');
    });

    it('returns empty string for undefined paths', () => {
        const params = { missing: '{{event.payload.nonexistent.path}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.missing).toBe('');
    });

    it('preserves unknown-prefix placeholders as literals (matches the graph runtime — a typo like {{ndoes.x}} stays visible instead of silently becoming "")', () => {
        const params = {
            typo: 'before {{ndoes.review.sha}} after',
            literal: 'see {{handlebars}} for syntax',
            // Recognised but missing still collapses to empty so optional
            // values don't surface placeholder text in real outputs.
            missing: 'pre[{{steps.nope.gone}}]post',
        };
        const result = interpolateParams(params, baseContext);
        expect(result.typo).toBe('before {{ndoes.review.sha}} after');
        expect(result.literal).toBe('see {{handlebars}} for syntax');
        expect(result.missing).toBe('pre[]post');
    });

    it('no longer accepts the bare `{{metadata.…}}` prefix — must use `{{event.metadata.…}}`', () => {
        // `metadata.` used to be in ALLOWED_INTERPOLATION_PREFIXES but
        // was never wired into the resolution context — it always
        // resolved to undefined → empty string. Now it falls into the
        // unknown-prefix branch and round-trips as a literal, which
        // surfaces the typo instead of silently corrupting output.
        const params = {
            wrong: '{{metadata.repo}}',
            right: '{{event.metadata.repo}}',
        };
        const result = interpolateParams(params, baseContext);
        expect(result.wrong).toBe('{{metadata.repo}}');
        expect(result.right).toBe('org/repo');
    });

    it('handles multiple expressions in one string', () => {
        const params = { msg: 'PR #{{event.payload.pull_request.number}} in {{event.metadata.repo}}' };
        const result = interpolateParams(params, baseContext);
        expect(result.msg).toBe('PR #42 in org/repo');
    });

    it('recursively resolves nested objects', () => {
        const params = {
            outer: {
                inner: '{{event.metadata.repo}}',
            },
        };
        const result = interpolateParams(params, baseContext);
        expect((result.outer as Record<string, unknown>).inner).toBe('org/repo');
    });

    it('passes non-string values through unchanged', () => {
        const params = { count: 42, flag: true, items: [1, 2, 3] };
        const result = interpolateParams(params, baseContext);
        expect(result.count).toBe(42);
        expect(result.flag).toBe(true);
        expect(result.items).toEqual([1, 2, 3]);
    });

    it('resolves templates inside arrays — same shape as the graph runtime', () => {
        // Used to silently pass arrays through verbatim, leaving
        // {{...}} placeholders intact and producing the wrong values
        // downstream. The graph executor's interpolateValue has always
        // walked arrays; the legacy executor now matches.
        const params = {
            items: ['{{event.metadata.repo}}', '{{steps.analysis.summary}}', 'literal'],
            nested: [{ ref: '{{event.payload.pull_request.title}}' }],
        };
        const result = interpolateParams(params, baseContext);
        expect(result.items).toEqual(['org/repo', 'Found issue', 'literal']);
        expect((result.nested as Array<Record<string, unknown>>)[0].ref).toBe('Fix bug');
    });
});

// ─── executeWorkflow ────────────────────────────────────────────────────────

describe('executeWorkflow', () => {
    it('executes steps in order and passes results forward', async () => {
        const order: string[] = [];
        const actionA: ActionHandler = async () => {
            order.push('a');
            return { result: 'from-a' };
        };
        const actionB: ActionHandler = async (_params, ctx) => {
            order.push('b');
            return { result: 'from-b', prev: ctx.results[0] };
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('action-a', actionA);
        registry.set('action-b', actionB);

        const wf = makeWorkflow({
            steps: [
                { action: 'action-a', params: {} },
                { action: 'action-b', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(order).toEqual(['a', 'b']);
    });

    it('skips unknown actions', async () => {
        const registry = new Map<string, ActionHandler>();
        const wf = makeWorkflow({
            steps: [{ action: 'does-not-exist', params: {} }],
        });

        // Should not throw
        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(noopLogger.warn).toHaveBeenCalled();
    });

    it('stores results by step id', async () => {
        let capturedCtx: ActionContext | null = null;
        const actionA: ActionHandler = async () => ({ value: 'hello' });
        const actionB: ActionHandler = async (_params, ctx) => {
            capturedCtx = ctx;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('action-a', actionA);
        registry.set('action-b', actionB);

        const wf = makeWorkflow({
            steps: [
                { action: 'action-a', id: 'greet', params: {} },
                { action: 'action-b', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(capturedCtx!.steps.greet).toEqual({ value: 'hello' });
    });

    it('on_error=continue skips failed steps', async () => {
        const order: string[] = [];
        const failAction: ActionHandler = async () => {
            order.push('fail');
            throw new Error('boom');
        };
        const okAction: ActionHandler = async () => {
            order.push('ok');
            return 'success';
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('fail-action', failAction);
        registry.set('ok-action', okAction);

        const wf = makeWorkflow({
            steps: [
                { action: 'fail-action', params: {}, on_error: 'continue' },
                { action: 'ok-action', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(order).toEqual(['fail', 'ok']);
    });

    it('on_error=stop (default) throws on failure', async () => {
        const failAction: ActionHandler = async () => {
            throw new Error('boom');
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('fail-action', failAction);

        const wf = makeWorkflow({
            steps: [{ action: 'fail-action', params: {} }],
        });

        await expect(
            executeWorkflow(wf, makeEvent(), registry, noopLogger),
        ).rejects.toThrow('boom');
    });

    it('evaluates conditions — skips step when condition is falsy', async () => {
        const order: string[] = [];
        const action: ActionHandler = async () => {
            order.push('ran');
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            steps: [
                { action: 'my-action', params: {}, condition: '{{event.payload.nonexistent}}' },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(order).toEqual([]); // Step was skipped
    });

    it('evaluates conditions — runs step when condition is truthy', async () => {
        const order: string[] = [];
        const action: ActionHandler = async () => {
            order.push('ran');
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            steps: [
                { action: 'my-action', params: {}, condition: '{{event.source}}' },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(order).toEqual(['ran']);
    });

    it('interpolates step params before passing to handler', async () => {
        let receivedParams: Record<string, unknown> = {};
        const action: ActionHandler = async (params) => {
            receivedParams = params;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            steps: [
                { action: 'my-action', params: { repo: '{{event.metadata.repo}}' } },
            ],
        });

        await executeWorkflow(
            wf,
            makeEvent({ metadata: { repo: 'org/my-repo' } }),
            registry,
            noopLogger,
        );
        expect(receivedParams.repo).toBe('org/my-repo');
    });
});

// ─── Parallel Steps ─────────────────────────────────────────────────────────

describe('parallel steps', () => {
    it('should run steps with run: parallel concurrently', async () => {
        const order: string[] = [];
        const slowAction: ActionHandler = async () => {
            await new Promise((r) => setTimeout(r, 50));
            order.push('slow');
            return { result: 'slow-done' };
        };
        const fastAction: ActionHandler = async () => {
            order.push('fast');
            return { result: 'fast-done' };
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('slow-action', slowAction);
        registry.set('fast-action', fastAction);

        const wf = makeWorkflow({
            steps: [
                { action: 'slow-action', id: 'slow', run: 'parallel', params: {} },
                { action: 'fast-action', id: 'fast', run: 'parallel', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);

        // Both should complete; fastAction should have been called before slowAction finished
        // because they ran in parallel
        expect(order).toContain('fast');
        expect(order).toContain('slow');
    });

    it('should collect results from all parallel steps', async () => {
        let capturedResult: Record<string, unknown> | null = null;
        const actionA: ActionHandler = async () => ({ review: 'from-a' });
        const actionB: ActionHandler = async () => ({ review: 'from-b' });
        const actionC: ActionHandler = async (_params, ctx) => {
            capturedResult = {
                merged: `${(ctx.steps['step-a'] as any).review} + ${(ctx.steps['step-b'] as any).review}`,
            };
            return capturedResult;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('action-a', actionA);
        registry.set('action-b', actionB);
        registry.set('action-c', actionC);

        const wf = makeWorkflow({
            steps: [
                { action: 'action-a', id: 'step-a', run: 'parallel', params: {} },
                { action: 'action-b', id: 'step-b', run: 'parallel', params: {} },
                { action: 'action-c', id: 'step-c', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);

        expect(capturedResult).toEqual({ merged: 'from-a + from-b' });
    });

    it('should fail-fast on error in parallel group', async () => {
        const failAction: ActionHandler = async () => {
            throw new Error('parallel-fail');
        };
        const okAction: ActionHandler = async () => ({ result: 'ok' });

        const registry = new Map<string, ActionHandler>();
        registry.set('fail-action', failAction);
        registry.set('ok-action', okAction);

        const wf = makeWorkflow({
            steps: [
                { action: 'fail-action', run: 'parallel', params: {} },
                { action: 'ok-action', run: 'parallel', params: {} },
            ],
        });

        await expect(
            executeWorkflow(wf, makeEvent(), registry, noopLogger),
        ).rejects.toThrow('parallel-fail');
    });

    it('should respect on_error=continue in parallel group', async () => {
        const failAction: ActionHandler = async () => {
            throw new Error('soft-fail');
        };
        const okAction: ActionHandler = async () => ({ result: 'ok' });
        const afterAction: ActionHandler = async () => ({ result: 'after' });

        const registry = new Map<string, ActionHandler>();
        registry.set('fail-action', failAction);
        registry.set('ok-action', okAction);
        registry.set('after-action', afterAction);

        const wf = makeWorkflow({
            steps: [
                { action: 'fail-action', run: 'parallel', params: {}, on_error: 'continue' },
                { action: 'ok-action', run: 'parallel', params: {} },
                { action: 'after-action', params: {} },
            ],
        });

        // Should not throw — on_error=continue swallows the error
        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
    });

    it('should mix parallel and sequential steps', async () => {
        const order: string[] = [];

        const registry = new Map<string, ActionHandler>();
        registry.set('step-a', async () => { order.push('a'); return 'a'; });
        registry.set('step-b', async () => { order.push('b'); return 'b'; });
        registry.set('step-c', async () => { order.push('c'); return 'c'; });
        registry.set('step-d', async () => { order.push('d'); return 'd'; });

        const wf = makeWorkflow({
            steps: [
                { action: 'step-a', params: {} },
                { action: 'step-b', run: 'parallel', params: {} },
                { action: 'step-c', run: 'parallel', params: {} },
                { action: 'step-d', params: {} },
            ],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);

        // a runs first (sequential), then b+c run in parallel, then d runs after both complete
        expect(order[0]).toBe('a');
        expect(order).toContain('d');
    });

    // Regression for PR #13 review-feedback P1: runParallelGroup used to
    // omit `_signal` when constructing each parallel step's
    // ActionContext, so the abort plumbing introduced for ai.review /
    // ai.agent silently bypassed every parallel group (dual-review
    // template, parallel address-review fan-out, etc.). Workflow
    // timeouts and dashboard cancels reached the sequential and graph
    // paths but left parallel-step AI subprocesses running. Pin that
    // every parallel step receives the SAME AbortSignal the sequential
    // path does.
    it('forwards the workflow AbortSignal to every parallel step\'s ActionContext', async () => {
        const seenSignals: Array<AbortSignal | undefined> = [];
        const captureSignal: ActionHandler = async (_params, ctx) => {
            seenSignals.push(ctx.signal);
            return { ok: true };
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('parallel-a', captureSignal);
        registry.set('parallel-b', captureSignal);
        registry.set('parallel-c', captureSignal);

        const wf = makeWorkflow({
            steps: [
                { action: 'parallel-a', id: 'a', run: 'parallel', params: {} },
                { action: 'parallel-b', id: 'b', run: 'parallel', params: {} },
                { action: 'parallel-c', id: 'c', run: 'parallel', params: {} },
            ],
        });

        const ac = new AbortController();
        await executeWorkflow(wf, makeEvent(), registry, noopLogger, {}, undefined, ac.signal);

        // All three parallel steps must have seen the SAME signal
        // instance — proving the plumbing reaches `makeContext` inside
        // `runParallelGroup`, not just the sequential path.
        expect(seenSignals).toHaveLength(3);
        for (const seen of seenSignals) {
            expect(seen).toBe(ac.signal);
        }
    });
});

// ─── AI Config Resolution ───────────────────────────────────────────────────

describe('AI config resolution', () => {
    it('should inject workflow-level AI config into step params', async () => {
        let receivedParams: Record<string, unknown> = {};
        const action: ActionHandler = async (params) => {
            receivedParams = params;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            ai: { provider: 'opencode', model: 'glm-4.6' },
            steps: [{ action: 'my-action', params: {} }],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(receivedParams.provider).toBe('opencode');
        expect(receivedParams.model).toBe('glm-4.6');
    });

    it('should let step-level AI config override workflow-level', async () => {
        let receivedParams: Record<string, unknown> = {};
        const action: ActionHandler = async (params) => {
            receivedParams = params;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            ai: { provider: 'opencode', model: 'glm-4.6' },
            steps: [{
                action: 'my-action',
                ai: { provider: 'claude-code', model: 'opus' },
                params: {},
            }],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(receivedParams.provider).toBe('claude-code');
        expect(receivedParams.model).toBe('opus');
    });

    it('should not override explicit params with AI config', async () => {
        let receivedParams: Record<string, unknown> = {};
        const action: ActionHandler = async (params) => {
            receivedParams = params;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            ai: { provider: 'opencode', model: 'glm-4.6' },
            steps: [{
                action: 'my-action',
                params: { provider: 'explicit-provider' },
            }],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        // Explicit params win over AI config
        expect(receivedParams.provider).toBe('explicit-provider');
        // Model comes from AI config since it wasn't explicitly set
        expect(receivedParams.model).toBe('glm-4.6');
    });

    it('should work without any AI config', async () => {
        let receivedParams: Record<string, unknown> = {};
        const action: ActionHandler = async (params) => {
            receivedParams = params;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const wf = makeWorkflow({
            steps: [{ action: 'my-action', params: { message: 'hello' } }],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(receivedParams.message).toBe('hello');
        expect(receivedParams.provider).toBeUndefined();
        expect(receivedParams.model).toBeUndefined();
    });

    it('passes recordWebhookDelivery and workflowName to action context', async () => {
        let capturedCtx: ActionContext | null = null;
        const action: ActionHandler = async (_params, ctx) => {
            capturedCtx = ctx;
            return null;
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('my-action', action);

        const deliveries: Array<Record<string, unknown>> = [];
        const recorder = (d: any) => deliveries.push(d);

        const wf = makeWorkflow({
            name: 'ctx-test-wf',
            steps: [{ action: 'my-action', params: {} }],
        });

        await executeWorkflow(wf, makeEvent(), registry, noopLogger, {}, undefined, undefined, recorder);

        expect(capturedCtx!.workflowName).toBe('ctx-test-wf');
        expect(capturedCtx!.recordWebhookDelivery).toBe(recorder);
    });

    it('enforces per-step timeout', async () => {
        const slowAction: ActionHandler = async () => {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return 'done';
        };

        const registry = new Map<string, ActionHandler>();
        registry.set('slow-action', slowAction);

        const wf = makeWorkflow({
            steps: [{ action: 'slow-action', params: {}, timeout: 0.1 }],
        });

        await expect(
            executeWorkflow(wf, makeEvent(), registry, noopLogger),
        ).rejects.toThrow(/timed out/);
    });

    it('allows step without timeout to complete normally', async () => {
        const fastAction: ActionHandler = async () => 'done';

        const registry = new Map<string, ActionHandler>();
        registry.set('fast-action', fastAction);

        const wf = makeWorkflow({
            steps: [{ action: 'fast-action', params: {} }],
        });

        const result = await executeWorkflow(wf, makeEvent(), registry, noopLogger);
        expect(result.results[0]).toBe('done');
    });
});
