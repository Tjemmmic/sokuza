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

        it('maps authors / repos / involves to repeatable flags', () => {
            expect(buildPrSearchArgs({ authors: ['alice', 'bob'], repos: ['o/r'], involves: ['@me'] }))
                .toEqual(['--author', 'alice', '--author', 'bob', '--repo', 'o/r', '--involves', '@me']);
        });

        it('accepts a bare string and trims it', () => {
            expect(buildPrSearchArgs({ owners: '  my-org  ' })).toEqual(['--owner', 'my-org']);
        });

        it('puts raw search qualifiers first as the positional query', () => {
            expect(buildPrSearchArgs({ owners: ['my-org'], search: 'draft:false' }))
                .toEqual(['draft:false', '--owner', 'my-org']);
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
});
