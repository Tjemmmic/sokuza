import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./exec.js', () => ({
    getGhAuthStatus: vi.fn(),
    ghJson: vi.fn(),
}));

import { GhCliIntegration, buildPrSearchArgs } from './index.js';
import { getGhAuthStatus } from './exec.js';

const mockedGetGhAuthStatus = vi.mocked(getGhAuthStatus);

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
});
