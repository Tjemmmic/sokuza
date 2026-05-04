import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { ActionContext } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

const logger = pino({ level: 'silent' });

function ctx(overrides: Partial<ActionContext['event']> = {}, integrationConfigs: Record<string, unknown> = {}): ActionContext {
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
        integrationConfigs,
        ai: { providers: new Map(), defaultProvider: 'test', fallbackChain: [] },
        logger,
        workflowName: 'test',
    } as unknown as ActionContext;
}

describe('resolveRepoTarget — H3 empty-string precedence', () => {
    it('does not let an empty params.owner overshadow event metadata', async () => {
        const result = resolveRepoTarget(
            { owner: '', pr_number: 7 },
            ctx({ metadata: { owner: 'octo', repoName: 'r' } }),
            'test',
        );
        expect(result.owner).toBe('octo');
        expect(result.repo).toBe('r');
    });

    it('does not let an empty params.repo string overshadow event metadata', async () => {
        const result = resolveRepoTarget(
            { repo: '', pr_number: 7 },
            ctx({ metadata: { repo: 'octo/r' } }),
            'test',
        );
        expect(result.owner).toBe('octo');
        expect(result.repo).toBe('r');
    });

    it('does not let params.pr_number=0 overshadow event metadata prNumber', async () => {
        const result = resolveRepoTarget(
            { repo: 'octo/r', pr_number: 0 },
            ctx({ metadata: { prNumber: 99 } }),
            'test',
        );
        expect(result.number).toBe(99);
    });

    it('explicit non-empty params win over event metadata (precedence is preserved)', async () => {
        const result = resolveRepoTarget(
            { repo: 'a/b', pr_number: 7 },
            ctx({ metadata: { repo: 'octo/r', prNumber: 99 } }),
            'test',
        );
        expect(result.owner).toBe('a');
        expect(result.repo).toBe('b');
        expect(result.number).toBe(7);
    });
});

describe('resolveRepoTarget — M5 split validation', () => {
    it('rejects "owner/repo/extra" when no other source provides owner/repo', () => {
        expect(() => resolveRepoTarget(
            { repo: 'octo/r/extra', pr_number: 7 },
            ctx(),
            'test',
        )).toThrow(/params\.repo must be "owner\/name"/);
    });

    it('rejects "octo/" (trailing slash leaves empty repo)', () => {
        expect(() => resolveRepoTarget(
            { repo: 'octo/', pr_number: 7 },
            ctx(),
            'test',
        )).toThrow(/params\.repo must be "owner\/name"/);
    });

    it('rejects bare "octo" (no slash) when nothing else resolves', () => {
        expect(() => resolveRepoTarget(
            { repo: 'octo', pr_number: 7 },
            ctx(),
            'test',
        )).toThrow(/params\.repo must be "owner\/name"/);
    });

    it('still throws the friendly "could not resolve" when nothing is supplied at all', () => {
        expect(() => resolveRepoTarget(
            { pr_number: 7 },
            ctx(),
            'test',
        )).toThrow(/could not resolve owner\/repo/);
    });

    // ── H6: malformed-params.repo must NOT block other sources ─────────────
    it('falls back to params.owner+repo_name when params.repo is malformed (H6)', () => {
        const result = resolveRepoTarget(
            { repo: 'octo/r/extra', owner: 'octo', repo_name: 'r', pr_number: 7 },
            ctx(),
            'test',
        );
        expect(result).toEqual({ owner: 'octo', repo: 'r', number: 7 });
    });

    it('falls back to event metadata when params.repo is malformed (H6)', () => {
        const result = resolveRepoTarget(
            { repo: 'pasted/url/fragment', pr_number: 7 },
            ctx({ metadata: { repo: 'octo/r' } }),
            'test',
        );
        expect(result).toEqual({ owner: 'octo', repo: 'r', number: 7 });
    });

    it('only surfaces the "owner/name" message when no source resolved AND params.repo was malformed', () => {
        // params.repo malformed AND no other source → the malformed message
        // (helps the user understand WHY resolution failed).
        expect(() => resolveRepoTarget(
            { repo: 'pasted/url/fragment', pr_number: 7 },
            ctx(),
            'test',
        )).toThrow(/params\.repo must be "owner\/name"/);
    });
});

describe('requireToken — precedence chain', () => {
    it('prefers params.token over config and env', () => {
        const orig = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'env-token';
        try {
            expect(requireToken(
                { token: 'param-token' },
                ctx({}, { github: { token: 'config-token' } }),
                'test',
            )).toBe('param-token');
        } finally {
            if (orig === undefined) delete process.env.GITHUB_TOKEN;
            else process.env.GITHUB_TOKEN = orig;
        }
    });

    it('falls back to config when params.token is empty', () => {
        const orig = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;
        try {
            expect(requireToken(
                { token: '' },
                ctx({}, { github: { token: 'config-token' } }),
                'test',
            )).toBe('config-token');
        } finally {
            if (orig !== undefined) process.env.GITHUB_TOKEN = orig;
        }
    });

    it('falls back to env when both params and config are missing', () => {
        const orig = process.env.GITHUB_TOKEN;
        process.env.GITHUB_TOKEN = 'env-token';
        try {
            expect(requireToken({}, ctx({}, {}), 'test')).toBe('env-token');
        } finally {
            if (orig === undefined) delete process.env.GITHUB_TOKEN;
            else process.env.GITHUB_TOKEN = orig;
        }
    });

    it('throws when no source has a token', () => {
        const orig = process.env.GITHUB_TOKEN;
        delete process.env.GITHUB_TOKEN;
        try {
            expect(() => requireToken({}, ctx(), 'test')).toThrow(/token is required/);
        } finally {
            if (orig !== undefined) process.env.GITHUB_TOKEN = orig;
        }
    });
});
