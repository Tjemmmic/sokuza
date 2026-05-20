import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';

const { mockCreateReview } = vi.hoisted(() => ({
    mockCreateReview: vi.fn().mockResolvedValue({ id: 5 }),
}));

vi.mock('../api.js', () => ({
    GitHubApiClient: vi.fn().mockImplementation(() => ({
        createReview: mockCreateReview,
    })),
}));

import { githubCreateReviewAction } from './create-review.js';

const logger = pino({ level: 'silent' });

function ctx(overrides: Partial<ActionContext['event']> = {}): ActionContext {
    return {
        event: {
            source: 'github',
            event: 'pull_request.opened',
            timestamp: '2026-05-04T00:00:00Z',
            payload: {},
            metadata: {},
            ...overrides,
        },
        results: {},
        steps: {},
        integrationConfigs: { github: { token: 'gh_test' } },
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        workflowName: 'test',
    } as unknown as ActionContext;
}

// Parallel coverage to comment.test.ts / fetch-diff.test.ts: the
// "Repository" port on create-review used to read `params.repo` as a
// bare repo name and fall through to event metadata for owner. A graph
// that wired `pr_fields.repo` (= "owner/name") would produce a URL
// like `/repos/<owner>/owner/name/pulls/N/reviews` and 404. The
// migration to `_target.ts` makes the slash-form work.

describe('githubCreateReviewAction owner/repo resolution', () => {
    beforeEach(() => mockCreateReview.mockClear());

    it('accepts params.repo as "owner/name" (the data.pr-fields.repo output shape)', async () => {
        await githubCreateReviewAction(
            { repo: 'octo/r', pr_number: 7, body: 'hi', event: 'comment' },
            ctx(),
        );
        expect(mockCreateReview).toHaveBeenCalledWith(
            'octo', 'r', 7,
            expect.objectContaining({ body: 'hi', event: 'COMMENT' }),
        );
    });

    it('falls back to event metadata when params are unwired', async () => {
        await githubCreateReviewAction(
            { body: 'fallback' },
            ctx({ metadata: { repo: 'octo/r', owner: 'octo', repoName: 'r', prNumber: 7 } }),
        );
        expect(mockCreateReview).toHaveBeenCalledWith(
            'octo', 'r', 7,
            expect.objectContaining({ body: 'fallback' }),
        );
    });

    it('rejects a malformed params.repo with a clear error', async () => {
        await expect(
            githubCreateReviewAction({ repo: 'not-a-slash', pr_number: 7, body: 'x' }, ctx()),
        ).rejects.toThrow(/params\.repo must be "owner\/name"/);
    });
});
