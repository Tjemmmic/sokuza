import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ActionHandler } from '../../../core/types.js';
import { ghExec } from '../exec.js';
import { WORKFLOW_TEMP_PREFIX } from '../../../core/temp-paths.js';

const DEFAULT_DEPTH = 50;
const DEFAULT_NON_PR_DEPTH = 1;

export const ghCloneRepoAction: ActionHandler = async (params, context) => {
    const repo = (params.repo as string)
        ?? context.event.metadata.repo as string;
    const ref = (params.ref as string)
        ?? (context.event.payload as any)?.pull_request?.head?.ref
        ?? '';
    const prNumber = (context.event.metadata.prNumber as number)
        ?? (context.event.payload as any)?.pull_request?.number;
    const isPrContext = !!prNumber;
    const defaultDepth = isPrContext ? DEFAULT_DEPTH : DEFAULT_NON_PR_DEPTH;
    const depth = (params.depth as number) ?? defaultDepth;

    if (!repo) {
        throw new Error('github-clone-repo: no repo specified and none found in event metadata');
    }

    const tempDir = await mkdtemp(join(tmpdir(), WORKFLOW_TEMP_PREFIX));

    // Determine clone strategy
    if (ref) {
        // We have a branch name — clone directly
        context.logger.info({ repo, ref, depth, path: tempDir }, 'Cloning repository via gh CLI');
        const result = await ghExec(
            ['repo', 'clone', repo, tempDir, '--', '--depth', String(depth), '--branch', ref],
            { timeout: 60_000 },
        );
        if (result.exitCode !== 0) {
            throw new Error(`gh repo clone failed: ${result.stderr.trim()}`);
        }
    } else if (prNumber) {
        // No branch name but we have a PR number — clone then checkout PR
        context.logger.info({ repo, prNumber, path: tempDir }, 'Cloning repository and checking out PR via gh CLI');
        const cloneResult = await ghExec(
            ['repo', 'clone', repo, tempDir, '--', '--depth', '50'],
            { timeout: 60_000 },
        );
        if (cloneResult.exitCode !== 0) {
            throw new Error(`gh repo clone failed: ${cloneResult.stderr.trim()}`);
        }
        // Checkout the PR branch
        const coResult = await ghExec(
            ['pr', 'checkout', String(prNumber), '--force'],
            { cwd: tempDir, timeout: 30_000 },
        );
        if (coResult.exitCode !== 0) {
            throw new Error(`gh pr checkout #${prNumber} failed: ${coResult.stderr.trim()}`);
        }
    } else {
        // No ref, no PR — clone default branch
        context.logger.info({ repo, path: tempDir }, 'Cloning repository (default branch) via gh CLI');
        const result = await ghExec(
            ['repo', 'clone', repo, tempDir, '--', '--depth', String(depth)],
            { timeout: 60_000 },
        );
        if (result.exitCode !== 0) {
            throw new Error(`gh repo clone failed: ${result.stderr.trim()}`);
        }
    }

    // Get HEAD sha
    const sha = await gitRevParse(tempDir);

    // Determine which ref we ended up on
    const actualRef = ref || (await gitCurrentBranch(tempDir)) || 'HEAD';

    context.logger.info(
        { repo, ref: actualRef, sha: sha.slice(0, 8), path: tempDir },
        'Repository cloned',
    );

    return { path: tempDir, repo, ref: actualRef, sha };
};

// ─── Git helpers ────────────────────────────────────────────────────────────

function gitRevParse(cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.on('close', (code) => {
            if (code !== 0) reject(new Error('git rev-parse failed'));
            else resolve(Buffer.concat(chunks).toString().trim());
        });
        child.on('error', reject);
    });
}

function gitCurrentBranch(cwd: string): Promise<string> {
    return new Promise((resolve) => {
        const child = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => chunks.push(c));
        child.on('close', (code) => {
            if (code !== 0) resolve('');
            else resolve(Buffer.concat(chunks).toString().trim());
        });
        child.on('error', () => resolve(''));
    });
}
