import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';

// Mock GitHubApiClient.createComment so the test never hits the network
// and we can assert the exact (owner, repo, number) the action passed in.
const { mockCreateComment } = vi.hoisted(() => ({
    mockCreateComment: vi.fn().mockResolvedValue({ id: 42, html_url: 'https://github.com/x/y/issues/1#c42' }),
}));

vi.mock('../api.js', () => ({
    GitHubApiClient: vi.fn().mockImplementation(() => ({
        createComment: mockCreateComment,
    })),
}));

import { githubCommentAction } from './comment.js';

const logger = pino({ level: 'silent' });

function ctx(overrides: Partial<ActionContext['event']> = {}, integrations: Record<string, unknown> = {}): ActionContext {
    return {
        event: {
            source: 'manual',
            event: 'manual',
            timestamp: '2026-05-04T00:00:00Z',
            payload: {},
            metadata: {},
            ...overrides,
        },
        results: {},
        steps: {},
        integrationConfigs: { github: { token: 'gh_test' }, ...integrations },
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        workflowName: 'test',
    } as unknown as ActionContext;
}

// The visual editor's "Post PR/Issue Comment" node has a single
// "Repository" string port that maps directly to `params.repo`. When a
// user wires `data.pr-fields.repo → comment.repo`, the wire value is
// the full "owner/name" string. The old handler treated `params.repo`
// as a bare name only and produced a 404
// (`POST /repos/<owner>/Tjemmmic/meikai/issues/N/comments`); after the
// migration to `_target.ts`, the slash gets split correctly.

describe('githubCommentAction owner/repo resolution', () => {
    beforeEach(() => {
        mockCreateComment.mockClear();
    });

    it('accepts params.repo as "owner/name" (the data.pr-fields.repo output shape)', async () => {
        await githubCommentAction(
            { repo: 'Tjemmmic/meikai', pr_number: 6, body: 'hi' },
            ctx(),
        );
        expect(mockCreateComment).toHaveBeenCalledWith('Tjemmmic', 'meikai', 6, 'hi');
    });

    it('accepts separate params.owner + params.repo_name', async () => {
        await githubCommentAction(
            { owner: 'Tjemmmic', repo_name: 'meikai', pr_number: 6, body: 'hi' },
            ctx(),
        );
        expect(mockCreateComment).toHaveBeenCalledWith('Tjemmmic', 'meikai', 6, 'hi');
    });

    it('falls back to event metadata when params are unwired', async () => {
        await githubCommentAction(
            { body: 'fallback comment' },
            ctx({ metadata: { repo: 'Tjemmmic/meikai', owner: 'Tjemmmic', repoName: 'meikai', prNumber: 6 } }),
        );
        expect(mockCreateComment).toHaveBeenCalledWith('Tjemmmic', 'meikai', 6, 'fallback comment');
    });

    it('accepts issue_number as an alias for the target number', async () => {
        await githubCommentAction(
            { repo: 'Tjemmmic/meikai', issue_number: 12, body: 'on issue' },
            ctx(),
        );
        expect(mockCreateComment).toHaveBeenCalledWith('Tjemmmic', 'meikai', 12, 'on issue');
    });

    it('rejects a malformed params.repo string with a clear error', async () => {
        await expect(
            githubCommentAction({ repo: 'just-a-name', pr_number: 6, body: 'x' }, ctx()),
        ).rejects.toThrow(/params\.repo must be "owner\/name"/);
    });

    it('still requires a body — the contract from the node port', async () => {
        await expect(
            githubCommentAction({ repo: 'a/b', pr_number: 6 }, ctx()),
        ).rejects.toThrow(/requires a "body" param/);
    });

    it('errors when neither params nor event metadata resolve the target', async () => {
        await expect(
            githubCommentAction({ body: 'hi' }, ctx()),
        ).rejects.toThrow(/could not resolve/);
    });

    // Reproduces the user-reported 404 chain: the manual-pr-review
    // recipe wired `trigger.pr` (a full PR object) into `post.pr_number`
    // (which expects a scalar number). Before the coercion guard in
    // `_target.ts`, the action passed the object through and GitHub
    // 404'd on `/issues/[object Object]/comments`. After the guard the
    // PR object is skipped and the metadata-fallback number wins.
    it('falls back to event-metadata prNumber when pr_number is wired as a PR object (bad recipe path)', async () => {
        await githubCommentAction(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { repo: 'Tjemmmic/meikai', pr_number: { number: 6, title: 'fix' } as any, body: 'hi' },
            ctx({ metadata: { prNumber: 6, repo: 'Tjemmmic/meikai', owner: 'Tjemmmic', repoName: 'meikai' } }),
        );
        // The PR object was rejected; metadata.prNumber=6 won.
        expect(mockCreateComment).toHaveBeenCalledWith('Tjemmmic', 'meikai', 6, 'hi');
    });
});
