import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';

// Mock the API client surface fetch-diff hits. Both
// getPullRequestDiffWithFallback and getPullRequestFiles return enough
// shape for the action's normalization to complete.
const { mockGetDiff, mockGetFiles } = vi.hoisted(() => ({
    mockGetDiff: vi.fn().mockResolvedValue({ diff: '+a\n-b', source: 'bulk', files: [{ filename: 'a.ts' }], incompleteFiles: [] }),
    mockGetFiles: vi.fn().mockResolvedValue([{ filename: 'a.ts' }]),
}));

vi.mock('../api.js', () => ({
    GitHubApiClient: vi.fn().mockImplementation(() => ({
        getPullRequestDiffWithFallback: mockGetDiff,
        getPullRequestFiles: mockGetFiles,
    })),
}));

import { githubFetchDiffAction } from './fetch-diff.js';

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

// The fetch-diff node's "Repository" port produces the same shape as
// every other GitHub action: an "owner/name" string from
// data.pr-fields.repo or trigger.github.repo. Pin that the action
// splits this correctly — otherwise the GitHub API call hits a
// path like /repos/<owner>/owner/name/pulls/N which 404s.

describe('githubFetchDiffAction owner/repo resolution', () => {
    beforeEach(() => {
        mockGetDiff.mockClear();
        mockGetFiles.mockClear();
    });

    it('accepts params.repo as "owner/name" (the data.pr-fields.repo output shape)', async () => {
        await githubFetchDiffAction({ repo: 'Tjemmmic/meikai', pr_number: 6 }, ctx());
        expect(mockGetDiff).toHaveBeenCalledWith('Tjemmmic', 'meikai', 6);
    });

    it('falls back to event metadata when params are unwired', async () => {
        await githubFetchDiffAction(
            {},
            ctx({ metadata: { repo: 'Tjemmmic/meikai', owner: 'Tjemmmic', repoName: 'meikai', prNumber: 6 } }),
        );
        expect(mockGetDiff).toHaveBeenCalledWith('Tjemmmic', 'meikai', 6);
    });

    it('rejects a malformed params.repo with a clear error', async () => {
        await expect(
            githubFetchDiffAction({ repo: 'not-a-slash', pr_number: 6 }, ctx()),
        ).rejects.toThrow(/params\.repo must be "owner\/name"/);
    });

    it('errors when neither params nor event metadata resolve the target', async () => {
        await expect(
            githubFetchDiffAction({}, ctx()),
        ).rejects.toThrow(/could not resolve/);
    });
});
