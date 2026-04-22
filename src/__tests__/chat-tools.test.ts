import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { dispatchChatTool, CHAT_TOOL_DEFINITIONS } from '../core/chat-tools.js';
import { ChatStore } from '../core/chat-store.js';
import type { ChatSession } from '../core/types.js';
import type { SokuzaEngine } from '../core/engine.js';

const silent = pino({ level: 'silent' });

function makeFakeEngine(opts: {
    workflows?: Array<{ name: string; description?: string; template?: string; trigger: any; inputs?: any[] }>;
    runWorkflow?: SokuzaEngine['runWorkflowByName'];
}): SokuzaEngine {
    const workflows = opts.workflows ?? [];
    return {
        getConfig: () => ({ workflows } as any),
        runWorkflowByName: opts.runWorkflow ?? (async () => ({ ok: true, runId: 'r1' })),
    } as unknown as SokuzaEngine;
}

describe('chat-tools', () => {
    let baseDir: string;
    let workdir: string;
    let store: ChatStore;
    let session: ChatSession;

    beforeEach(async () => {
        baseDir = await mkdtemp(join(tmpdir(), 'sokuza-chattools-'));
        workdir = join(baseDir, 'workdir');
        await mkdir(workdir, { recursive: true });
        await writeFile(join(workdir, 'README.md'), '# readme contents\n');
        await writeFile(join(workdir, 'secret.txt'), 'nothing secret but readable');

        store = new ChatStore(silent, baseDir);
        session = await store.createSession({
            scope: { kind: 'pr', repo: 'owner/repo', ref: 'feat/x', prNumber: 7 },
            provider: 'zai-glm',
        });
        // Override workdir to point at our fixture (store defaults the path
        // to `<baseDir>/<id>/workdir` which we don't want to populate
        // with real git for these tests).
        (session as any).workdir = workdir;
    });

    afterEach(async () => {
        await rm(baseDir, { recursive: true, force: true });
    });

    it('exposes the expected tool set', () => {
        const names = CHAT_TOOL_DEFINITIONS.map((t) => t.name).sort();
        expect(names).toEqual([
            'get_diff',
            'get_scope_info',
            'grep',
            'list_files',
            'list_workflows',
            'read_file',
            'run_workflow',
        ]);
    });

    it('get_scope_info returns the session scope as JSON', async () => {
        const engine = makeFakeEngine({});
        const result = await dispatchChatTool('get_scope_info', {}, { session, engine, logger: silent, store });
        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.content);
        expect(parsed.scope.kind).toBe('pr');
        expect(parsed.scope.prNumber).toBe(7);
    });

    it('read_file rejects paths that escape the workdir', async () => {
        const engine = makeFakeEngine({});
        const result = await dispatchChatTool(
            'read_file',
            { path: '../../../../etc/passwd' },
            { session, engine, logger: silent, store },
        );
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/escapes the session workdir/);
    });

    it('read_file rejects absolute paths', async () => {
        const engine = makeFakeEngine({});
        const result = await dispatchChatTool(
            'read_file',
            { path: '/etc/passwd' },
            { session, engine, logger: silent, store },
        );
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/relative/);
    });

    it('read_file returns file contents with a header', async () => {
        const engine = makeFakeEngine({});
        const result = await dispatchChatTool(
            'read_file',
            { path: 'README.md' },
            { session, engine, logger: silent, store },
        );
        expect(result.isError).toBe(false);
        expect(result.content).toMatch(/path: README\.md/);
        expect(result.content).toMatch(/# readme contents/);
    });

    it('list_workflows serializes the workflow config', async () => {
        const engine = makeFakeEngine({
            workflows: [
                {
                    name: 'manual-pr-review',
                    description: 'Review a PR',
                    template: 'ai-pr-review',
                    trigger: { source: 'manual', event: 'manual' },
                    inputs: [{ name: 'pr', type: 'github-pr', required: true, label: 'PR' }],
                },
            ],
        });
        const result = await dispatchChatTool('list_workflows', {}, { session, engine, logger: silent, store });
        expect(result.isError).toBe(false);
        const parsed = JSON.parse(result.content);
        expect(parsed[0].name).toBe('manual-pr-review');
        expect(parsed[0].inputs[0].type).toBe('github-pr');
    });

    it('run_workflow auto-injects the PR selection from PR-scoped sessions', async () => {
        const seen: Array<{ name: string; inputs: Record<string, unknown> }> = [];
        const engine = makeFakeEngine({
            workflows: [{
                name: 'manual-pr-review',
                trigger: { source: 'manual', event: 'manual' },
                inputs: [{ name: 'pr', type: 'github-pr', required: true, label: 'PR' }],
            }],
            runWorkflow: (async (name: string, inputs: Record<string, unknown>) => {
                seen.push({ name, inputs });
                return {
                    ok: true,
                    runId: 'r1',
                    output: {
                        results: { 0: { review: '### ✅ APPROVE\n\nLGTM' } },
                        steps: {},
                    },
                };
            }) as SokuzaEngine['runWorkflowByName'],
        });

        const result = await dispatchChatTool(
            'run_workflow',
            { name: 'manual-pr-review' },
            { session, engine, logger: silent, store },
        );

        expect(result.isError).toBe(false);
        expect(result.content).toContain('LGTM');
        expect(seen).toHaveLength(1);
        expect(seen[0].inputs.pr).toEqual({ number: 7, repo: 'owner/repo' });
    });

    it('run_workflow surfaces workflow errors to the model', async () => {
        const engine = makeFakeEngine({
            workflows: [{ name: 'oops', trigger: { source: 'manual', event: 'manual' } }],
            runWorkflow: (async () => ({ ok: false, error: 'something broke' })) as SokuzaEngine['runWorkflowByName'],
        });
        const result = await dispatchChatTool(
            'run_workflow',
            { name: 'oops' },
            { session, engine, logger: silent, store },
        );
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/something broke/);
    });

    it('run_workflow rejects unknown names before dispatching', async () => {
        const engine = makeFakeEngine({
            workflows: [{ name: 'exists', trigger: { source: 'manual', event: 'manual' } }],
        });
        const result = await dispatchChatTool(
            'run_workflow',
            { name: 'does-not-exist' },
            { session, engine, logger: silent, store },
        );
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/not found/);
    });

    it('unknown tool name returns an error', async () => {
        const engine = makeFakeEngine({});
        const result = await dispatchChatTool('noSuchTool', {}, { session, engine, logger: silent, store });
        expect(result.isError).toBe(true);
        expect(result.content).toMatch(/Unknown tool/);
    });
});
