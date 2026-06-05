import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./exec.js', () => ({
    getGhAuthStatus: vi.fn(),
    ghJson: vi.fn(),
}));

import { GhCliIntegration, buildPrSearchArgs } from './index.js';
import { getGhAuthStatus, ghJson } from './exec.js';

const mockedGetGhAuthStatus = vi.mocked(getGhAuthStatus);
const mockedGhJson = vi.mocked(ghJson);

describe('GhCliIntegration', () => {
    let integration: GhCliIntegration;

    beforeEach(() => {
        vi.clearAllMocks();
        integration = new GhCliIntegration();
    });

    it('has correct name', () => {
        expect(integration.name).toBe('gh-cli');
    });

    it('has correct supportedEvents', () => {
        expect(integration.supportedEvents).toEqual([
            'pull_request.opened',
            'pull_request.closed',
            'pull_request.synchronize',
            'pull_request_review.submitted',
            'issue_comment.created',
        ]);
    });

    it('registers all 6 action handlers', () => {
        const actionNames = Object.keys(integration.actions);
        expect(actionNames).toHaveLength(6);
        expect(actionNames).toContain('gh-cli-clone-repo');
        expect(actionNames).toContain('gh-cli-fetch-diff');
        expect(actionNames).toContain('gh-cli-comment');
        expect(actionNames).toContain('gh-cli-fetch-reviews');
        expect(actionNames).toContain('gh-cli-create-pr');
        expect(actionNames).toContain('gh-cli-review');

        for (const handler of Object.values(integration.actions)) {
            expect(typeof handler).toBe('function');
        }
    });

    describe('initialize', () => {
        it('throws when gh auth is unavailable', async () => {
            mockedGetGhAuthStatus.mockResolvedValue({ available: false });

            await expect(integration.initialize({})).rejects.toThrow(
                'gh-cli integration requires the GitHub CLI',
            );
        });

        it('succeeds when gh auth is available', async () => {
            mockedGetGhAuthStatus.mockResolvedValue({
                available: true,
                username: 'testuser',
            });

            await expect(integration.initialize({})).resolves.toBeUndefined();
            expect(integration.getUsername()).toBe('testuser');
        });

        it('warns when a last-wins selector (authors) is given multiple values', async () => {
            mockedGetGhAuthStatus.mockResolvedValue({ available: true, username: 'testuser' });
            const warn = vi.fn();
            const logger = { warn } as unknown as Parameters<GhCliIntegration['initialize']>[1];
            await integration.initialize({ prs: { authors: ['alice', 'bob'] } }, logger);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][1]).toMatch(/can't be OR'd|only the last/i);
        });

        it('does not warn for a single author or for owners', async () => {
            mockedGetGhAuthStatus.mockResolvedValue({ available: true, username: 'testuser' });
            const warn = vi.fn();
            const logger = { warn } as unknown as Parameters<GhCliIntegration['initialize']>[1];
            await integration.initialize({ prs: { authors: ['alice'], owners: ['org-a', 'org-b'] } }, logger);
            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('buildPrSearchArgs', () => {
        it('defaults to the authenticated user (back-compat) when unset', () => {
            expect(buildPrSearchArgs(undefined)).toEqual(['--author', '@me']);
            expect(buildPrSearchArgs(null)).toEqual(['--author', '@me']);
        });

        it('falls back to @me for an empty object (not a fetch-everything query)', () => {
            expect(buildPrSearchArgs({})).toEqual(['--author', '@me']);
        });

        it('widens to an org via owners (watch others\' PRs)', () => {
            expect(buildPrSearchArgs({ owners: ['my-org'] })).toEqual(['--owner', 'my-org']);
        });

        it('maps single author / repos / involves to flags', () => {
            expect(buildPrSearchArgs({ authors: ['alice'], repos: ['o/r'], involves: ['@me'] }))
                .toEqual(['--author', 'alice', '--repo', 'o/r', '--involves', '@me']);
        });

        it('emits only the LAST value for last-wins selectors (authors/involves)', () => {
            // gh search prs is last-wins for --author/--involves, so the command
            // should reflect that rather than misleadingly list both.
            expect(buildPrSearchArgs({ authors: ['alice', 'bob'] })).toEqual(['--author', 'bob']);
            expect(buildPrSearchArgs({ involves: ['x', 'y'] })).toEqual(['--involves', 'y']);
            // owners/repos DO OR, so all values are kept.
            expect(buildPrSearchArgs({ owners: ['org-a', 'org-b'] }))
                .toEqual(['--owner', 'org-a', '--owner', 'org-b']);
        });

        it('accepts a bare string and trims it', () => {
            expect(buildPrSearchArgs({ owners: '  my-org  ' })).toEqual(['--owner', 'my-org']);
        });

        it('puts raw search qualifiers first as the positional query', () => {
            expect(buildPrSearchArgs({ owners: ['my-org'], search: 'draft:false' }))
                .toEqual(['draft:false', '--owner', 'my-org']);
        });

        it('warns (via the passed logger) on multi-value last-wins selectors', () => {
            const warn = vi.fn();
            const logger = { warn } as unknown as Parameters<typeof buildPrSearchArgs>[1];
            buildPrSearchArgs({ authors: ['alice', 'bob'] }, logger);
            expect(warn).toHaveBeenCalledTimes(1);
            // Single author / multi-owner (which OR fine) don't warn.
            warn.mockClear();
            buildPrSearchArgs({ authors: ['alice'], owners: ['a', 'b'] }, logger);
            expect(warn).not.toHaveBeenCalled();
        });
    });

    describe('author propagation (drives exclude.author on widened searches)', () => {
        it('searchPrs requests the author field', async () => {
            mockedGhJson.mockResolvedValue([]);
            await GhCliIntegration.searchPrs(['--owner', 'my-org']);
            const callArgs = mockedGhJson.mock.calls[0][0] as string[];
            expect(callArgs).toContain('--owner');
            const jsonFields = callArgs[callArgs.indexOf('--json') + 1];
            expect(jsonFields).toContain('author');
        });

        it('maps the PR author into payload.pull_request.user.login', async () => {
            const events: Array<{ payload: { pull_request: { user: { login: string } } } }> = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (integration as any).onEvent = async (e: any) => { events.push(e); };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (integration as any).emitPrEvent('pull_request.opened', 'my-org/api', {
                number: 7, title: 't', state: 'OPEN', isDraft: false, url: 'u',
                author: { login: 'alice' }, headRefName: 'feat', baseRefName: 'main', labels: [],
            });
            expect(events).toHaveLength(1);
            expect(events[0].payload.pull_request.user.login).toBe('alice');
        });
    });

    describe('poll(): closed-PR detection vs full-page guard', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (i: GhCliIntegration) => i as any;

        it('does NOT emit closed (or drop tracking) on a full page', async () => {
            const events: Array<{ event: string }> = [];
            state(integration).onEvent = async (e: { event: string }) => { events.push(e); };
            state(integration).seeded = true;
            // Track PR #1 — it will be absent from the (full) result page.
            state(integration).lastPrUpdatedAt.set('org/repo#1', 't1');
            // A full page (100) of already-tracked, unchanged PRs → no per-PR work.
            const page = [];
            for (let n = 2; n <= 101; n++) {
                page.push({ number: n, repository: { nameWithOwner: 'org/repo' }, updatedAt: `u${n}` });
                state(integration).lastPrUpdatedAt.set(`org/repo#${n}`, `u${n}`);
            }
            mockedGhJson.mockResolvedValueOnce(page);
            await state(integration).poll();
            expect(events.some((e) => e.event === 'pull_request.closed')).toBe(false);
            expect(state(integration).lastPrUpdatedAt.has('org/repo#1')).toBe(true);
        });

        it('emits closed (and cleans up) for a tracked PR missing from a short page', async () => {
            const events: Array<{ event: string; payload: { pull_request: { number: number } } }> = [];
            state(integration).onEvent = async (e: never) => { events.push(e); };
            state(integration).seeded = true;
            state(integration).lastPrUpdatedAt.set('org/repo#1', 't1');   // will disappear
            state(integration).lastPrUpdatedAt.set('org/repo#2', 'u2');   // stays
            mockedGhJson.mockResolvedValueOnce([
                { number: 2, repository: { nameWithOwner: 'org/repo' }, updatedAt: 'u2' },
            ]);
            await state(integration).poll();
            const closed = events.filter((e) => e.event === 'pull_request.closed');
            expect(closed.map((e) => e.payload.pull_request.number)).toContain(1);
            expect(state(integration).lastPrUpdatedAt.has('org/repo#1')).toBe(false);
        });

        it('closed event carries the persisted author (so exclude.author works on org polls)', async () => {
            const events: Array<{ event: string; payload: { pull_request: { user: { login: string } } } }> = [];
            state(integration).onEvent = async (e: never) => { events.push(e); };
            state(integration).seeded = true;
            state(integration).lastPrUpdatedAt.set('org/repo#1', 't1');
            state(integration).lastPrAuthor.set('org/repo#1', 'alice'); // not the poller's own login
            mockedGhJson.mockResolvedValueOnce([]); // short page, #1 gone
            await state(integration).poll();
            const closed = events.filter((e) => e.event === 'pull_request.closed');
            expect(closed).toHaveLength(1);
            expect(closed[0].payload.pull_request.user.login).toBe('alice');
        });

        it('calls searchPrs with the configured prSearchArgs (not listMyPrs/@me)', async () => {
            state(integration).onEvent = async () => {};
            state(integration).prSearchArgs = ['--owner', 'test-org'];
            mockedGhJson.mockResolvedValueOnce([]); // searchPrs result
            await state(integration).poll();
            const callArgs = mockedGhJson.mock.calls[0][0] as string[];
            expect(callArgs).toContain('--owner');
            expect(callArgs).toContain('test-org');
            expect(callArgs).not.toContain('@me');
        });
    });
});
